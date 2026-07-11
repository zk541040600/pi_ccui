import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

export type FooterDataLike = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(listener: () => void): () => void;
};

export type StatuslineThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UsageTotals = {
  input: number;
  output: number;
  cost: number;
};

export type StatuslineRenderContext = {
  ctx: ExtensionContext;
  footerData: FooterDataLike;
  theme: StatuslineThemeLike;
  getThinkingLevel(): string;
  usageTotals: UsageTotals;
  lastTps: number | null;
};

const ICONS = {
  context: "",
  branch: "",
  folder: "󰉋",
  warn: "",
  tps: "󰓅",
};

const MODEL_HEX = "E3A869";
const MODEL_PROVIDER_HEX = "B8A9FF";
const PATH_HEX = "7CB7FF";
const BRANCH_HEX = "91CB91";
const CONTEXT_HEX = "B392F0";
const COST_HEX = "FF78A2";
const TPS_HEX = "6ED7D3";
const TRELLIS_HEX = "D7BA7D";
const SEPARATOR_HEX = "3B4048";
const MAX_RENDER_WIDTH = 4096;
const MAX_STATUS_SNAPSHOT_COUNT = 64;
const MAX_VISIBLE_STATUS_COUNT = 16;
const MAX_STATUS_LENGTH = 256;
const MAX_LABEL_LENGTH = 160;
const RAW_TEXT_EXPANSION_LIMIT = 8;
const TERMINAL_CONTROL_STRING_PATTERN = /(?:(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)|(?:\x1b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|$))/gu;
const TERMINAL_CSI_PATTERN = /(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;

const HIDDEN_STATUS_KEYS = new Set([
  "codex-compact",
  "codex-compact-render",
  "codex-compact-fold",
  "fast-context",
  "goal",
  "cache-heartbeat",
  "gpt-us-ip-check",
  "mcp",
  "pi-ocr",
  "rewind",
  "trellis-status",
]);

type ModelStyle = {
  icon: string;
  colorHex: string;
  fallback: string;
  label: string;
};

type StatusEntrySnapshot = {
  key: string;
  status: string;
  isTrellisProvider: boolean;
};

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function formatTps(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "0.0 tps";
  return `${value.toFixed(1)} tps`;
}

function getModelStyle(modelId: string | undefined): ModelStyle {
  return { icon: "", colorHex: MODEL_HEX, fallback: "accent", label: modelId ?? "no-model" };
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace(/^#/, "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return [r, g, b];
}

function supportsTruecolor(): boolean {
  const colorterm = process.env.COLORTERM?.toLowerCase();
  return colorterm === "truecolor" || colorterm === "24bit";
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Convert one external label to bounded single-line terminal-safe text. */
function terminalText(value: unknown, maxLength = MAX_LABEL_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const rawLimit = Math.max(maxLength, maxLength * RAW_TEXT_EXPANSION_LIMIT);
  const raw = value.slice(0, rawLimit)
    .replace(TERMINAL_CONTROL_STRING_PATTERN, "")
    .replace(TERMINAL_CSI_PATTERN, "");
  const normalized = stripVTControlCharacters(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:\p{Mark}|\p{Default_Ignorable_Code_Point}|\p{Emoji_Modifier})+/gu, "");
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, maxLength).join("");
}

function canonicalFilterText(value: string): string {
  return value.replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase();
}

function safeThemeFg(theme: StatuslineThemeLike, color: string, text: string): string {
  return safeCall(() => theme.fg(color, text), text);
}

function safeThemeBold(theme: StatuslineThemeLike, text: string): string {
  return safeCall(() => theme.bold(text), text);
}

function safeContextUsage(ctx: ExtensionContext): { contextWindow: number; tokens: number | null; percent: number | null } | null {
  return safeCall(() => {
    const usage = (ctx as ExtensionContext & { getContextUsage?: () => unknown }).getContextUsage?.();
    if (!usage || typeof usage !== "object") return null;
    const raw = usage as { contextWindow?: unknown; tokens?: unknown; percent?: unknown };
    const tokens = typeof raw.tokens === "number" && Number.isFinite(raw.tokens) ? Math.max(0, raw.tokens) : null;
    const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent)
      ? Math.min(100, Math.max(0, raw.percent))
      : null;
    return {
      contextWindow: finiteNonNegative(raw.contextWindow),
      tokens,
      percent,
    };
  }, null);
}

