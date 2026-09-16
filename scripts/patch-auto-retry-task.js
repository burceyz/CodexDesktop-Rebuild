#!/usr/bin/env node
/**
 * patch-auto-retry-task.js — 任务失败后自动发送“继续未完成的工作”进行新一轮重试（支持前后台会话）
 *
 * 背景：
 * 当 Codex 轮次遭遇官方服务容量瓶颈（如“We're currently experiencing high demand...”）并在 5 次重试均失败后，
 * 轮次状态变为 failed。
 *
 * 两层架构支持：
 * 1. 【UI 层 / app-primary】：在前台打开的对话中，展示 3 秒倒计时与动态进度条按钮，倒计时归零自动触发，
 *    并提供手动点击重试入口（清零计数器）。
 * 2. 【服务层 / app-initial】：在核心消息事件系统（turn/completed）中，不论用户当前停留在哪个对话、
 *    或者已切换至其他对话乃至最小化窗口，只要后台任意会话失败且队列中无用户待发送消息，
 *    自动在 3 秒退避后调用 `startEmptyTurn` 发送“继续未完成的工作”，确保无人值守挂机可靠执行。
 *
 * Usage:
 *   node scripts/patch-auto-retry-task.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-auto-retry-task.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
}

/**
 * 补丁 1：UI 前台层（app-primary）
 */
