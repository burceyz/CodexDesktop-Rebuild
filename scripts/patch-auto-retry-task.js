#!/usr/bin/env node
/**
 * patch-auto-retry-task.js — 在后台直接重试暂时性服务过载失败的轮次。
 *
 * 设计：
 * - 调度器注入 app-initial 的 turn/completed 处理链，而不是 React 错误卡片；
 *   因此切换会话、最小化窗口或窗口失焦都不会取消重试。
 * - 调用 startEmptyTurn，保留原会话上下文且 input 为空；不发送用户消息，也不
 *   注入“继续未完成的工作”一类提示文本。
 * - 仅处理 serverOverloaded 和明确的暂时性连接/容量错误，避免对额度、权限或
 *   用户主动中断进行自动重试。
 * - 每个会话只有一个定时器。退避为 3、5、10、20、30 秒，成功、手动新轮次或
 *   有排队消息时均会自然取消，不再存在需要人工解锁的固定次数上限。
 * - 主会话窗口显式禁用 Electron 的后台节流，确保失焦、切换窗口或最小化后
 *   仍按上述退避时间执行；不影响浮层、快捷输入等辅助窗口。
 *
 * Usage:
 *   node scripts/patch-auto-retry-task.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-auto-retry-task.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const BACKGROUND_RETRY_MARKER = "__codexDirectRetryState";
const BACKGROUND_THROTTLING_MARKER = "codex-background-direct-retry";
const LEGACY_RETRY_MARKER = "__codexAutoRetries";
const DIRECT_RETRY_TRIGGER = "capacity_retry_automatic";
const LEGACY_CONTINUATION_INPUT =
  "continuationInput:[{type:`text`,text:`继续未完成的工作`,text_elements:[]}]";

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
}

/**
 * 将旧版 UI 补丁迁移回原生 UI 行为。
 *
 * 旧补丁会给 startEmptyTurn 加 continuationInput，既不符合“直接重试”的语义，
 * 也会使前台的 React 倒计时与后台定时器竞争。新构建不会修改 app-primary；
 * 这里只清理已经被旧版补丁处理过的 bundle，保证可安全地在现有源码上重跑。
 */
function patchPrimarySource(source) {
  let patched = source;
  let modified = false;

  const replace = (pattern, replacement) => {
    const next = patched.replace(pattern, replacement);
    if (next !== patched) {
      patched = next;
      modified = true;
    }
  };

  replace(
    /,continuationInput:\[\{type:`text`,text:`继续未完成的工作`,text_elements:\[\]\}\]/g,
    "",
  );

  // 恢复旧补丁放宽的错误卡片入口，后台调度器只处理真正的暂时性容量错误。
  replace(
    /([a-zA-Z0-9_$]+)\.errorInfo!=`usageLimitExceeded`&&([a-zA-Z0-9_$]+)!=null/g,
    "$1.errorInfo===`serverOverloaded`&&$2!=null",
  );

  // 旧版将原生退避强制为 3 秒；恢复上游计算的 retryDelaySeconds，避免同后台
  // 调度器在前台竞争。后台调度器会在 3 秒后先行处理。
  replace(
    /\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+),retryDelaySeconds:_rds\}=([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)=(?:3|_rds\?\?5)/g,
    "{conversationId:$1,hostId:$2,retryDelaySeconds:$4}=$3",
  );

  replace(
    /([a-zA-Z0-9_$]+)\?\.role!==`follower`/g,
    "$1?.role===`owner`",
  );

  // 恢复旧版前台 3 次熔断倒计时；本文件的后台调度器不使用它。
  replace(
    /if\(([a-zA-Z0-9_$]+)===0\)\{globalThis\.__codexAutoRetries=globalThis\.__codexAutoRetries\|\|new Map\(\);let _ar=globalThis\.__codexAutoRetries\.get\(([a-zA-Z0-9_$]+)\)\|\|\{count:0,time:0\};if\(Date\.now\(\)-_ar\.time>3e5\)_ar=\{count:0,time:Date\.now\(\)\};if\(_ar\.count<3\)\{_ar\.count\+\+;_ar\.time=Date\.now\(\);globalThis\.__codexAutoRetries\.set\(\2,_ar\);([a-zA-Z0-9_$]+)\(`capacity_retry_automatic`\)\}else\{([a-zA-Z0-9_$]+)\(null\)\}return\}\4\(\1\)/g,
    "if($1===0){$3(`capacity_retry_automatic`);return}$4($1)",
  );

  replace(
    /([a-zA-Z0-9_$]+)=\(\)=>\(globalThis\.__codexAutoRetries\?\.delete\(([a-zA-Z0-9_$]+)\),([a-zA-Z0-9_$]+)\(`capacity_retry_manual`\)\)/g,
    "$1=()=>$3(`capacity_retry_manual`)",
  );

  if (!modified) return { status: "already-patched", source };

  try {
    parseCode(patched);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  return { status: "patched", source: patched };
}