function safeModelSnapshot(ctx: ExtensionContext): { id?: string; provider?: string; contextWindow: number } {
  return safeCall(() => {
    const model = (ctx as ExtensionContext & { model?: unknown }).model;
    if (!model || typeof model !== "object") return { contextWindow: 0 };
    const raw = model as { id?: unknown; provider?: unknown; contextWindow?: unknown };
    return {
      id: terminalText(raw.id),
      provider: terminalText(raw.provider),
      contextWindow: finiteNonNegative(raw.contextWindow),
    };
  }, { contextWindow: 0 });
}

function safeStatusEntries(footerData: FooterDataLike): StatusEntrySnapshot[] {
  return safeCall(() => {
    const source = footerData.getExtensionStatuses() as unknown as { entries?: () => Iterable<unknown> };
    if (!source || typeof source.entries !== "function") return [];

    const entries: StatusEntrySnapshot[] = [];
    const iterator = source.entries()[Symbol.iterator]();
    let exhausted = false;
    try {
      for (let inspected = 0; inspected < MAX_STATUS_SNAPSHOT_COUNT; inspected += 1) {
        const next = iterator.next();
        if (next.done) {
          exhausted = true;
          break;
        }
        const entry = next.value;
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const rawKey = entry[0];
        const key = terminalText(rawKey, MAX_LABEL_LENGTH);
        const status = terminalText(entry[1], MAX_STATUS_LENGTH);
        if (key && status) entries.push({ key, status, isTrellisProvider: rawKey === "trellis-status" });
      }
    } finally {
      if (!exhausted && typeof iterator.return === "function") iterator.return();
    }
    return entries;
  }, []);
}

