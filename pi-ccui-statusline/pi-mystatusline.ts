import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installStatusline, type RegistrationLease } from "./extension-registration.ts";
import { renderStatusline, type UsageTotals } from "./statusline.ts";

type SessionManagerWithBranch = {
  getBranch?: () => unknown;
};

type BranchEntryLike = {
  type?: unknown;
  message?: unknown;
};

const MAX_SESSION_BRANCH_ENTRIES = 50_000;
const MAX_AGENT_MESSAGES = 10_000;

/** Snapshot an untrusted Array without invoking its iterator or unbounded length. */
function safeArraySnapshot<T>(value: unknown, maxEntries: number): T[] {
  try {
    if (!Array.isArray(value)) return [];
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxEntries) return [];

    const snapshot: T[] = [];
    for (let index = 0; index < length; index += 1) {
      try {
        snapshot.push(value[index] as T);
      } catch {
        // Ignore a malformed element getter while keeping the remaining entries.
      }
    }
    return snapshot;
  } catch {
    return [];
  }
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  return role === "assistant";
}

function isStaleExtensionContextError(error: unknown): boolean {
  try {
    if (!(error instanceof Error)) return false;
    const message = error.message;
    return typeof message === "string"
      && /(?:Extension context no longer active|This extension ctx is stale|ctx is stale|context.*stale)/i.test(message);
  } catch {
    return false;
  }
}

function warnUiFailure(label: string, error: unknown): void {
  if (isStaleExtensionContextError(error)) return;
  let category = "unknown error";
  try {
    const name = error instanceof Error ? error.name : undefined;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name)) category = name;
  } catch {
    // Keep the redacted fallback when error metadata is itself hostile.
  }
  try {
    console.warn(`pi-ccui-statusline UI ${label} failed (${category})`);
  } catch {
    // Diagnostics must never escape into the Pi lifecycle.
  }
}

function safeRequestRender(tui: { requestRender?: () => void }, label = "requestRender"): void {
  try {
    tui.requestRender?.();
  } catch (error) {
    warnUiFailure(label, error);
  }
}

function safeHasUI(ctx: ExtensionContext): boolean {
  try {
    return ctx.hasUI === true && (ctx as { mode?: string }).mode === "tui";
  } catch (error) {
    warnUiFailure("hasUI", error);
    return false;
  }
}

function safeSetFooter(ctx: ExtensionContext, footer: Parameters<ExtensionContext["ui"]["setFooter"]>[0]): void {
  try {
    if (!safeHasUI(ctx)) return;
    ctx.ui.setFooter(footer);
  } catch (error) {
    warnUiFailure("setFooter", error);
  }
}

function safeUnsubscribe(unsubscribe: (() => void) | undefined, label: string): void {
  try {
    unsubscribe?.();
  } catch (error) {
    warnUiFailure(label, error);
  }
}

function readSessionBranch(ctx: ExtensionContext): BranchEntryLike[] {
  try {
    const branch = (ctx.sessionManager as SessionManagerWithBranch | undefined)?.getBranch?.();
    return safeArraySnapshot<BranchEntryLike>(branch, MAX_SESSION_BRANCH_ENTRIES);
  } catch {
    return [];
  }
}

function eventMessages(event: unknown): unknown[] {
  try {
    if (!event || typeof event !== "object") return [];
    const messages = (event as { messages?: unknown }).messages;
    return safeArraySnapshot(messages, MAX_AGENT_MESSAGES);
  } catch {
    return [];
  }
}

