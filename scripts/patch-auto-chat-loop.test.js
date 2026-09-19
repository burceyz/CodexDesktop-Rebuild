const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const acorn = require("acorn");

const {
  RUNTIME_MARKER,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MESSAGES,
  INTERVAL_OPTIONS,
  buildRuntimeExpression,
  patchInitialSource,
  patchMenuSource,
} = require("./patch-auto-chat-loop");

function createMenuBundle() {
  return [
    "function readModel(e,t,n){return e.get(Sg,n)?.getConversation(t)?.model}",
    "function menu({scope:e,target:t,surface:o,canOpenSideChat:d}){",
    "let{conversationId:_,hostId:v,cwd:y}=t,F=[];",
    "let r=!0;o===`header`&&d&&F.push({id:`open-side-chat`,onSelect:()=>{}});",
    "return F",
    "}",
  ].join("");
}

function createInitialBundle() {
  return [
    "function onTurnCompleted(){",
    "r.getStreamRole(c)?.role!==`follower`&&",
    "i.events.emitTurnCompleted({conversationId:c,hostId:r.getHostId(),status:s.status,turnId:s.id})",
    "}",
  ].join("");
}

function parse(code) {
  return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
}

function createRuntime() {
  const timers = [];
  const context = {
    globalThis: null,
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    Math,
    JSON,
    Array,
    Map,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(buildRuntimeExpression(), context);
  const runtime = context[RUNTIME_MARKER];
  const pending = () => timers.filter((t) => !t.cleared);
  runtime.__context = context;
  const fire = async () => {
    const [timer] = pending();
    assert.ok(timer, "expected a pending timer");
    timer.cleared = true;
    await timer.fn();
  };
  return { runtime, pending, fire };
}

function createManager(overrides = {}) {
  const sent = [];
  return {
    sent,
    getStreamRole: () => ({ role: "owner" }),
    getConversation: () => ({ threadRuntimeStatus: { type: "idle" } }),
    turnCoordinator: { readHead: () => null },
    sendFollowUpMessage: async (id, options) => {
      sent.push({ id, ...options });
      return "turn-1";
    },
    ...overrides,
  };
}

test("menu: injects runtime and header menu items before open-side-chat", () => {
  const result = patchMenuSource(createMenuBundle());
  assert.equal(result.status, "patched");
  assert.doesNotThrow(() => parse(result.source));
  assert.ok(result.source.includes("id:`auto-chat-toggle`"));
  assert.ok(result.source.includes("()=>e.get(Sg,v)"));
  assert.ok(result.source.includes(`${RUNTIME_MARKER}.toggle(_,`));
  for (const { ms } of INTERVAL_OPTIONS) {
    assert.ok(result.source.includes(`id:\`auto-chat-interval-${ms}\``));
  }
  assert.ok(
    result.source.indexOf("auto-chat-toggle") < result.source.indexOf("open-side-chat"),
  );
});

test("menu: items are only pushed for the header surface", () => {
  const result = patchMenuSource(createMenuBundle());
  const context = { globalThis: null, Map, JSON, Array, Math, setTimeout() {}, clearTimeout() {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${result.source};this.menu=menu`, context);
  const target = { conversationId: "c1", hostId: "local", cwd: "/" };
  const scope = { get: () => null };
  const header = context.menu({ scope, target, surface: "header", canOpenSideChat: true });
  const sidebar = context.menu({ scope, target, surface: "sidebar", canOpenSideChat: true });
  assert.deepEqual(
    [...header.map((item) => item.id)],
    ["auto-chat-toggle", ...INTERVAL_OPTIONS.map(({ ms }) => `auto-chat-interval-${ms}`), "open-side-chat"],
  );
  assert.equal(header[0].checked, false);
  assert.equal(header.find((i) => i.id === `auto-chat-interval-${DEFAULT_INTERVAL_MS}`).checked, true);
  assert.equal(sidebar.length, 0);
});

test("menu: is idempotent and skips bundles without the anchor", () => {
  const once = patchMenuSource(createMenuBundle());
  assert.equal(patchMenuSource(once.source).status, "already-patched");
  assert.equal(patchMenuSource("function x(){}").status, "not-present");
  assert.equal(
    patchMenuSource(createMenuBundle().replace("e.get(Sg,n)", "e.get(Zz,n)").concat("e.get(Sg,n)?.getConversation(")).status,
    "unexpected-manager-atom-count",
  );
});

test("initial: notifies runtime before emitTurnCompleted", () => {
  const result = patchInitialSource(createInitialBundle());
  assert.equal(result.status, "patched");
  assert.doesNotThrow(() => parse(result.source));
  assert.ok(
    result.source.includes(
      `(globalThis.${RUNTIME_MARKER}?.onTurnCompleted(c,s.status),!0)&&i.events.emitTurnCompleted(`,
    ),
  );
  assert.equal(patchInitialSource(result.source).status, "already-patched");
  assert.equal(patchInitialSource("function x(){}").status, "not-found");
});

test("initial: coexists with the auto-retry injection at the same anchor", () => {
  const { patchInitialSource: patchRetry } = require("./patch-auto-retry-task");
  const retried = patchRetry(createInitialBundle());
  assert.equal(retried.status, "patched");
  const result = patchInitialSource(retried.source);
  assert.equal(result.status, "patched");
  assert.doesNotThrow(() => parse(result.source));
});

test("initial: one bundle can take both the menu and the turn hook (26.915 layout)", () => {
  const combined = createMenuBundle() + createInitialBundle();
  const menu = patchMenuSource(combined);
  assert.equal(menu.status, "patched");
  const hook = patchInitialSource(menu.source);
  assert.equal(hook.status, "patched");
  assert.doesNotThrow(() => parse(hook.source));
  assert.equal(patchMenuSource(hook.source).status, "already-patched");
  assert.equal(patchInitialSource(hook.source).status, "already-patched");
  assert.equal(patchInitialSource(menu.source).status, "patched");
});

test("runtime: toggle schedules, sends after interval, reschedules on completion", async () => {
  const { runtime, pending, fire } = createRuntime();
  const manager = createManager();
  runtime.toggle("c1", () => manager);
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, DEFAULT_INTERVAL_MS);

  await fire();
  assert.equal(manager.sent.length, 1);
  assert.equal(manager.sent[0].id, "c1");
  assert.ok(DEFAULT_MESSAGES.includes(manager.sent[0].prompt));
  assert.equal(pending().length, 0);

  runtime.onTurnCompleted("c1", "completed");
  assert.equal(pending().length, 1);
  await fire();
  assert.equal(manager.sent.length, 2);
  assert.notEqual(manager.sent[0].prompt, manager.sent[1].prompt);
});

test("runtime: interrupted disables, failed leaves it to auto-retry, toggle off clears timer", () => {
  const { runtime, pending } = createRuntime();
  runtime.toggle("c1", () => createManager());
  runtime.onTurnCompleted("c1", "failed");
  assert.equal(pending().length, 1);

  runtime.onTurnCompleted("c1", "interrupted");
  assert.equal(runtime.get("c1").enabled, false);
  assert.equal(pending().length, 0);

  runtime.toggle("c1", () => createManager());
  runtime.toggle("c1");
  assert.equal(runtime.get("c1").enabled, false);
  assert.equal(pending().length, 0);

  runtime.onTurnCompleted("c2", "completed");
  assert.equal(pending().length, 0);
});

test("runtime: setInterval reschedules an active loop and is remembered when off", () => {
  const { runtime, pending } = createRuntime();
  runtime.setInterval("c1", 15e3);
  assert.equal(pending().length, 0);
  runtime.toggle("c1", () => createManager());
  assert.equal(pending()[0].delay, 15e3);
  runtime.setInterval("c1", 6e4);
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, 6e4);
});

test("runtime: defers while the thread is active, queued, or not owned", async () => {
  const { runtime, pending, fire } = createRuntime();
  let status = "active";
  let head = null;
  let role = "owner";
  const manager = createManager({
    getConversation: () => ({ threadRuntimeStatus: { type: status } }),
    turnCoordinator: { readHead: () => head },
    getStreamRole: () => ({ role }),
  });
  runtime.toggle("c1", () => manager);

  await fire();
  assert.equal(manager.sent.length, 0);
  assert.equal(pending().length, 1);

  status = "idle";
  head = { id: "queued" };
  await fire();
  assert.equal(manager.sent.length, 0);

  head = null;
  role = "follower";
  await fire();
  assert.equal(manager.sent.length, 0);

  role = "owner";
  await fire();
  assert.equal(manager.sent.length, 1);
});

test("runtime: send failure retries after the interval, messages can be overridden", async () => {
  const { runtime, pending, fire } = createRuntime();
  const manager = createManager({
    sendFollowUpMessage: async () => {
      throw new Error("not ready");
    },
  });
  runtime.toggle("c1", () => manager);
  await fire();
  assert.equal(pending().length, 1);
  runtime.toggle("c1");

  runtime.__context.localStorage = { getItem: () => JSON.stringify(["只有一条", "  "]) };
  const seen = [];
  const custom = createManager({
    sendFollowUpMessage: async (_, { prompt }) => {
      seen.push(prompt);
    },
  });
  runtime.toggle("c2", () => custom);
  await fire();
  runtime.onTurnCompleted("c2", "completed");
  await fire();
  assert.deepEqual(seen, ["只有一条", "只有一条"]);

  runtime.__context.localStorage = { getItem: () => "not json" };
  assert.deepEqual([...runtime.readMessages()], DEFAULT_MESSAGES);
});