function colorHex(theme: StatuslineThemeLike, hex: string, text: string, fallback: string): string {
  if (!supportsTruecolor()) return safeThemeFg(theme, fallback, text);

  const [r, g, b] = hexToRgb(hex);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

function medium(theme: StatuslineThemeLike, text: string): string {
  return safeThemeBold(theme, text);
}

function getUsageColor(percent: number | null): string {
  const safePercent = percent ?? 0;
  if (safePercent >= 90) return "error";
  if (safePercent >= 70) return "warning";
  return "success";
}

function joinParts(theme: StatuslineThemeLike, parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(colorHex(theme, SEPARATOR_HEX, " | ", "dim"));
}

function renderTrellisTask(theme: StatuslineThemeLike, text: string): string {
  const fallback = text === "Trellis: no task" || text === "Trellis: no project" ? "dim" : "warning";
  return colorHex(theme, TRELLIS_HEX, medium(theme, text), fallback);
}

function renderLine1(input: StatuslineRenderContext): string {
  const { ctx, theme, footerData, getThinkingLevel } = input;
  const usage = safeContextUsage(ctx);
  const model = safeModelSnapshot(ctx);
  const contextWindow = usage?.contextWindow || model.contextWindow;
  const tokens = usage?.tokens ?? null;
  const percent = usage?.percent ?? null;
  const usageColor = getUsageColor(percent);
  const percentLabel = percent === null ? "?" : `${percent.toFixed(1)}%`;
  const tokenLabel = tokens === null ? "?" : formatCompactTokens(tokens);
  const windowLabel = contextWindow > 0 ? formatCompactTokens(contextWindow) : "?";
  const modelStyle = getModelStyle(model.id);
  const usageTotals = safeCall(() => ({
    input: finiteNonNegative(input.usageTotals.input),
    output: finiteNonNegative(input.usageTotals.output),
    cost: finiteNonNegative(input.usageTotals.cost),
  }), { input: 0, output: 0, cost: 0 });
  const tpsLabel = formatTps(safeCall(() => input.lastTps, null));
  const branch = safeCall<string | undefined>(() => terminalText(footerData.getGitBranch()), undefined);
  const cwdName = safeCall(() => {
    const value = (ctx as { cwd?: unknown }).cwd;
    if (typeof value !== "string" || !value) return "unknown";
    return terminalText(basename(value) || value) ?? "unknown";
  }, "unknown");
  const cwdIcon = colorHex(theme, PATH_HEX, medium(theme, ICONS.folder), "accent");
  const cwdLabel = `${cwdIcon} ${colorHex(theme, PATH_HEX, medium(theme, cwdName), "accent")}`;
  const branchLabel = branch
    ? `${colorHex(theme, BRANCH_HEX, medium(theme, ICONS.branch), "success")} ${colorHex(
        theme,
        BRANCH_HEX,
        medium(theme, branch),
        "success",
      )}`
    : undefined;
  const statusEntries = safeStatusEntries(footerData);
  const trellisTaskStatus = statusEntries.find(
    ({ isTrellisProvider }) => isTrellisProvider,
  )?.status;
  const statuses = statusEntries
    .filter(({ key, status }) => {
      const lowerKey = canonicalFilterText(key);
      const lowerStatus = canonicalFilterText(status);
      if (HIDDEN_STATUS_KEYS.has(lowerKey) || lowerKey.startsWith("codex-compact")) return false;
      if (lowerStatus.startsWith("mcp:")) return false;
      if (lowerStatus === "ready" || lowerStatus === "working") return false;
      if (lowerStatus.startsWith("codex compact:")) return false;
      if (lowerStatus.startsWith("cache:")) return false;
      if (lowerStatus.startsWith("gpt ip:")) return false;
      if (lowerStatus.startsWith("ocr:")) return false;
      if (lowerStatus.startsWith("trellis:")) return false;
      if (/^[◆◇]\s+\d+ checkpoints$/u.test(lowerStatus)) return false;
      return true;
    })
    .slice(0, MAX_VISIBLE_STATUS_COUNT)
    .map(({ status }) => status);
  const statusText = statuses.length > 0 ? statuses.join(" ") : undefined;
  const thinkingLevel = safeCall(() => terminalText(getThinkingLevel(), 32), undefined) ?? "default";
  const providerLabel = model.provider;
  const providerPrefix = providerLabel ? colorHex(theme, MODEL_PROVIDER_HEX, `${providerLabel}/`, "dim") : "";
  const modelCore = colorHex(theme, modelStyle.colorHex, `${modelStyle.label}(${thinkingLevel})`, modelStyle.fallback);
  const modelWithThinking = medium(theme, `${providerPrefix}${modelCore}`);
  const modelIcon = colorHex(theme, modelStyle.colorHex, medium(theme, modelStyle.icon), modelStyle.fallback);
  const modelLabel = `${modelIcon} ${modelWithThinking}`;
  const contextWarning = (percent ?? 0) >= 90
    ? ` ${safeThemeFg(theme, "error", medium(theme, ICONS.warn))}`
    : "";
  const contextLabel = [
    colorHex(theme, CONTEXT_HEX, medium(theme, ICONS.context), "accent"),
    `${colorHex(theme, CONTEXT_HEX, medium(theme, percentLabel), usageColor)}${contextWarning}`,
    colorHex(theme, CONTEXT_HEX, `(${tokenLabel}/${windowLabel})`, "dim"),
  ].join(" ");
  const hasUsageTotals = usageTotals.cost > 0 || usageTotals.input > 0 || usageTotals.output > 0;
  const costText = `↑${formatCompactTokens(usageTotals.input)} ↓${formatCompactTokens(usageTotals.output)} $${usageTotals.cost.toFixed(2)}`;
  const costLabel = medium(theme, colorHex(theme, COST_HEX, costText, hasUsageTotals ? "warning" : "dim"));
  const tpsText = `${ICONS.tps} ${tpsLabel}`;

  return joinParts(theme, [
    modelLabel,
    cwdLabel,
    branchLabel,
    contextLabel,
    costLabel,
    colorHex(theme, TPS_HEX, medium(theme, tpsText), "accent"),
    trellisTaskStatus ? renderTrellisTask(theme, trellisTaskStatus) : undefined,
    statusText,
  ]);
}

export function renderStatusline(width: number, input: StatuslineRenderContext): string[] {
  if (!Number.isFinite(width) || width <= 0) return [""];
  const boundedWidth = Math.min(MAX_RENDER_WIDTH, Math.floor(width));
  if (boundedWidth <= 0) return [""];
  return [truncateToWidth(renderLine1(input), boundedWidth, "…", true)];
}
