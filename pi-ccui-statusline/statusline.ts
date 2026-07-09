import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

export type FooterDataLike = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(listener: () => void): () => void;
};

export type StatuslineThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type WorkspaceStats = {
  dirty: boolean;
  added: number;
  removed: number;
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
  workspace: WorkspaceStats;
  usageTotals: UsageTotals;
  lastTps: number | null;
  trellisTaskStatus: string;
};

const ICONS = {
  context: "",
  branch: "",
  folder: "󰉋",
  warn: "",
  tps: "󰓅",
  diff: "",
};

const MODEL_HEX = "E3A869";
const MODEL_PROVIDER_HEX = "B8A9FF";
const PATH_HEX = "7CB7FF";
const BRANCH_HEX = "91CB91";
const CONTEXT_HEX = "B392F0";
const COST_HEX = "FF78A2";
const TPS_HEX = "6ED7D3";
const DIFF_HEX = "F0C674";
const TRELLIS_HEX = "D7BA7D";
const SEPARATOR_HEX = "3B4048";

const HIDDEN_STATUS_KEYS = new Set([
  "codex-compact",
  "codex-compact-render",
  "codex-compact-fold",
  "fast-context",
  "goal",
  "mcp",
  "pi-ocr",
  "rewind",
  "trellis-status",
]);

const ANSI_PATTERN = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

function charWidth(value: string): number {
  const cp = value.codePointAt(0) ?? 0;
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

function visualWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length;) {
    const ansi = text.slice(i).match(ANSI_PATTERN);
    if (ansi) {
      i += ansi[0].length;
      continue;
    }
    const value = Array.from(text.slice(i))[0] ?? "";
    width += charWidth(value);
    i += value.length || 1;
  }
  return width;
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visualWidth(text) <= maxWidth) return text;

  const limit = Math.max(0, maxWidth - 1);
  let width = 0;
  let output = "";
  for (let i = 0; i < text.length;) {
    const ansi = text.slice(i).match(ANSI_PATTERN);
    if (ansi) {
      output += ansi[0];
      i += ansi[0].length;
      continue;
    }
    const value = Array.from(text.slice(i))[0] ?? "";
    const nextWidth = width + charWidth(value);
    if (nextWidth > limit) break;
    output += value;
    width = nextWidth;
    i += value.length || 1;
  }
  return `${output}…\x1b[0m`;
}