function patchPrimarySource(source) {
  if (
    source.includes(".errorInfo!=`usageLimitExceeded`&&") &&
    source.includes("retryDelaySeconds:_rds") &&
    source.includes("continuationInput") &&
    source.includes("globalThis.__codexAutoRetries") &&
    !source.includes(".get(qi,{hostId:")
  ) {
    return { status: "already-patched", source };
  }

  let patched = source;
  let modified = false;

  // 1. 放宽 D3n 错误卡片入口门禁 (对所有非 usageLimitExceeded 的失败轮次卡片激活 A3n)
  const d3nRegex =
    /([a-zA-Z0-9_$]+)\.errorInfo===`serverOverloaded`&&([a-zA-Z0-9_$]+)!=null/;
  const d3nMatch = patched.match(d3nRegex);
  if (d3nMatch) {
    patched = patched.replace(
      d3nMatch[0],
      `${d3nMatch[1]}.errorInfo!=\`usageLimitExceeded\`&&${d3nMatch[2]}!=null`,
    );
    modified = true;
  }

  // 2. 移除 A3n 中可能阻断的 l!=='ready' 检查（Mac 版特有）
  const a3nRegex =
    /if\(([a-zA-Z0-9_$]+)!==`ready`\|\|([a-zA-Z0-9_$]+==null\|\|[a-zA-Z0-9_$]+!==[a-zA-Z0-9_$]+\|\|[a-zA-Z0-9_$]+!==`failed`)\)/;
  const a3nMatch = patched.match(a3nRegex);
  if (a3nMatch) {
    patched = patched.replace(a3nMatch[0], `if(${a3nMatch[2]})`);
    modified = true;
  }

  // 2.1 移除 g 内部的 qi!=='ready' 检查（使 Mac 版与 Windows 保持一致）
  const qiInGRegex =
    /[a-zA-Z0-9_$]+\.get\([a-zA-Z0-9_$]+,\{hostId:[a-zA-Z0-9_$]+,threadId:[a-zA-Z0-9_$]+\}\)!==`ready`\|\|/;
  const qiInGMatch = patched.match(qiInGRegex);
  if (qiInGMatch) {
    patched = patched.replace(qiInGMatch[0], "");
    modified = true;
  }

  // 3. 绕过 Gate 2899820207 门禁
  const gateRegex =
    /([a-zA-Z0-9_$]+)=([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),[`'"]2899820207[`'"]\)/;
  const gateMatch = patched.match(gateRegex);
  if (gateMatch) {
    patched = patched.replace(gateMatch[0], `${gateMatch[1]}=!0`);
    modified = true;
  }

  // 4. 重试延迟缩减至 3 秒
  const destrAlreadyRegex =
    /\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+),retryDelaySeconds:_rds\}=([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)=(?:_rds\?\?5|\d+)/;
  const destrCleanRegex =
    /\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+),retryDelaySeconds:(?!_rds\b)([a-zA-Z0-9_$]+)\}=([a-zA-Z0-9_$]+)/;

  const mAlready = patched.match(destrAlreadyRegex);
  const mClean = patched.match(destrCleanRegex);

  if (mAlready) {
    if (mAlready[4] !== "3") {
      patched = patched.replace(
        mAlready[0],
        `{conversationId:${mAlready[1]},hostId:${mAlready[2]},retryDelaySeconds:_rds}=${mAlready[3]},${mAlready[4]}=3`,
      );
      modified = true;
    }
  } else if (mClean) {
    patched = patched.replace(
      mClean[0],
      `{conversationId:${mClean[1]},hostId:${mClean[2]},retryDelaySeconds:_rds}=${mClean[4]},${mClean[3]}=3`,
    );
    modified = true;
  }

  const convMatch = patched.match(
    /\{conversationId:([a-zA-Z0-9_$]+),hostId:[a-zA-Z0-9_$]+,retryDelaySeconds:_rds\}/,
  );
  const convVar = convMatch ? convMatch[1] : "n";

  // 5. 放宽角色校验：s?.role !== 'follower'
  const roleRegex = /([a-zA-Z0-9_$]+)\?\.role===`owner`/;
  const roleMatch = patched.match(roleRegex);
  if (roleMatch) {
    patched = patched.replace(roleMatch[0], `${roleMatch[1]}?.role!==\`follower\``);
    modified = true;
  }

  // 6. 注入延续提示语：“继续未完成的工作”
  const dispatchRegex =
    /([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+),\{turnTrigger:([a-zA-Z0-9_$]+),collaborationMode:([a-zA-Z0-9_$]+)\}\)/;
  const dispatchMatch = patched.match(dispatchRegex);
  if (dispatchMatch) {
    patched = patched.replace(
      dispatchMatch[0],
      `${dispatchMatch[1]}(${dispatchMatch[2]},${dispatchMatch[3]},${dispatchMatch[4]},{turnTrigger:${dispatchMatch[5]},collaborationMode:${dispatchMatch[6]},continuationInput:[{type:\`text\`,text:\`继续未完成的工作\`,text_elements:[]}]})`,
    );
    modified = true;
  }

  // 7. 自动倒计时触发与防死循环连续重试限制
  const autoRetryRegex =
    /if\(([a-zA-Z0-9_$]+)===0\)\{([a-zA-Z0-9_$]+)\([`'"]capacity_retry_automatic[`'"]\);return\}([a-zA-Z0-9_$]+)\(\1\)/;
  const autoRetryMatch = patched.match(autoRetryRegex);
  if (autoRetryMatch) {
    const [arFull, secVar, fnRetry, fnSetSec] = autoRetryMatch;
    patched = patched.replace(
      arFull,
      `if(${secVar}===0){globalThis.__codexAutoRetries=globalThis.__codexAutoRetries||new Map();let _ar=globalThis.__codexAutoRetries.get(${convVar})||{count:0,time:0};if(Date.now()-_ar.time>3e5)_ar={count:0,time:Date.now()};if(_ar.count<3){_ar.count++;_ar.time=Date.now();globalThis.__codexAutoRetries.set(${convVar},_ar);${fnRetry}(\`capacity_retry_automatic\`)}else{${fnSetSec}(null)}return}${fnSetSec}(${secVar})`,
    );
    modified = true;
  }

  // 8. 手动重试时重置连续计数
  const manualRetryRegex =
    /([a-zA-Z0-9_$]+)=\(\)=>([a-zA-Z0-9_$]+)\([`'"]capacity_retry_manual[`'"]\)/;
  const manualRetryMatch = patched.match(manualRetryRegex);
  if (manualRetryMatch) {
    patched = patched.replace(
      manualRetryMatch[0],
      `${manualRetryMatch[1]}=()=>(globalThis.__codexAutoRetries?.delete(${convVar}),${manualRetryMatch[2]}(\`capacity_retry_manual\`))`,
    );
    modified = true;
  }

  if (!modified) {
    return { status: "already-patched", source: patched };
  }

  try {
    parseCode(patched);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  return { status: "patched", source: patched };
}

/**
 * 补丁 2：服务后台层（app-initial）
 * 监听全局 turn/completed 事件，对话在后台切出时也能自动继续
 */
function patchInitialSource(source) {
  if (
    source.includes("globalThis.__codexAutoRetries") &&
    source.includes("resumeSource:`executor`")
  ) {
    return { status: "already-patched", source };
  }

  let patched = source;

  // 1. 清理旧版本注入（如果存在）
  const oldInjectionRegex =
    /[a-zA-Z0-9_$]+\.getStreamRole\([a-zA-Z0-9_$]+\)\?\.role!==`follower`&&\(s\.status===`failed`&&!_&&setTimeout\(async\(\)=>\{[\s\S]*?\},3e3\)\),/g;
  patched = patched.replace(oldInjectionRegex, "");

  // 2. 增强 startEmptyTurn 支持 resumeSource (Mac 平台)
  const emptyTurnPattern =
    /startEmptyTurn\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+)\)\{return ([a-zA-Z0-9_$]+)\(\{conversationId:\1,manager:this,options:\2,resumeConversation:([a-zA-Z0-9_$]+)=>this\.#e\(\4,[`'"]view[`'"]\)/;
  const mEmpty = patched.match(emptyTurnPattern);
  if (mEmpty) {
    patched = patched.replace(
      mEmpty[0],
      `startEmptyTurn(${mEmpty[1]},${mEmpty[2]}){return ${mEmpty[3]}({conversationId:${mEmpty[1]},manager:this,options:${mEmpty[2]},resumeConversation:${mEmpty[4]}=>this.#e(${mEmpty[4]},${mEmpty[2]}?.resumeSource??\`view\`)`,
    );
  }

  // 3. 在 turn/completed 事件处理末尾注入可靠的后台自动重试
  const emitRegex =
    /([a-zA-Z0-9_$]+)\.events\.emitTurnCompleted\(\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+)\.getHostId\(\),status:([a-zA-Z0-9_$]+)\.status/;
  const mEmit = patched.match(emitRegex);
  if (!mEmit) {
    return { status: "not-found", source: patched };
  }

  const [fullMatch, eventsVar, convVar, mgrVar, turnVar] = mEmit;

  // 注入逻辑：
  // 1) 轮次成功完成时清空连续重试计数
  // 2) 失败/错误且无排队消息时，3 秒后在后台通过 startEmptyTurn 调度重试，以 'executor' 身份唤醒会话（彻底免受窗口失焦或非前台阻断）
  const injection = `(${turnVar}.status===\`completed\`&&globalThis.__codexAutoRetries?.delete(${convVar})),((${turnVar}.status===\`failed\`||${turnVar}.status===\`error\`||(${turnVar}.status!==\`completed\`&&${turnVar}.status!==\`interrupted\`&&${turnVar}.error!=null))&&!(${mgrVar}.turnCoordinator?.readHead?.(${convVar}))&&setTimeout(async()=>{try{globalThis.__codexAutoRetries=globalThis.__codexAutoRetries||new Map();let _ar=globalThis.__codexAutoRetries.get(${convVar})||{count:0,time:0};if(Date.now()-_ar.time>3e5)_ar={count:0,time:Date.now()};if(_ar.count<3){_ar.count++;_ar.time=Date.now();globalThis.__codexAutoRetries.set(${convVar},_ar);await ${mgrVar}.startEmptyTurn(${convVar},{resumeSource:\`executor\`,turnTrigger:\`capacity_retry_automatic\`,continuationInput:[{type:\`text\`,text:\`继续未完成的工作\`,text_elements:[]}]})}}catch(e){}},3e3)),`;

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
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  let patched = 0;
  let failed = 0;

  // 1. 打 UI 层（app-primary）
  const primaryBundles = locateBundles({
    dir: "assets",
    pattern: /^app-primary-.*\.js$/,
    platform,
  });

  for (const bundle of primaryBundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const result = patchPrimarySource(code);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched (UI layer)`);
      continue;
    }
    if (result.status === "not-found") {
      console.log(`  [x] ${label}: auto-retry anchors not found (UI layer)`);
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(
        `  [x] ${label}: parse failed (UI layer): ${result.error.message}`,
      );
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [dry-run] ${label}: would patch auto-retry UI policy`);
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, result.source, "utf-8");
    console.log(`  [ok] ${label}: patched auto-retry UI policy`);
    patched++;
  }

  // 2. 打后台服务层（app-initial）
  const initialBundles = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    platform,
  });

  for (const bundle of initialBundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const result = patchInitialSource(code);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched (Background service layer)`);
      continue;
    }
    if (result.status === "not-found") {
      console.log(
        `  [x] ${label}: turn/completed anchor not found (Background service layer)`,
      );
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(
        `  [x] ${label}: parse failed (Background service layer): ${result.error.message}`,
      );
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(
        `  [dry-run] ${label}: would patch background auto-retry service`,
      );
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, result.source, "utf-8");
    console.log(`  [ok] ${label}: patched background auto-retry service`);
    patched++;
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
