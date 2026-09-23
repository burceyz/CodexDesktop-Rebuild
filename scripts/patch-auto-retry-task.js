#!/usr/bin/env node
/**
 * patch-auto-retry-task.js — 在后台直接重试暂时性服务过载/限流失败的轮次。
 *
 * 设计：
 * - 调度器注入 app-initial 的 turn/completed 处理链，而不是 React 错误卡片；
 *   因此切换会话、最小化窗口或窗口失焦都不会取消重试。轮次只有在 CLI 内部
 *   “正在重新连接 N/N”全部失败后才会以 failed 结束，所以重试总在重连耗尽之后。
 * - 过载与连接类错误：每 3 秒调用 startEmptyTurn，保留原会话上下文且 input 为空，
 *   不发送用户消息。
 * - 限流（rateLimitExceeded）：每 30 秒重试一次，避免持续撞限额。同一条失败链
 *   第一次重试以“继续按照要求执行任务”作为输入，之后的重试沿用这条消息直接重跑
 *   空轮次，不会刷屏。
 * - 不处理额度、权限或用户主动中断。结构体形式的 codexErrorInfo 按变体名参与匹配。
 * - 每个会话只有一个定时器；成功、手动新轮次或有排队消息时均会自然取消，
 *   不存在需要人工解锁的固定次数上限。
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
const BACKGROUND_RETRY_DELAY_MS = 3e3;
const RATE_LIMIT_RETRY_DELAY_MS = 3e4;
const RATE_LIMIT_CONTINUATION_TEXT = "继续按照要求执行任务";
// 已注入的调度器：捕获 conversationId、turn、manager，用于原地升级旧版本。
const INJECTED_RETRY_PATTERN =
  /\(\(\)=>\{let _store=globalThis\.__codexDirectRetryState\?\?\(globalThis\.__codexDirectRetryState=new Map\(\)\),_old=_store\.get\(([a-zA-Z0-9_$]+)\);if\(([a-zA-Z0-9_$]+)\.status==="completed"\)[\s\S]*?([a-zA-Z0-9_$]+)\.getStreamRole\(\1\)[\s\S]*?_store\.set\(\1,_state\),_schedule\(\);return!0\}\)\(\)&&/;
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
  if (
    !source.includes(LEGACY_RETRY_MARKER) &&
    !source.includes("继续未完成的工作")
  ) {
    return { status: "already-patched", source };
  }

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
  const patchedPattern = new RegExp(
    `backgroundThrottling:([a-zA-Z0-9_$]+)===\\\`primary\\\`\\?!1:void 0/\\*${BACKGROUND_THROTTLING_MARKER}\\*/`,
  );
  const patchedMatches = [...source.matchAll(new RegExp(patchedPattern.source, "g"))];
  if (patchedMatches.length > 0) {
    if (patchedMatches.length !== 1) {
      return {
        status: "unexpected-background-throttling-count",
        count: patchedMatches.length,
        source,
      };
    }

    // 升级本补丁的早期版本：保留上游 avatarOverlay 本来就有的豁免。
    const appearanceVar = patchedMatches[0][1];
    const upgraded = source.replace(
      patchedPattern,
      `backgroundThrottling:(${appearanceVar}===\`primary\`||${appearanceVar}===\`avatarOverlay\`)?!1:void 0/*${BACKGROUND_THROTTLING_MARKER}*/`,
    );
    try {
      parseCode(upgraded);
    } catch (error) {
      return { status: "parse-failed", error, source };
    }
    return { status: "patched", source: upgraded };
  }

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
    `backgroundThrottling:(${appearanceVar}===\`primary\`||${appearanceVar}===\`avatarOverlay\`)?!1:void 0/*${BACKGROUND_THROTTLING_MARKER}*/`,
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
  const c = conversationId;
  const m = manager;
  const t = turn;
  const continuation = `[{type:"text",text:${JSON.stringify(RATE_LIMIT_CONTINUATION_TEXT)},text_elements:[]}]`;
  return (
    `(()=>{let _store=globalThis.${BACKGROUND_RETRY_MARKER}??(globalThis.${BACKGROUND_RETRY_MARKER}=new Map()),_old=_store.get(${c});` +
    `if(${t}.status==="completed"){_old?.timer!=null&&clearTimeout(_old.timer),_store.delete(${c});return!0}` +
    // 结构体错误码（如 {responseStreamDisconnected:{...}}）取变体名参与匹配。
    `let _error=${t}.error,_info=_error?.codexErrorInfo,_code=_info!=null&&typeof _info==="object"?Object.keys(_info)[0]:_info,` +
    `_detail=String(_code??"")+" "+String(_error?.message??""),` +
    `_rateLimited=${t}.status==="failed"&&(_code==="rateLimitExceeded"||/rate limit exceeded/i.test(_detail)),` +
    `_retryable=_rateLimited||${t}.status==="failed"&&(_code==="serverOverloaded"||/currently experiencing high demand|server[ _-]?overload|temporary errors?|response(?:stream)?(?:connection)?(?:failed|disconnected)|connection failure|too many failed attempts/i.test(_detail));` +
    `if(!_retryable||${m}.getStreamRole(${c})?.role!=="owner"||${m}.turnCoordinator?.readHead?.(${c})){_old?.timer!=null&&clearTimeout(_old.timer),_store.delete(${c});return!0}` +
    `if(_old?.turnId===${t}.id)return!0;_old?.timer!=null&&clearTimeout(_old.timer);` +
    // prompted 沿失败链继承：续接文本已在历史中时，后续重试只需重跑空轮次。
    `let _state={turnId:${t}.id,timer:null,prompted:_old?.prompted===!0},_delay=_rateLimited?${RATE_LIMIT_RETRY_DELAY_MS}:${BACKGROUND_RETRY_DELAY_MS},` +
    `_schedule=()=>{_store.get(${c})===_state&&(_state.timer=setTimeout(_run,_delay))},` +
    `_run=async()=>{let _current=_store.get(${c});if(_current!==_state)return;_current.timer=null;` +
    `let _turn=${m}.getTurn?.(${c},_state.turnId);` +
    `if((_turn?.status??${t}.status)!=="failed"||${m}.turnCoordinator?.readHead?.(${c})){_store.get(${c})===_state&&_store.delete(${c});return}` +
    `if(${m}.getConversation(${c})?.threadRuntimeStatus?.type==="active"){_schedule();return}` +
    `let _prompt=_rateLimited&&!_state.prompted,_options={resumeSource:"executor",turnTrigger:"${DIRECT_RETRY_TRIGGER}"};` +
    `_prompt&&(_state.prompted=!0,_options.continuationInput=${continuation});` +
    `try{await ${m}.startEmptyTurn(${c},_options)}catch{_prompt&&(_state.prompted=!1)}` +
    `if(_store.get(${c})!==_state)return;` +
    `if((${m}.getTurn?.(${c},_state.turnId)?.status??${t}.status)!=="failed"||${m}.turnCoordinator?.readHead?.(${c})){_store.delete(${c});return}` +
    `_schedule()};` +
    `_store.set(${c},_state),_schedule();return!0})()&&`
  );
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
 * 已注入过的 bundle：用原来的变量名重新生成调度器并原地替换，使旧版本
 * （递增退避、不识别限流等）直接升级；内容一致时视为已打补丁。
 */
