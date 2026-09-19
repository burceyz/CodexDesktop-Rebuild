#!/usr/bin/env node
/**
 * patch-auto-chat-loop.js — 会话页“自动续聊”：轮次完成后按固定间隔自动发送一条预设消息。
 *
 * 设计：
 * - 运行时对象 globalThis.__codexAutoChat 只在 app-primary 的会话页菜单里定义一次，
 *   按 conversationId 保存 {enabled, intervalMs, timer}，纯内存，重启即关闭。
 * - 会话页顶部“…”菜单（surface === header）追加一个 checkbox 开关和一组间隔 radio。
 * - app-initial 的 turn/completed 处理链只做一件事：通知运行时本会话的轮次状态。
 *   completed → 按间隔调度下一条；interrupted 视为用户介入 → 自动关闭；
 *   failed → 不处理，交给 patch-auto-retry-task 的后台重试，重试完成后再自然接上。
 * - 发送走 manager.sendFollowUpMessage，与用户手动输入完全等价；发送前若会话仍在
 *   运行或有排队消息，则顺延一个间隔再试。
 * - 消息列表可用 localStorage["codex.autoChat.messages"]（JSON 字符串数组）覆盖。
 *
 * Usage:
 *   node scripts/patch-auto-chat-loop.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-auto-chat-loop.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const RUNTIME_MARKER = "__codexAutoChat";
const DEFAULT_INTERVAL_MS = 3e4;
const INTERVAL_OPTIONS = [
  { ms: 15e3, label: "15 秒" },
  { ms: 3e4, label: "30 秒" },
  { ms: 6e4, label: "60 秒" },
  { ms: 12e4, label: "2 分钟" },
  { ms: 3e5, label: "5 分钟" },
];
const DEFAULT_MESSAGES = [
  "请总结一下目前的进展和下一步计划。",
  "当前实现里有没有你认为值得重构的地方？",
  "请检查一下刚才的修改是否有遗漏的边界情况。",
  "用一句话概括这次任务的目标。",
  "还有哪些地方需要补充测试？",
  "列出目前尚未解决的问题。",
  "请回顾一下我们做过的关键决策及其理由。",
  "如果要写提交信息，你会怎么写？",
  "现在的代码结构是否符合单一职责原则？",
  "有没有可以简化的逻辑？",
  "请说明当前方案的主要风险。",
  "下一步最值得做的一件事是什么？",
  "请检查命名是否清晰一致。",
  "有没有需要更新的文档或注释？",
  "请给出一份简短的验证清单。",
];

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
}

/**
 * 运行时对象。作为表达式插入，首次构建会话页菜单时惰性创建。
 */
function buildRuntimeExpression() {
  return (
    `(globalThis.${RUNTIME_MARKER}??={` +
    `defaultIntervalMs:${DEFAULT_INTERVAL_MS},` +
    `messages:${JSON.stringify(DEFAULT_MESSAGES)},` +
    `state:new Map(),` +
    `get(id){return this.state.get(id)},` +
    `readMessages(){try{let m=JSON.parse(globalThis.localStorage?.getItem("codex.autoChat.messages")??"null");if(Array.isArray(m)){let f=m.filter(x=>typeof x==="string"&&x.trim().length>0);if(f.length>0)return f}}catch{}return this.messages},` +
    `pick(c){let m=this.readMessages();if(m.length===1)return m[0];let i;do i=Math.floor(Math.random()*m.length);while(i===c.lastIndex);c.lastIndex=i;return m[i]},` +
    `clear(c){c.timer!=null&&clearTimeout(c.timer),c.timer=null},` +
    `ensure(id){let c=this.state.get(id);return c==null&&(c={enabled:!1,intervalMs:this.defaultIntervalMs,timer:null,lastIndex:-1,getManager:null},this.state.set(id,c)),c},` +
    `setEnabled(id,on,getManager){let c=this.ensure(id);this.clear(c),c.enabled=on,c.getManager=on?getManager:null,on&&this.schedule(id)},` +
    `toggle(id,getManager){this.setEnabled(id,!this.state.get(id)?.enabled,getManager)},` +
    `setInterval(id,ms){let c=this.ensure(id);c.intervalMs=ms,c.enabled&&this.schedule(id)},` +
    `schedule(id){let c=this.state.get(id);c?.enabled&&(this.clear(c),c.timer=setTimeout(()=>this.run(id),c.intervalMs))},` +
    `onTurnCompleted(id,status){let c=this.state.get(id);c?.enabled&&(status==="completed"?this.schedule(id):status==="interrupted"&&this.setEnabled(id,!1))},` +
    `async run(id){let c=this.state.get(id);if(!c?.enabled)return;c.timer=null;let m=c.getManager?.();if(m==null||m.getStreamRole?.(id)?.role!=="owner"||m.getConversation?.(id)?.threadRuntimeStatus?.type==="active"||m.turnCoordinator?.readHead?.(id)){this.schedule(id);return}try{await m.sendFollowUpMessage(id,{prompt:this.pick(c)})}catch{this.schedule(id)}}` +
    `})`
  );
}

/**
 * 会话页菜单项。checkbox 开关 + 间隔 radio，状态每次打开菜单时从运行时读取。
 */
