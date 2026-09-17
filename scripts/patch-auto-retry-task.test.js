const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const acorn = require("acorn");

const {
  BACKGROUND_RETRY_MARKER,
  DIRECT_RETRY_TRIGGER,
  LEGACY_CONTINUATION_INPUT,
  buildBackgroundRetryExpression,
  patchInitialSource,
  patchPrimarySource,
} = require("./patch-auto-retry-task");

function createInitialBundle({ executorResume = false } = {}) {
  const manager = executorResume
    ? [
        "class Manager{",
        "#e(e,t){return t}",
        "startEmptyTurn(e,t){return bridge({conversationId:e,manager:this,options:t,resumeConversation:n=>this.#e(n,`view`)})}",
        "}",
      ].join("")
    : [
        "class Manager{",
        "startEmptyTurn(e,t){return bridge({conversationId:e,manager:this,options:t,resumeConversation:n=>this.maybeResumeConversation(n)})}",
        "}",
      ].join("");

  return [
    manager,
    "function onTurnCompleted(){",
    "r.broadcastConversationSnapshot(c),",
    "r.getStreamRole(c)?.role!==`follower`&&",
    "i.events.emitTurnCompleted({conversationId:c,hostId:r.getHostId(),status:s.status,turnId:s.id})",
    "}",
  ].join("");
}

function createLegacyPrimaryBundle() {
  return [
    "function retry(e){",
    "let{conversationId:n,hostId:r,retryDelaySeconds:_rds}=e,i=3,s={role:`owner`},u=1;",
    "let g=()=>{},f=()=>{};",
    "if(u===0){globalThis.__codexAutoRetries=globalThis.__codexAutoRetries||new Map();",
    "let _ar=globalThis.__codexAutoRetries.get(n)||{count:0,time:0};",
    "if(Date.now()-_ar.time>3e5)_ar={count:0,time:Date.now()};",
    "if(_ar.count<3){_ar.count++;_ar.time=Date.now();globalThis.__codexAutoRetries.set(n,_ar);g(`capacity_retry_automatic`)}else{f(null)}return}f(u);",
    "let b=()=>(globalThis.__codexAutoRetries?.delete(n),g(`capacity_retry_manual`));",
    "return a.errorInfo!=`usageLimitExceeded`&&o!=null?Ade(a,r,n,{turnTrigger:e,collaborationMode:c,continuationInput:[{type:`text`,text:`继续未完成的工作`,text_elements:[]}]})+s?.role!==`follower`:b",
    "}",
  ].join("");
}

function createLegacyBackgroundInjection() {
  return [
    "(s.status===`completed`&&globalThis.__codexAutoRetries?.delete(c)),",
    "((s.status===`failed`||s.status===`error`||(s.status!==`completed`&&s.status!==`interrupted`&&s.error!=null))",
    "&&!(r.turnCoordinator?.readHead?.(c))&&setTimeout(async()=>{",
    "try{globalThis.__codexAutoRetries=globalThis.__codexAutoRetries||new Map();",
    "let _ar=globalThis.__codexAutoRetries.get(c)||{count:0,time:0};",
    "if(Date.now()-_ar.time>3e5)_ar={count:0,time:Date.now()};",
    "if(_ar.count<3){_ar.count++;_ar.time=Date.now();globalThis.__codexAutoRetries.set(c,_ar);",
    "await r.startEmptyTurn(c,{resumeSource:`executor`,turnTrigger:`capacity_retry_automatic`,continuationInput:[{type:`text`,text:`继续未完成的工作`,text_elements:[]}]})}",
    "}catch(e){}},3e3)),",
  ].join("");
}

function evaluateRetryExpression(context) {
  const expression = buildBackgroundRetryExpression({
    conversationId: "conversationId",
    manager: "manager",
    turn: "turn",
  }).slice(0, -2);
  return vm.runInNewContext(`result=${expression}`, context);
}