function upgradeBackgroundRetry(source) {
  const matches = [
    ...source.matchAll(new RegExp(INJECTED_RETRY_PATTERN.source, "g")),
  ];
  if (matches.length !== 1) {
    return {
      status: "unexpected-retry-injection-count",
      count: matches.length,
      source,
    };
  }

  const [block, conversationId, turn, manager] = matches[0];
  const next = buildBackgroundRetryExpression({ conversationId, manager, turn });
  if (next === block) {
    return { status: "already-patched", source };
  }

  const start = matches[0].index;
  const upgraded =
    source.slice(0, start) + next + source.slice(start + block.length);
  try {
    parseCode(upgraded);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }
  return { status: "patched", source: upgraded };
}

/**
 * 注入后台重试调度器。这里在应用的全局消息处理器中运行，不依赖当前 React
 * 视图是否挂载，因此后台会话与失焦窗口都能继续调度。
 */
function patchInitialSource(source) {
  if (source.includes(BACKGROUND_RETRY_MARKER)) {
    return upgradeBackgroundRetry(source);
  }

  let patched = removeLegacyBackgroundRetry(source);
  if (patched.includes(LEGACY_RETRY_MARKER)) {
    return { status: "legacy-cleanup-not-found", source };
  }

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
    if (result.status === "legacy-cleanup-not-found") {
      console.log(`  [x] ${label}: legacy background retry cleanup anchor not found`);
      failed++;
      continue;
    }
    if (result.status === "unexpected-retry-injection-count") {
      console.log(`  [x] ${label}: injected retry scheduler count is ${result.count}`);
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
  BACKGROUND_RETRY_DELAY_MS,
  DIRECT_RETRY_TRIGGER,
  LEGACY_CONTINUATION_INPUT,
  RATE_LIMIT_CONTINUATION_TEXT,
  RATE_LIMIT_RETRY_DELAY_MS,
  buildBackgroundRetryExpression,
  patchInitialSource,
  patchMainSource,
  patchPrimarySource,
};