function buildMenuItemsExpression({ scope, conversationId, hostId, managerAtom }) {
  const runtime = `globalThis.${RUNTIME_MARKER}`;
  const toggle =
    `{id:\`auto-chat-toggle\`,type:\`checkbox\`,closeOnSelect:!0,` +
    `checked:!!${runtime}.get(${conversationId})?.enabled,` +
    `message:{id:\`threadHeader.autoChatToggle\`,defaultMessage:\`自动续聊\`,description:\`Menu toggle that keeps sending preset messages after each reply\`},` +
    `onSelect:()=>${runtime}.toggle(${conversationId},()=>${scope}.get(${managerAtom},${hostId}))}`;
  const radios = INTERVAL_OPTIONS.map(
    ({ ms, label }) =>
      `{id:\`auto-chat-interval-${ms}\`,type:\`radio\`,closeOnSelect:!0,` +
      `checked:(${runtime}.get(${conversationId})?.intervalMs??${DEFAULT_INTERVAL_MS})===${ms},` +
      `message:{id:\`threadHeader.autoChatInterval${ms}\`,defaultMessage:\`间隔 ${label}\`,description:\`Auto chat interval option\`},` +
      `onSelect:()=>${runtime}.setInterval(${conversationId},${ms})}`,
  );
  return [toggle, ...radios].join(",");
}

/**
 * app-primary：在会话页菜单 open-side-chat 的 push 语句前插入运行时定义和菜单项。
 */
function patchPrimarySource(source) {
  if (source.includes(RUNTIME_MARKER)) {
    return { status: "already-patched", source };
  }

  const anchorPattern =
    /([a-zA-Z0-9_$]+)===`header`&&([a-zA-Z0-9_$]+)&&([a-zA-Z0-9_$]+)\.push\(\{id:`open-side-chat`/;
  const anchorMatch = source.match(anchorPattern);
  if (!anchorMatch) {
    return { status: "not-found", source };
  }
  const [anchorText, surface, , items] = anchorMatch;
  const anchorIndex = anchorMatch.index;

  const head = source.slice(0, anchorIndex);
  const functionIndex = head.lastIndexOf("function ");
  const functionMatch = head
    .slice(functionIndex)
    .match(/^function [a-zA-Z0-9_$]+\(\{scope:([a-zA-Z0-9_$]+),target:([a-zA-Z0-9_$]+),/);
  if (!functionMatch) {
    return { status: "scope-not-found", source };
  }
  const [, scope, target] = functionMatch;

  const targetMatch = head
    .slice(functionIndex)
    .match(
      new RegExp(
        `\\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+),cwd:[a-zA-Z0-9_$]+\\}=${target.replace(/\$/g, "\\$")}`,
      ),
    );
  if (!targetMatch) {
    return { status: "target-not-found", source };
  }
  const [, conversationId, hostId] = targetMatch;

  const managerAtoms = new Set(
    [...source.matchAll(/\.get\(([a-zA-Z0-9_$]+),[a-zA-Z0-9_$]+\)\?\.getConversation\(/g)].map(
      (m) => m[1],
    ),
  );
  if (managerAtoms.size !== 1) {
    return { status: "unexpected-manager-atom-count", count: managerAtoms.size, source };
  }
  const [managerAtom] = managerAtoms;

  const injection =
    `${buildRuntimeExpression()},${surface}===\`header\`&&${items}.push(` +
    buildMenuItemsExpression({ scope, conversationId, hostId, managerAtom }) +
    `),`;
  const patched = head + injection + source.slice(anchorIndex);

  try {
    parseCode(patched);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  return { status: "patched", source: patched };
}

/**
 * app-initial：在 turn/completed 事件发出前通知运行时。
 */
function patchInitialSource(source) {
  if (source.includes(RUNTIME_MARKER)) {
    return { status: "already-patched", source };
  }

  const emitRegex =
    /([a-zA-Z0-9_$]+)\.events\.emitTurnCompleted\(\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+)\.getHostId\(\),status:([a-zA-Z0-9_$]+)\.status/;
  const emitMatch = source.match(emitRegex);
  if (!emitMatch) {
    return { status: "not-found", source };
  }

  const [fullMatch, , conversationId, , turn] = emitMatch;
  const injection = `(globalThis.${RUNTIME_MARKER}?.onTurnCompleted(${conversationId},${turn}.status),!0)&&`;
  const patched = source.replace(fullMatch, `${injection}${fullMatch}`);

  try {
    parseCode(patched);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  return { status: "patched", source: patched };
}

function applyBundles({ bundles, patch, isCheck, label }) {
  let failed = 0;
  for (const bundle of bundles) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const result = patch(source);
    const name = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${name}: ${label} already patched`);
      continue;
    }
    if (result.status !== "patched") {
      const detail =
        result.status === "parse-failed"
          ? result.error.message
          : result.count != null
            ? `count is ${result.count}`
            : result.status;
      console.log(`  [x] ${name}: ${label} ${detail}`);
      failed++;
      continue;
    }
    if (isCheck) {
      console.log(`  [dry-run] ${name}: would patch ${label}`);
      continue;
    }
    fs.writeFileSync(bundle.path, result.source, "utf-8");
    console.log(`  [ok] ${name}: patched ${label}`);
  }
  return failed;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));

  let failed = 0;
  failed += applyBundles({
    bundles: locateBundles({ dir: "assets", pattern: /^app-primary-.*\.js$/, platform }),
    patch: patchPrimarySource,
    isCheck,
    label: "auto chat menu",
  });
  failed += applyBundles({
    bundles: locateBundles({ dir: "assets", pattern: /^app-initial-.*\.js$/, platform }),
    patch: patchInitialSource,
    isCheck,
    label: "auto chat turn hook",
  });

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  RUNTIME_MARKER,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MESSAGES,
  INTERVAL_OPTIONS,
  buildRuntimeExpression,
  patchInitialSource,
  patchPrimarySource,
};