function createRetryContext({ error, queued = false } = {}) {
  const timers = [];
  const started = [];
  const state = { active: false };
  const queueState = { queued };
  const turn = {
    id: "turn-1",
    status: "failed",
    error,
  };
  const manager = {
    getStreamRole: () => ({ role: "owner" }),
    getTurn: (_conversationId, turnId) => (turnId === turn.id ? turn : null),
    getConversation: () => ({
      threadRuntimeStatus: { type: state.active ? "active" : "idle" },
    }),
    startEmptyTurn: async (...args) => {
      started.push(args);
      state.active = true;
    },
    turnCoordinator: {
      readHead: () => (queueState.queued ? { id: "queued-message" } : null),
    },
  };
  const context = {
    conversationId: "conversation-1",
    manager,
    setTimeout: (callback, delay) => {
      const timer = { callback, cancelled: false, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cancelled = true;
    },
    turn,
  };

  return { context, manager, queueState, started, state, timers, turn };
}

test("后台补丁挂在 turn/completed 链路且不注入续接消息", () => {
  const result = patchInitialSource(createInitialBundle());

  assert.equal(result.status, "patched");
  assert.match(result.source, new RegExp(BACKGROUND_RETRY_MARKER));
  assert.match(
    result.source,
    /r\.startEmptyTurn\(c,\{resumeSource:"executor",turnTrigger:"capacity_retry_automatic"\}\)/,
  );
  assert.doesNotMatch(result.source, /continuationInput/);
  assert.doesNotMatch(result.source, /继续未完成的工作/);
  assert.doesNotThrow(() =>
    acorn.parse(result.source, { ecmaVersion: "latest", sourceType: "script" }),
  );

  const second = patchInitialSource(result.source);
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, result.source);
});

test("新版恢复链路使用 executor，而不依赖 view", () => {
  const result = patchInitialSource(createInitialBundle({ executorResume: true }));

  assert.equal(result.status, "patched");
  assert.match(result.source, /this\.#e\(n,t\?\.resumeSource\?\?`view`\)/);
});

test("旧版 UI 补丁迁移后恢复直接空轮次重试", () => {
  const source = createLegacyPrimaryBundle();
  const result = patchPrimarySource(source);

  assert.equal(result.status, "patched");
  assert.doesNotMatch(result.source, new RegExp(LEGACY_CONTINUATION_INPUT));
  assert.doesNotMatch(result.source, /__codexAutoRetries/);
  assert.match(result.source, /a\.errorInfo===`serverOverloaded`&&o!=null/);
  assert.match(result.source, /retryDelaySeconds:i\}=e/);
  assert.match(result.source, /s\?\.role===`owner`/);
  assert.doesNotThrow(() =>
    acorn.parse(result.source, { ecmaVersion: "latest", sourceType: "script" }),
  );
  assert.equal(patchPrimarySource(result.source).status, "already-patched");
});

test("旧版后台注入会被替换为新的直接重试调度器", () => {
  const source = createInitialBundle().replace(
    "i.events.emitTurnCompleted",
    `${createLegacyBackgroundInjection()}i.events.emitTurnCompleted`,
  );
  const result = patchInitialSource(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, new RegExp(BACKGROUND_RETRY_MARKER));
  assert.doesNotMatch(result.source, /__codexAutoRetries/);
  assert.doesNotMatch(result.source, /continuationInput/);
});

test("高负载失败在后台直接启动空轮次，首个退避为 3 秒", async () => {
  const fixture = createRetryContext({
    error: { message: "We're currently experiencing high demand." },
  });

  assert.equal(evaluateRetryExpression(fixture.context), true);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, 3000);

  await fixture.timers[0].callback();
  assert.equal(fixture.started.length, 1);
  assert.equal(fixture.started[0][0], "conversation-1");
  assert.equal(fixture.started[0][1].resumeSource, "executor");
  assert.equal(fixture.started[0][1].turnTrigger, DIRECT_RETRY_TRIGGER);
  assert.equal("continuationInput" in fixture.started[0][1], false);
});

test("额度错误或已有排队消息不会启动后台自动重试", () => {
  const usageLimit = createRetryContext({
    error: { codexErrorInfo: "usageLimitExceeded", message: "Usage limit reached" },
  });
  const queued = createRetryContext({
    error: { codexErrorInfo: "serverOverloaded" },
    queued: true,
  });

  evaluateRetryExpression(usageLimit.context);
  evaluateRetryExpression(queued.context);

  assert.equal(usageLimit.timers.length, 0);
  assert.equal(queued.timers.length, 0);
});

test("重试等待期间出现排队消息会取消后台任务", async () => {
  const fixture = createRetryContext({
    error: { codexErrorInfo: "serverOverloaded" },
  });

  evaluateRetryExpression(fixture.context);
  fixture.queueState.queued = true;
  await fixture.timers[0].callback();

  assert.equal(fixture.started.length, 0);
  assert.equal(
    fixture.context.__codexDirectRetryState.has("conversation-1"),
    false,
  );
});

test("成功完成会取消同一会话尚未触发的后台定时器", () => {
  const fixture = createRetryContext({
    error: { codexErrorInfo: "serverOverloaded" },
  });

  evaluateRetryExpression(fixture.context);
  assert.equal(fixture.timers.length, 1);

  fixture.turn.status = "completed";
  fixture.turn.error = null;
  evaluateRetryExpression(fixture.context);

  assert.equal(fixture.timers[0].cancelled, true);
});