function buildRegistrationSteps(
  pi: ExtensionAPI,
  lease: RegistrationLease,
): Array<() => unknown> {
  type RuntimeState = {
    usageTotals: UsageTotals;
    agentStartMs: number | null;
    lastTps: number | null;
    requestFooterRender: (() => void) | undefined;
  };

  const state: RuntimeState = {
    usageTotals: { input: 0, output: 0, cost: 0 },
    agentStartMs: null,
    lastTps: null,
    requestFooterRender: undefined,
  };

  const refreshUsageTotals = (ctx: ExtensionContext) => {
    let input = 0;
    let output = 0;
    let cost = 0;

    for (const entry of readSessionBranch(ctx)) {
      try {
        if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
        const message = entry.message as Partial<AssistantMessage> & { role?: unknown };
        if (message.role !== "assistant") continue;
        const usage = message.usage;
        if (!usage) continue;

        if (typeof usage.input === "number" && Number.isFinite(usage.input)) input += Math.max(0, usage.input);
        if (typeof usage.output === "number" && Number.isFinite(usage.output)) output += Math.max(0, usage.output);
        if (typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total)) cost += Math.max(0, usage.cost.total);
      } catch {
        // Ignore malformed historical entries while preserving the remaining totals.
      }
    }

    state.usageTotals = { input, output, cost };
  };

  const installFooter = (ctx: ExtensionContext) => {
    if (!safeHasUI(ctx)) return;

    safeSetFooter(ctx, (tui, theme, footerData) => {
      const requestRender = () => safeRequestRender(tui, "footer requestRender");
      state.requestFooterRender = requestRender;
      let unsubscribeBranch: (() => void) | undefined;
      try {
        unsubscribeBranch = footerData.onBranchChange(requestRender);
      } catch (error) {
        warnUiFailure("onBranchChange", error);
      }

      return {
        dispose() {
          if (state.requestFooterRender === requestRender) state.requestFooterRender = undefined;
          safeUnsubscribe(unsubscribeBranch, "branch unsubscribe");
        },
        invalidate() {},
        render(width: number): string[] {
          try {
            return renderStatusline(width, {
              ctx,
              theme,
              footerData,
              getThinkingLevel: () => pi.getThinkingLevel(),
              usageTotals: state.usageTotals,
              lastTps: state.lastTps,
            });
          } catch (error) {
            warnUiFailure("footer render", error);
            return [];
          }
        },
      };
    });
  };

  const cleanupRuntimeState = () => {
    state.usageTotals = { input: 0, output: 0, cost: 0 };
    state.agentStartMs = null;
    state.lastTps = null;
    state.requestFooterRender = undefined;
  };

  return [
    () => pi.on("session_start", lease.guard((_event, ctx) => {
      if (!safeHasUI(ctx)) return;
      refreshUsageTotals(ctx);
      installFooter(ctx);
    })),
    () => pi.on("resources_discover", lease.guard((_event, ctx) => {
      installFooter(ctx);
    })),
    () => pi.on("context", lease.guard(() => {
      state.requestFooterRender?.();
    })),
    () => pi.on("tool_call", lease.guard(() => {
      state.requestFooterRender?.();
    })),
    () => pi.on("tool_result", lease.guard(() => {
      state.requestFooterRender?.();
    })),
    () => pi.on("turn_end", lease.guard((_event, ctx) => {
      if (!safeHasUI(ctx)) return;
      refreshUsageTotals(ctx);
      state.requestFooterRender?.();
    })),
    () => pi.on("before_agent_start", lease.guard(() => {
      state.requestFooterRender?.();
    })),
    () => pi.on("agent_start", lease.guard(() => {
      if (!state.requestFooterRender) return;
      state.agentStartMs = Date.now();
      state.requestFooterRender?.();
    })),
    () => pi.on("agent_end", lease.guard((event) => {
      if (state.agentStartMs === null) return;

      const elapsedMs = Date.now() - state.agentStartMs;
      state.agentStartMs = null;
      if (elapsedMs <= 0) return;

      let output = 0;
      for (const message of eventMessages(event)) {
        try {
          if (!isAssistantMessage(message)) continue;
          const value = message.usage?.output;
          if (typeof value === "number" && Number.isFinite(value) && value > 0) output += value;
        } catch {
          // Ignore malformed message getters without breaking the Pi lifecycle.
        }
      }
      if (output <= 0) return;

      state.lastTps = output / (elapsedMs / 1000);
      state.requestFooterRender?.();
    })),
    () => pi.on("model_select", lease.guard(() => {
      state.requestFooterRender?.();
    })),
    () => pi.on("session_shutdown", lease.guard(() => cleanupRuntimeState())),
  ];
}

export default function registerStatusline(pi: ExtensionAPI): void {
  installStatusline(pi, (lease) => buildRegistrationSteps(pi, lease));
}