/**
 * app-initial 在 renderer 中运行。Electron 默认会节流非前台 renderer 的
 * setTimeout；只对承载会话的 primary 窗口关闭该策略，保证后台调度器准时运行。
 */
function patchMainSource(source) {
  if (source.includes(BACKGROUND_THROTTLING_MARKER)) {
    return { status: "already-patched", source };
  }

  const pattern =
    /backgroundThrottling:([a-zA-Z0-9_$]+)!==`avatarOverlay`&&void 0/;
  const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
  if (matches.length !== 1) {
    return {
      status: "unexpected-background-throttling-count",
      count: matches.length,
      source,
    };
  }

  const appearanceVar = matches[0][1];
  const patched = source.replace(
    pattern,
    `backgroundThrottling:${appearanceVar}===\`primary\`?!1:void 0/*${BACKGROUND_THROTTLING_MARKER}*/`,
  );

  try {
    parseCode(patched);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  return { status: "patched", source: patched };
}

/**
 * 构造插入 turn/completed 事件前的表达式。返回值以 && 结尾，使原有的
 * `streamRole !== follower && emitTurnCompleted(...)` 仍保留其短路语义。
 */
function buildBackgroundRetryExpression({ conversationId, manager, turn }) {
  return `(()=>{let _store=globalThis.${BACKGROUND_RETRY_MARKER}??(globalThis.${BACKGROUND_RETRY_MARKER}=new Map()),_old=_store.get(${conversationId});if(${turn}.status==="completed"){_old?.timer!=null&&clearTimeout(_old.timer),_store.delete(${conversationId});return!0}let _error=${turn}.error,_detail=String(_error?.codexErrorInfo??"")+" "+String(_error?.message??""),_retryable=${turn}.status==="failed"&&(_error?.codexErrorInfo==="serverOverloaded"||/currently experiencing high demand|server[ _-]?overload|temporary errors?|response(?:stream)?(?:connection)?(?:failed|disconnected)|connection failure|too many failed attempts/i.test(_detail));if(!_retryable||${manager}.getStreamRole(${conversationId})?.role!=="owner"||${manager}.turnCoordinator?.readHead?.(${conversationId})){_old?.timer!=null&&clearTimeout(_old.timer),_store.delete(${conversationId});return!0}if(_old?.turnId===${turn}.id)return!0;_old?.timer!=null&&clearTimeout(_old.timer);let _state={turnId:${turn}.id,attempt:(_old?.attempt??0)+1,timer:null},_delay=[3e3,5e3,1e4,2e4,3e4][Math.min(_state.attempt-1,4)],_schedule=()=>{_store.get(${conversationId})===_state&&(_state.timer=setTimeout(_run,_delay))},_run=async()=>{let _current=_store.get(${conversationId});if(_current!==_state)return;_current.timer=null;let _turn=${manager}.getTurn?.(${conversationId},_state.turnId);if((_turn?.status??${turn}.status)!=="failed"||${manager}.turnCoordinator?.readHead?.(${conversationId})){_store.get(${conversationId})===_state&&_store.delete(${conversationId});return}if(${manager}.getConversation(${conversationId})?.threadRuntimeStatus?.type==="active"){_schedule();return}try{await ${manager}.startEmptyTurn(${conversationId},{resumeSource:"executor",turnTrigger:"${DIRECT_RETRY_TRIGGER}"})}catch{}if(_store.get(${conversationId})!==_state)return;if((${manager}.getTurn?.(${conversationId},_state.turnId)?.status??${turn}.status)!=="failed"||${manager}.turnCoordinator?.readHead?.(${conversationId})){_store.delete(${conversationId});return}_schedule()};_store.set(${conversationId},_state),_schedule();return!0})()&&`;
}

function removeLegacyBackgroundRetry(source) {
  if (!source.includes(LEGACY_RETRY_MARKER)) return source;

  // 仅匹配本项目上一版生成的注入块；若上游结构发生变化则保留内容并让后续
  // 标记检查/解析显式失败，避免宽泛删除任意业务逻辑。
  return source.replace(
    /\([a-zA-Z0-9_$]+\.status===`completed`&&globalThis\.__codexAutoRetries\?\.delete\([a-zA-Z0-9_$]+\)\),\(\([a-zA-Z0-9_$]+\.status===`failed`\|\|[a-zA-Z0-9_$]+\.status===`error`\|\|\([a-zA-Z0-9_$]+\.status!==`completed`&&[a-zA-Z0-9_$]+\.status!==`interrupted`&&[a-zA-Z0-9_$]+\.error!=null\)\)&&!\([a-zA-Z0-9_$]+\.turnCoordinator\?\.readHead\?\.\([a-zA-Z0-9_$]+\)\)&&setTimeout\(async\(\)=>\{try\{globalThis\.__codexAutoRetries=globalThis\.__codexAutoRetries\|\|new Map\(\);[\s\S]*?\},3e3\)\),/g,
    "",
  );
}

/**
 * 注入后台重试调度器。这里在应用的全局消息处理器中运行，不依赖当前 React
 * 视图是否挂载，因此后台会话与失焦窗口都能继续调度。
 */
function patchInitialSource(source) {
  if (source.includes(BACKGROUND_RETRY_MARKER)) {
    return { status: "already-patched", source };
  }

  let patched = removeLegacyBackgroundRetry(source);

  // 新版 app-initial 将恢复来源硬编码为 view。executor 可让后台会话走执行器
  // 恢复链；旧版没有该参数时，额外 options 会被安全忽略。
  const emptyTurnPattern =
    /startEmptyTurn\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)\)\{return ([a-zA-Z0-9_$]+)\(\{conversationId:\1,manager:this,options:\2,resumeConversation:([a-zA-Z0-9_$]+)=>this\.#e\(\4,[`'"]view[`'"]\)/;
  const emptyTurnMatch = patched.match(emptyTurnPattern);
  if (emptyTurnMatch) {
    patched = patched.replace(
      emptyTurnMatch[0],
      `startEmptyTurn(${emptyTurnMatch[1]},${emptyTurnMatch[2]}){return ${emptyTurnMatch[3]}({conversationId:${emptyTurnMatch[1]},manager:this,options:${emptyTurnMatch[2]},resumeConversation:${emptyTurnMatch[4]}=>this.#e(${emptyTurnMatch[4]},${emptyTurnMatch[2]}?.resumeSource??\`view\`)`,
    );
  }

  const emitRegex =
    /([a-zA-Z0-9_$]+)\.events\.emitTurnCompleted\(\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+)\.getHostId\(\),status:([a-zA-Z0-9_$]+)\.status/;
  const emitMatch = patched.match(emitRegex);
  if (!emitMatch) {
    return { status: "not-found", source };
  }

  const [fullMatch, eventsVar, conversationId, manager, turn] = emitMatch;
  const injection = buildBackgroundRetryExpression({
    conversationId,
    manager,
    turn,
  });
  patched = patched.replace(fullMatch, `${injection}${fullMatch}`);

  try {
    parseCode(patched);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  return { status: "patched", source: patched };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );

  let patched = 0;
  let failed = 0;

  const primaryBundles = locateBundles({
    dir: "assets",
    pattern: /^app-primary-.*\.js$/,
    platform,
  });

  for (const bundle of primaryBundles) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const result = patchPrimarySource(source);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: native UI retry retained`);
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: legacy UI cleanup parse failed: ${result.error.message}`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [dry-run] ${label}: would remove legacy UI continuation input`);
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, result.source, "utf-8");
    console.log(`  [ok] ${label}: removed legacy UI continuation input`);
    patched++;
  }

  const initialBundles = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    platform,
  });

  for (const bundle of initialBundles) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const result = patchInitialSource(source);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: background direct retry already patched`);
      continue;
    }
    if (result.status === "not-found") {
      console.log(`  [x] ${label}: turn/completed anchor not found`);
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: background retry parse failed: ${result.error.message}`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [dry-run] ${label}: would patch background direct retry`);
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, result.source, "utf-8");
    console.log(`  [ok] ${label}: patched background direct retry`);
    patched++;
  }

  const mainBundles = locateBundles({
    dir: "build",
    pattern: /^main(?:-.*)?\.js$/,
    platform,
  });

  for (const bundle of mainBundles) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const result = patchMainSource(source);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: primary-window background timer policy already patched`);
      continue;
    }
    if (result.status === "unexpected-background-throttling-count") {
      console.log(
        `  [x] ${label}: primary-window background timer anchor count is ${result.count}`,
      );
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: background timer parse failed: ${result.error.message}`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [dry-run] ${label}: would disable primary-window background throttling`);
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, result.source, "utf-8");
    console.log(`  [ok] ${label}: disabled primary-window background throttling`);
    patched++;
  }

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  BACKGROUND_RETRY_MARKER,
  BACKGROUND_THROTTLING_MARKER,
  DIRECT_RETRY_TRIGGER,
  LEGACY_CONTINUATION_INPUT,
  buildBackgroundRetryExpression,
  patchInitialSource,
  patchMainSource,
  patchPrimarySource,
};
