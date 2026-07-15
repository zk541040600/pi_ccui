import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";

import registerStatusline from "./pi-mystatusline.ts";
import { renderStatusline } from "./statusline.ts";

const EVENT_NAMES = [
  "session_start",
  "resources_discover",
  "context",
  "tool_call",
  "tool_result",
  "turn_end",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "model_select",
  "session_shutdown",
];

function createPi({ failOnCall = null } = {}) {
  const handlers = new Map();
  let onCalls = 0;
  const pi = {
    on(event, handler) {
      onCalls += 1;
      if (onCalls === failOnCall) throw new Error("injected registration failure");
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getThinkingLevel: () => "off",
  };

  return {
    handlers,
    pi,
    handlerCount(event) {
      return handlers.get(event)?.length ?? 0;
    },
    async emit(event, payload, ctx) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
  };
}

function createContext(cwd, ui) {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
    ui,
  };
}

async function testSetFooterFailure() {
  const temp = mkdtempSync(join(tmpdir(), "pi-ccui-statusline-smoke-"));
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    const { pi, emit } = createPi();
    registerStatusline(pi);
    const ctx = createContext(temp, {
      setFooter() {
        throw new Error("Extension context no longer active");
      },
    });

    await assert.doesNotReject(() => emit("session_start", {}, ctx));
    const hostileError = new Proxy(new Error("must stay private"), {
      get() {
        throw new Error("error metadata unavailable");
      },
    });
    const hostileCtx = createContext(temp, {
      setFooter() {
        throw hostileError;
      },
    });
    await assert.doesNotReject(() => emit("session_start", {}, hostileCtx));
    await assert.doesNotReject(() => emit("session_shutdown", {}, ctx));
    assert.deepEqual(warnings, ["pi-ccui-statusline UI setFooter failed (unknown error)"]);
  } finally {
    console.warn = realWarn;
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testFooterRenderFailure() {
  const temp = mkdtempSync(join(tmpdir(), "pi-ccui-statusline-smoke-"));
  try {
    const { pi, emit } = createPi();
    registerStatusline(pi);

    let branchRender;
    let component;
    let unsubscribeCalls = 0;
    const ctx = createContext(temp, {
      setFooter(factory) {
        if (typeof factory !== "function") return;
        component = factory(
          { requestRender() { throw new Error("Extension context no longer active"); } },
          { fg: (_style, text) => text, bold: (text) => text },
          {
            onBranchChange(callback) {
              branchRender = callback;
              return () => {
                unsubscribeCalls += 1;
                throw new Error("Extension context no longer active");
              };
            },
          },
        );
      },
    });

    await emit("session_start", {}, ctx);
    assert.equal(typeof branchRender, "function", "TUI smoke must execute the footer factory");
    assert.equal(typeof component?.dispose, "function", "TUI smoke must install a disposable component");
    assert.doesNotThrow(() => branchRender());
    assert.doesNotThrow(() => component.dispose());
    assert.equal(unsubscribeCalls, 1, "dispose must attempt to unsubscribe exactly once");
    await emit("session_shutdown", {}, ctx);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testMissingCwdAndBrokenSessionBranch() {
  const { pi, emit } = createPi();
  registerStatusline(pi);
  let branchMode = "throw";

  const ctx = createContext(undefined, {
    setFooter() {},
  });
  ctx.sessionManager = {
    getBranch() {
      if (branchMode === "throw") throw new Error("branch unavailable");
      return new Proxy([], {
        get(target, key, receiver) {
          if (key === Symbol.iterator) throw new Error("branch iterator unavailable");
          return Reflect.get(target, key, receiver);
        },
      });
    },
    getSessionId: () => "smoke-session",
    getSessionFile: () => undefined,
  };

  await assert.doesNotReject(() => emit("session_start", {}, ctx));
  branchMode = "iterator";
  await assert.doesNotReject(() => emit("turn_end", { messages: [] }, ctx));
  await assert.doesNotReject(() => emit("session_shutdown", {}, ctx));
}

async function testMalformedAgentEndEvent() {
  const temp = mkdtempSync(join(tmpdir(), "pi-ccui-statusline-smoke-"));
  try {
    const { pi, emit } = createPi();
    registerStatusline(pi);
    const ctx = createContext(temp, {
      setFooter(factory) {
        if (typeof factory !== "function") return;
        factory(
          { requestRender() {} },
          { fg: (_style, text) => text, bold: (text) => text },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            onBranchChange: () => () => {},
          },
        );
      },
    });

    await emit("session_start", {}, ctx);
    await emit("agent_start", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await assert.doesNotReject(() => emit("agent_end", {}, ctx));
    await emit("agent_start", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await assert.doesNotReject(() => emit("agent_end", { messages: null }, ctx));
    await emit("agent_start", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const throwingMessage = new Proxy({}, {
      get() {
        throw new Error("message getter unavailable");
      },
    });
    await assert.doesNotReject(() => emit("agent_end", { messages: [throwingMessage] }, ctx));
    await emit("agent_start", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const throwingMessages = new Proxy([], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) throw new Error("messages iterator unavailable");
        return Reflect.get(target, key, receiver);
      },
    });
    await assert.doesNotReject(() => emit("agent_end", { messages: throwingMessages }, ctx));
    await emit("session_shutdown", {}, ctx);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testUsageAndThroughputAggregation() {
  const { pi, emit } = createPi();
  let component;
  let renderRequests = 0;
  const ctx = createContext("/tmp/usage-tps", {
    setFooter(factory) {
      if (typeof factory !== "function") return;
      component = factory(
        { requestRender() { renderRequests += 1; } },
        { fg: (_style, text) => text, bold: (text) => text },
        {
          getGitBranch: () => "main",
          getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => {},
        },
      );
    },
  });
  ctx.sessionManager.getBranch = () => [{
    type: "message",
    message: {
      role: "assistant",
      usage: { input: 12, output: 8, cost: { total: 1.25 } },
    },
  }];

  registerStatusline(pi);
  await emit("session_start", {}, ctx);
  const usageLine = component.render(320)[0];
  assert(usageLine.includes("↑12 ↓8 $1.25"), "session branch usage must reach the rendered footer");
  assert(usageLine.includes("0.0 tps"), "throughput must start from its explicit empty value");

  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const requestsBeforeAgent = renderRequests;
    await emit("agent_start", {}, ctx);
    assert(renderRequests > requestsBeforeAgent, "agent start must request a footer render");
    const requestsAfterStart = renderRequests;
    now = 2_000;
    await emit("agent_end", {
      messages: [{ role: "assistant", usage: { output: 25 } }],
    }, ctx);
    assert(renderRequests > requestsAfterStart, "throughput updates must request a footer render");
    assert(component.render(320)[0].includes("25.0 tps"), "assistant output and elapsed time must produce throughput");
  } finally {
    Date.now = realNow;
  }

  component.dispose();
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
}

function testHidesCacheHeartbeatStatus() {
  const lines = renderStatusline(240, {
    ctx: {
      cwd: "/tmp/example",
      model: { id: "model", contextWindow: 1000 },
      getContextUsage() {
        return { contextWindow: 1000, tokens: 100, percent: 10 };
      },
    },
    footerData: {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return new Map([
          ["cache-heartbeat", "cache:observe unknown provider/model"],
          ["gpt-us-ip-check", "GPT IP: US"],
          ["checkpoint-lookalike", "◆\u200b 7 checkpoints"],
          ["other-extension", "visible-status"],
        ]);
      },
      onBranchChange() {
        return () => {};
      },
    },
    theme: {
      fg(_style, text) {
        return text;
      },
      bold(text) {
        return text;
      },
    },
    getThinkingLevel() {
      return "off";
    },
    usageTotals: { input: 0, output: 0, cost: 0 },
    lastTps: null,
  });

  assert.equal(lines.length, 1);
  assert(!lines[0].includes("cache:observe"), "cache heartbeat status should stay hidden");
  assert(!lines[0].includes("GPT IP:"), "GPT IP check status should stay hidden");
  assert(!lines[0].includes("checkpoints"), "checkpoint noise filtering must use canonical text");
  assert(lines[0].includes("visible-status"), "other non-noisy statuses should still render");
}

function testDedicatedGptFastStatus() {
  const active = renderStatusline(320, renderFixture({
    statuses: new Map([
      ["gpt-fast", "FAST"],
      ["other-extension", "visible-status"],
    ]),
  }))[0];
  const activeText = active.replace(/\x1b\[[0-9;]*m/g, "");
  const modelIndex = activeText.indexOf("provider/model(off)");
  const fastIndex = activeText.indexOf("FAST");
  const cwdIndex = activeText.indexOf("example");
  assert(activeText.includes(" FAST"), "FAST must include its dedicated lightning icon");
  assert(modelIndex >= 0 && modelIndex < fastIndex, "FAST must render after model/thinking");
  assert(fastIndex < cwdIndex, "FAST must render before cwd");
  assert.equal(activeText.split("FAST").length - 1, 1, "FAST must render exactly once");
  assert(activeText.indexOf("visible-status") > cwdIndex, "generic statuses must remain in their existing trailing segment");
  for (const width of [1, 24, 80]) {
    assert.equal(
      visibleWidth(renderStatusline(width, renderFixture({ statuses: new Map([["gpt-fast", "FAST"]]) }))[0]),
      width,
      `dedicated FAST segment must preserve the existing ${width}-column truncation contract`,
    );
  }

  const paused = renderStatusline(320, renderFixture({ statuses: new Map([["gpt-fast", "FAST paused"]]) }))[0];
  const pausedText = paused.replace(/\x1b\[[0-9;]*m/g, "");
  assert(pausedText.includes(" FAST paused"), "paused FAST must keep the lightning icon");
  assert(pausedText.indexOf("provider/model(off)") < pausedText.indexOf("FAST paused"));
  assert(pausedText.indexOf("FAST paused") < pausedText.indexOf("example"));
  assert.equal(pausedText.split("FAST paused").length - 1, 1, "paused state must render exactly once");

  const lookalike = renderStatusline(320, renderFixture({
    statuses: new Map([
      ["gpt-\u200bfast", "lookalike-visible"],
      ["\x1b[31mgpt-fast\x1b[0m", "ansi-lookalike-visible"],
    ]),
  }))[0];
  assert(lookalike.indexOf("lookalike-visible") > lookalike.indexOf("example"), "lookalike key must stay generic");
  assert(lookalike.indexOf("ansi-lookalike-visible") > lookalike.indexOf("example"), "ANSI key must stay generic");

  const invalidExactValue = renderStatusline(320, renderFixture({
    statuses: new Map([["gpt-fast", "FAST\x1b[31m"]]),
  }))[0];
  assert(!invalidExactValue.includes("FAST"), "dedicated value must match the raw protocol exactly");
}

function testRobustStatuslineRender() {
  const lines = renderStatusline(240, {
    ctx: {
      cwd: undefined,
      model: { id: 42, contextWindow: "bad" },
      getContextUsage() {
        throw new Error("usage unavailable");
      },
    },
    footerData: {
      getGitBranch() {
        throw new Error("branch unavailable");
      },
      getExtensionStatuses() {
        throw new Error("statuses unavailable");
      },
      onBranchChange() {
        return () => {};
      },
    },
    theme: {
      fg() {
        throw new Error("theme fg unavailable");
      },
      bold() {
        throw new Error("theme bold unavailable");
      },
    },
    getThinkingLevel() {
      throw new Error("thinking unavailable");
    },
    usageTotals: { input: Number.NaN, output: 3, cost: Number.POSITIVE_INFINITY },
    lastTps: Number.NaN,
  });

  assert.equal(lines.length, 1);
  assert(lines[0].includes("no-model(default)"), "render should fall back to a safe model/thinking label");
}

function renderFixture({ ctx, footerData, statuses = new Map() } = {}) {
  return {
    ctx: ctx ?? {
      cwd: "/tmp/example",
      model: { id: "model", provider: "provider", contextWindow: 1000 },
      getContextUsage() {
        return { contextWindow: 1000, tokens: 100, percent: 10 };
      },
    },
    footerData: footerData ?? {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return statuses;
      },
      onBranchChange() {
        return () => {};
      },
    },
    theme: {
      fg(_style, text) {
        return text;
      },
      bold(text) {
        return text;
      },
    },
    getThinkingLevel() {
      return "off";
    },
    usageTotals: { input: 0, output: 0, cost: 0 },
    lastTps: null,
  };
}

async function testNoDetachedFooterReinstall() {
  const temp = mkdtempSync(join(tmpdir(), "pi-ccui-statusline-smoke-"));
  try {
    const { pi, emit } = createPi();
    let footerCalls = 0;
    const ctx = createContext(temp, {
      setFooter(factory) {
        if (typeof factory === "function") footerCalls += 1;
      },
    });

    registerStatusline(pi);
    await emit("session_start", {}, ctx);
    assert.equal(footerCalls, 1, "session_start should install one footer immediately");
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(footerCalls, 1, "one lifecycle event must not leave detached footer re-installs");
    await emit("session_shutdown", {}, ctx);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testRegistrationLifecycle() {
  const first = createPi();
  const second = createPi();

  registerStatusline(first.pi);
  registerStatusline(first.pi);
  registerStatusline(second.pi);
  for (const event of EVENT_NAMES) {
    assert.equal(first.handlerCount(event), 1, `${event} must register once on the first API`);
    assert.equal(second.handlerCount(event), 1, `${event} must register independently on a second API`);
  }

  const firstCtx = createContext("/tmp/first-api", { setFooter() {} });
  await first.emit("session_start", {}, firstCtx);
  await first.emit("session_shutdown", {}, firstCtx);
  registerStatusline(first.pi);
  const reloaded = (await import(`./pi-mystatusline.ts?reload=${Date.now()}`)).default;
  reloaded(first.pi);
  for (const event of EVENT_NAMES) {
    assert.equal(first.handlerCount(event), 1, `${event} physical handler must survive shutdown/reload without duplication`);
  }

  for (let failurePhase = 1; failurePhase <= EVENT_NAMES.length; failurePhase += 1) {
    const recovering = createPi({ failOnCall: failurePhase });
    assert.throws(() => registerStatusline(recovering.pi), /injected registration failure/);
    let footerCalls = 0;
    const recoveringCtx = createContext(`/tmp/recovering-api-${failurePhase}`, {
      setFooter() {
        footerCalls += 1;
      },
    });
    const partialStart = recovering.handlers.get("session_start")?.[0];
    if (partialStart) await partialStart({}, recoveringCtx);
    assert.equal(footerCalls, 0, `phase ${failurePhase} partial handlers must stay gated`);

    reloaded(recovering.pi);
    for (const event of EVENT_NAMES) {
      assert.equal(recovering.handlerCount(event), 1, `phase ${failurePhase} must recover ${event} without duplicates`);
    }
    await recovering.emit("session_start", {}, recoveringCtx);
    assert.equal(footerCalls, 1, `phase ${failurePhase} recovery must activate handlers`);
    await recovering.emit("session_shutdown", {}, recoveringCtx);
  }
}

async function testNonTuiSessionsSkipStatuslineWork() {
  let branchReads = 0;
  let footerCalls = 0;
  let agentMessageReads = 0;
  const { pi, emit } = createPi();
  const ctx = createContext("/tmp/non-tui", {
    setFooter() {
      footerCalls += 1;
    },
  });
  ctx.hasUI = false;
  ctx.mode = "json";
  ctx.sessionManager.getBranch = () => {
    branchReads += 1;
    return [];
  };

  registerStatusline(pi);
  await emit("session_start", {}, ctx);
  await emit("turn_end", { messages: [] }, ctx);
  const agentEndEvent = {};
  Object.defineProperty(agentEndEvent, "messages", {
    get() {
      agentMessageReads += 1;
      throw new Error("non-TUI agent messages must stay unread");
    },
  });
  await emit("agent_start", {}, ctx);
  await emit("agent_end", agentEndEvent, ctx);
  assert.equal(branchReads, 0, "non-TUI sessions must not aggregate invisible footer usage");
  assert.equal(footerCalls, 0, "non-TUI sessions must not install an invisible footer");
  assert.equal(agentMessageReads, 0, "non-TUI sessions must not aggregate invisible throughput");
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
}

async function testIdentityFailureDoesNotForkRuntimeState() {
  const { pi, emit } = createPi();
  let renderRequests = 0;
  const ctx = createContext("/tmp/stable-runtime", {
    setFooter(factory) {
      if (typeof factory !== "function") return;
      factory(
        { requestRender() { renderRequests += 1; } },
        { fg: (_style, text) => text, bold: (text) => text },
        {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => {},
        },
      );
    },
  });
  ctx.sessionManager.getSessionId = () => "stable-runtime";

  registerStatusline(pi);
  await emit("session_start", {}, ctx);
  const beforeBrokenIdentity = renderRequests;
  ctx.sessionManager.getSessionId = () => {
    throw new Error("temporary identity failure");
  };
  await emit("turn_end", { messages: [] }, ctx);
  assert(renderRequests > beforeBrokenIdentity, "identity lookup failure must not fork state away from the installed footer");
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
}

function testSanitizesDynamicTerminalText() {
  const line = renderStatusline(320, renderFixture({
    ctx: {
      cwd: "/tmp/project\nname\x1b]0;cwd-title\x07",
      model: {
        id: "model\x1b[?25l",
        provider: "provider\rname\u202e",
        contextWindow: 1000,
      },
      getContextUsage() {
        return { contextWindow: 1000, tokens: 100, percent: 10 };
      },
    },
    footerData: {
      getGitBranch() {
        return "main\nbranch\x1b]8;;https://example.invalid\x07";
      },
      getExtensionStatuses() {
        return new Map([
          ["hidden", "\x1b[?25lMCP: secret\nsecond-line"],
          ["dcs", "\x1bP1;2|DCS-PAYLOAD\x1b\\MCP: dcs-secret"],
          ["apc", "\x1b_APC-PAYLOAD\x1b\\MCP: apc-secret"],
          ["c1-csi", "\u009b?25lMCP: c1-secret"],
          ["zero-width-status", "M\u200bCP: zero-width-secret"],
          ["cache-\u200bheartbeat", "zero-width-key-secret"],
          ["visible", "\x1b]0;status-title\x07visible\rstatus\u2066"],
        ]);
      },
      onBranchChange() {
        return () => {};
      },
    },
  }))[0];

  const withoutSgr = line.replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(withoutSgr, /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u);
  assert(!line.includes("secret"), "canonicalized MCP status must remain hidden");
  assert(!line.includes("PAYLOAD"), "terminal control-string payloads must be removed with their wrappers");
  assert(line.includes("visible status"), "safe visible status text should remain readable");
}

function testRobustStatusSnapshots() {
  const throwingMap = new Proxy(new Map([["visible", "ok"]]), {});
  assert.doesNotThrow(() => renderStatusline(120, renderFixture({ statuses: throwingMap })));

  const invalidEntries = {
    *entries() {
      yield ["visible", "ok"];
      yield [{ bad: "key" }, "bad-key"];
      yield ["bad-value", { bad: "value" }];
      throw new Error("iterator failed");
    },
  };
  assert.doesNotThrow(() => renderStatusline(120, renderFixture({ statuses: invalidEntries })));

  let invalidYields = 0;
  const manyInvalidEntries = {
    *entries() {
      while (invalidYields < 1000) {
        invalidYields += 1;
        yield [null, null];
      }
    },
  };
  assert.doesNotThrow(() => renderStatusline(120, renderFixture({ statuses: manyInvalidEntries })));
  assert.equal(invalidYields, 64, "invalid status iterators must stop at the exact inspection cap");

  const throwingScalars = new Proxy({}, {
    get() {
      throw new Error("nested getter failed");
    },
  });
  assert.doesNotThrow(() => renderStatusline(120, renderFixture({
    ctx: {
      cwd: "/tmp/example",
      model: throwingScalars,
      getContextUsage() {
        return throwingScalars;
      },
    },
  })));
}

function testWidthAndStatusBounds() {
  const input = renderFixture({
    statuses: new Map([
      ["unicode", "𠀀 👍🏽 👨‍👩‍👧‍👦 e\u0301"],
      ["isolated-modifier", "🏽"],
      ["long", "x".repeat(1_000_000)],
      ["escape-flood", "\x1b[31m".repeat(1000) + "AFTER_RAW_CAP"],
      ...Array.from({ length: 40 }, (_, index) => [`status-${index}`, `value-${index}`]),
    ]),
  });

  for (const width of [1, 2, 3, 40, 78, 79, 80, 120, 320]) {
    const line = renderStatusline(width, input)[0];
    assert.equal(visibleWidth(line), width, `rendered line must occupy exactly ${width} columns`);
  }
  const isolatedModifier = renderFixture({ statuses: new Map([["modifier", "🏽"]]) });
  for (const width of [96, 120, 140]) {
    assert.equal(
      visibleWidth(renderStatusline(width, isolatedModifier)[0]),
      width,
      "isolated emoji modifiers must not combine across styled status boundaries",
    );
  }
  for (const width of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.deepEqual(renderStatusline(width, input), [""], `invalid width ${width} must fail closed`);
  }
  assert.equal(visibleWidth(renderStatusline(1.9, input)[0]), 1, "fractional width must be floored");
  assert.equal(visibleWidth(renderStatusline(100_000, input)[0]), 4096, "render width must have a defensive allocation cap");
  const wide = renderStatusline(4096, input)[0];
  assert(!wide.includes("value-20"), "status snapshot must cap untrusted status count");
  assert(!wide.includes("AFTER_RAW_CAP"), "raw input cap must apply before escape-sequence cleanup");
}

await testSetFooterFailure();
await testFooterRenderFailure();
await testMissingCwdAndBrokenSessionBranch();
await testMalformedAgentEndEvent();
await testUsageAndThroughputAggregation();
await testNoDetachedFooterReinstall();
await testRegistrationLifecycle();
await testNonTuiSessionsSkipStatuslineWork();
await testIdentityFailureDoesNotForkRuntimeState();
testHidesCacheHeartbeatStatus();
testDedicatedGptFastStatus();
testRobustStatuslineRender();
testSanitizesDynamicTerminalText();
testRobustStatusSnapshots();
testWidthAndStatusBounds();
console.log("pi-ccui-statusline smoke test passed");
