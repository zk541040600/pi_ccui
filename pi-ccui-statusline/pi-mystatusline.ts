import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { renderStatusline, type UsageTotals, type WorkspaceStats } from "./statusline.ts";

type JsonObject = Record<string, unknown>;

type SessionManagerWithIdentity = {
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
};

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  return role === "assistant";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function callStr(fn: (() => unknown) | undefined): string | null {
  try {
    return typeof fn === "function" ? str(fn()) : null;
  } catch {
    return null;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function findTrellisRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".trellis"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function sanitizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || hash(value);
}

function contextKey(event: unknown, ctx: ExtensionContext): string | null {
  const envKey = str(process.env.TRELLIS_CONTEXT_ID);
  if (envKey) return sanitizeKey(envKey);

  const sessionManager = ctx.sessionManager as SessionManagerWithIdentity;
  const sessionId =
    callStr(() => sessionManager.getSessionId?.()) ??
    str(process.env.PI_SESSION_ID) ??
    str(process.env.PI_SESSIONID);
  if (sessionId) return `pi_${sanitizeKey(sessionId)}`;

  const eventObject = event && typeof event === "object" ? (event as JsonObject) : null;
  const eventSession = str(eventObject?.session_id) ?? str(eventObject?.sessionId) ?? str(eventObject?.sessionID);
  if (eventSession) return `pi_${sanitizeKey(eventSession)}`;

  const transcript =
    callStr(() => sessionManager.getSessionFile?.()) ??
    str(eventObject?.transcript_path) ??
    str(eventObject?.transcriptPath) ??
    str(eventObject?.transcript);
  return transcript ? `pi_transcript_${hash(transcript)}` : null;
}

function sessionFile(root: string, key: string): string {
  return join(root, ".trellis", ".runtime", "sessions", `${key}.json`);
}

function sessionHasTask(root: string, key: string): boolean {
  try {
    const data = JSON.parse(readText(sessionFile(root, key))) as JsonObject;
    return !!str(data.current_task);
  } catch {
    return false;
  }
}

function adoptTrellisSessionKey(root: string, key: string | null): string | null {
  if (key && sessionHasTask(root, key)) return key;

  try {
    const dir = join(root, ".trellis", ".runtime", "sessions");
    const keys = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .filter((candidate) => sessionHasTask(root, candidate));
    const processKeys = keys.filter((candidate) => candidate.startsWith("pi_process_"));
    const candidates = processKeys.length > 0 ? processKeys : keys;
    return candidates.length === 1 ? candidates[0]! : key;
  } catch {
    return key;
  }
}

function readTaskDir(root: string, key: string | null): string | null {
  if (!key) return null;

  try {
    const data = JSON.parse(readText(sessionFile(root, key))) as JsonObject;
    let ref = str(data.current_task);
    if (!ref) return null;

    ref = ref.replace(/\\/g, "/").replace(/^\.\//, "");
    if (ref.startsWith("tasks/")) ref = `.trellis/${ref}`;
    if (ref.startsWith(".trellis/")) return join(root, ref);
    if (isAbsolute(ref)) return ref;
    return join(root, ".trellis", "tasks", ref);
  } catch {
    return null;
  }
}

function trellisTaskStatusText(ctx: ExtensionContext, event?: unknown): string {
  const root = findTrellisRoot(ctx.cwd);
  if (!root) return "Trellis: no project";

  const key = adoptTrellisSessionKey(root, contextKey(event, ctx));
  const taskDir = readTaskDir(root, key);
  if (!taskDir) return "Trellis: no task";

  const fallback = basename(taskDir) || "task";
  try {
    const data = JSON.parse(readText(join(taskDir, "task.json"))) as JsonObject;
    const id = str(data.id) ?? fallback;
    const status = str(data.status);
    const text = `Trellis: ${id}${status ? ` (${status})` : ""}`;
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  } catch {
    return `Trellis: ${fallback}`;
  }
}

export default function (pi: ExtensionAPI) {
  let workspace: WorkspaceStats = {
    dirty: false,
    added: 0,
    removed: 0,
  };
  let usageTotals: UsageTotals = {
    input: 0,
    output: 0,
    cost: 0,
  };
  let trellisTaskStatus = "Trellis: no task";
  let agentStartMs: number | null = null;
  let lastTps: number | null = null;
  let requestFooterRender: (() => void) | undefined;
  const footerInstallTimers = new Set<NodeJS.Timeout>();

  const refreshUsageTotals = (ctx: ExtensionContext) => {
    let input = 0;
    let output = 0;
    let cost = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const usage = (entry.message as Partial<AssistantMessage>).usage;
      if (!usage) continue;

      input += usage.input ?? 0;
      output += usage.output ?? 0;
      cost += usage.cost?.total ?? 0;
    }

    usageTotals = { input, output, cost };
  };

  const refreshTrellisTask = (ctx: ExtensionContext, event?: unknown) => {
    trellisTaskStatus = trellisTaskStatusText(ctx, event);
  };

  const refreshWorkspace = async (ctx: ExtensionContext) => {
    const git = (args: string[]) =>
      pi.exec("git", ["-c", "i18n.logOutputEncoding=UTF-8", "-C", ctx.cwd, ...args], {
        signal: ctx.signal,
        timeout: 5000,
      });

    try {
      const rootCheck = await git(["rev-parse", "--is-inside-work-tree"]);
      if (rootCheck.code !== 0 || rootCheck.stdout.trim() !== "true") {
        workspace = { dirty: false, added: 0, removed: 0 };
        return;
      }

      const status = await git(["status", "--porcelain"]);
      if (status.code !== 0) return;

      const unstaged = await git(["diff", "--numstat"]);
      if (unstaged.code !== 0) return;

      const staged = await git(["diff", "--cached", "--numstat"]);
      if (staged.code !== 0) return;

      let added = 0;
      let removed = 0;
      for (const line of `${unstaged.stdout}\n${staged.stdout}`.split("\n")) {
        const [add, del] = line.split("\t");
        if (add && add !== "-") added += Number(add) || 0;
        if (del && del !== "-") removed += Number(del) || 0;
      }

      workspace = {
        dirty: status.stdout.trim().length > 0,
        added,
        removed,
      };
    } catch {
      // Git, timeout, or abort failures should never break the Pi UI.
    }
  };

  const installFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => tui.requestRender();
      requestFooterRender = requestRender;
      const unsubscribeBranch = footerData.onBranchChange(requestRender);

      return {
        dispose() {
          if (requestFooterRender === requestRender) requestFooterRender = undefined;
          unsubscribeBranch();
        },
        invalidate() {},
        render(width: number): string[] {
          return renderStatusline(width, {
            ctx,
            theme,
            footerData,
            getThinkingLevel: () => pi.getThinkingLevel(),
            workspace,
            usageTotals,
            lastTps,
            trellisTaskStatus,
          });
        },
      };
    });
  };

  const scheduleFooterInstall = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    installFooter(ctx);

    // A global compact-footer extension also calls setFooter() on startup and
    // schedules delayed re-installs. Re-apply ccui shortly after those hooks so
    // the project package remains the active footer without mutating global config.
    for (const delayMs of [0, 150, 500]) {
      const timer = setTimeout(() => {
        footerInstallTimers.delete(timer);
        installFooter(ctx);
      }, delayMs);
      footerInstallTimers.add(timer);
    }
  };

  const clearFooterInstallTimers = () => {
    for (const timer of footerInstallTimers) clearTimeout(timer);
    footerInstallTimers.clear();
  };

  pi.on("session_start", async (event, ctx) => {
    refreshTrellisTask(ctx, event);
    refreshUsageTotals(ctx);
    await refreshWorkspace(ctx);
    scheduleFooterInstall(ctx);
  });

  pi.on("resources_discover", async (event, ctx) => {
    refreshTrellisTask(ctx, event);
    scheduleFooterInstall(ctx);
  });

  pi.on("context", (event, ctx) => {
    refreshTrellisTask(ctx, event);
    requestFooterRender?.();
  });

  pi.on("tool_call", (event, ctx) => {
    refreshTrellisTask(ctx, event);
    requestFooterRender?.();
  });

  pi.on("tool_result", (event, ctx) => {
    refreshTrellisTask(ctx, event);
    requestFooterRender?.();
  });

  pi.on("turn_end", async (event, ctx) => {
    refreshTrellisTask(ctx, event);
    refreshUsageTotals(ctx);
    await refreshWorkspace(ctx);
    scheduleFooterInstall(ctx);
    requestFooterRender?.();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    refreshTrellisTask(ctx, event);
    // Pi resets extension UI while rebinding the session for a new prompt. Reinstall
    // here so the built-in footer does not flash back after the user submits input.
    scheduleFooterInstall(ctx);
  });

  pi.on("agent_start", (event, ctx) => {
    refreshTrellisTask(ctx, event);
    agentStartMs = Date.now();
    scheduleFooterInstall(ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    refreshTrellisTask(ctx, event);
    if (agentStartMs === null) return;

    const elapsedMs = Date.now() - agentStartMs;
    agentStartMs = null;
    if (elapsedMs <= 0) return;

    let output = 0;
    for (const message of event.messages) {
      if (!isAssistantMessage(message)) continue;
      output += message.usage?.output ?? 0;
    }

    if (output <= 0) return;

    lastTps = output / (elapsedMs / 1000);
    scheduleFooterInstall(ctx);
    requestFooterRender?.();
  });

  pi.on("model_select", async (event, ctx) => {
    refreshTrellisTask(ctx, event);
    scheduleFooterInstall(ctx);
    requestFooterRender?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    workspace = {
      dirty: false,
      added: 0,
      removed: 0,
    };
    usageTotals = {
      input: 0,
      output: 0,
      cost: 0,
    };
    trellisTaskStatus = "Trellis: no task";
    agentStartMs = null;
    lastTps = null;
    requestFooterRender = undefined;
    clearFooterInstallTimers();

    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined);
    }
  });
}