type ModelStyle = {
  icon: string;
  colorHex: string;
  fallback: string;
  label: string;
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

function getModelLabel(modelId: string | undefined): string {
  return modelId ?? "no-model";
}

function getModelStyle(modelId: string | undefined): ModelStyle {
  const label = getModelLabel(modelId);
  return { icon: "", colorHex: MODEL_HEX, fallback: "accent", label };
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

function colorHex(theme: StatuslineThemeLike, hex: string, text: string, fallback: string): string {
  if (!supportsTruecolor()) return theme.fg(fallback, text);

  const [r, g, b] = hexToRgb(hex);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

function medium(theme: StatuslineThemeLike, text: string): string {
  return theme.bold(text);
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderTrellisTask(theme: StatuslineThemeLike, text: string): string {
  const fallback = text === "Trellis: no task" || text === "Trellis: no project" ? "dim" : "warning";
  return colorHex(theme, TRELLIS_HEX, medium(theme, text), fallback);
}

function renderWorkspace(theme: StatuslineThemeLike, workspace: WorkspaceStats): string | undefined {
  if (!workspace.dirty) return undefined;

  const chunks: string[] = [];
  if (workspace.added > 0) chunks.push(theme.fg("success", `+${workspace.added}`));
  if (workspace.removed > 0) chunks.push(theme.fg("error", `-${workspace.removed}`));
  if (chunks.length === 0) chunks.push(theme.fg("warning", "dirty"));

  return `${colorHex(theme, DIFF_HEX, medium(theme, ICONS.diff), "warning")} ${chunks.join(" ")}`;
}

function renderLine1(input: StatuslineRenderContext): string {
  const { ctx, theme, footerData, getThinkingLevel } = input;
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const tokens = usage?.tokens ?? null;
  const percent = usage?.percent ?? null;
  const usageColor = getUsageColor(percent);
  const percentLabel = percent === null ? "?" : `${percent.toFixed(1)}%`;
  const tokenLabel = tokens === null ? "?" : formatCompactTokens(tokens);
  const windowLabel = contextWindow > 0 ? formatCompactTokens(contextWindow) : "?";
  const modelStyle = getModelStyle(ctx.model?.id);
  const totalInput = input.usageTotals.input;
  const totalOutput = input.usageTotals.output;
  const totalCost = input.usageTotals.cost;
  const tpsLabel = formatTps(input.lastTps);
  const branch = footerData.getGitBranch();
  const cwdName = basename(ctx.cwd) || ctx.cwd;
  const cwdLabel = `${colorHex(theme, PATH_HEX, medium(theme, ICONS.folder), "accent")} ${colorHex(theme, PATH_HEX, medium(theme, cwdName), "accent")}`;
  const branchLabel = branch
    ? `${colorHex(theme, BRANCH_HEX, medium(theme, ICONS.branch), "success")} ${colorHex(theme, BRANCH_HEX, medium(theme, branch), "success")}`
    : undefined;
  const statuses = [...footerData.getExtensionStatuses().entries()]
    .filter(([, status]) => Boolean(status))
    .filter(([key, status]) => {
      const normalized = stripAnsi(status).trim();
      const lowerStatus = normalized.toLowerCase();
      if (HIDDEN_STATUS_KEYS.has(key) || key.startsWith("codex-compact")) return false;
      if (normalized.startsWith("MCP:")) return false;
      if (normalized === "Ready" || normalized === "Working") return false;
      if (lowerStatus.startsWith("codex compact:")) return false;
      if (lowerStatus.startsWith("ocr:")) return false;
      if (lowerStatus.startsWith("trellis:")) return false;
      if (/^[◆◇]\s+\d+ checkpoints$/u.test(normalized)) return false;
      return true;
    })
    .map(([, status]) => status);
  const statusText = statuses.length > 0 ? statuses.join(" ") : undefined;
  const thinkingLevel = getThinkingLevel();
  const providerLabel = typeof ctx.model?.provider === "string" && ctx.model.provider.trim() ? ctx.model.provider.trim() : undefined;
  const providerPrefix = providerLabel ? colorHex(theme, MODEL_PROVIDER_HEX, `${providerLabel}/`, "dim") : "";
  const modelCore = colorHex(theme, modelStyle.colorHex, `${modelStyle.label}(${thinkingLevel})`, modelStyle.fallback);
  const modelWithThinking = medium(theme, `${providerPrefix}${modelCore}`);

  return joinParts(theme, [
    `${colorHex(theme, modelStyle.colorHex, medium(theme, modelStyle.icon), modelStyle.fallback)} ${modelWithThinking}`,
    cwdLabel,
    branchLabel,
    `${colorHex(theme, CONTEXT_HEX, medium(theme, ICONS.context), "accent")} ${colorHex(theme, CONTEXT_HEX, medium(theme, percentLabel), usageColor)}${(percent ?? 0) >= 90 ? ` ${theme.fg("error", medium(theme, ICONS.warn))}` : ""} ${colorHex(theme, CONTEXT_HEX, `(${tokenLabel}/${windowLabel})`, "dim")}`,
    medium(
      theme,
      colorHex(
        theme,
        COST_HEX,
        `↑${formatCompactTokens(totalInput)} ↓${formatCompactTokens(totalOutput)} $${totalCost.toFixed(2)}`,
        totalCost > 0 || totalInput > 0 || totalOutput > 0 ? "warning" : "dim",
      ),
    ),
    colorHex(theme, TPS_HEX, medium(theme, `${ICONS.tps} ${tpsLabel}`), "accent"),
    renderWorkspace(theme, input.workspace),
    renderTrellisTask(theme, input.trellisTaskStatus),
    statusText,
  ]);
}

export function renderStatusline(width: number, input: StatuslineRenderContext): string[] {
  return [truncateToWidth(renderLine1(input), width)];
}
