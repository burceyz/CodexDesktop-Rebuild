#!/usr/bin/env node
/**
 * patch-auto-retry-task.js — 任务失败后自动发送“继续未完成的工作”进行新一轮重试
 *
 * 背景：
 * 当 Codex 轮次遭遇官方服务容量瓶颈（如“We're currently experiencing high demand...”）并在 5 次重试均失败后，
 * 轮次状态变为 failed。官方客户端原生自带倒计时重试组件（A3n/j3n），但存在以下阻断：
 * 1. 错误卡片入口门禁：D3n 组件仅对 a.errorInfo === 'serverOverloaded' 调用 A3n，而实际高负载或流断开时
 *    服务端下发的 errorInfo 往往为 null 或未定义，导致直接回退为无重试按钮的普通错误卡片。
 * 2. 线程状态门禁：A3n 中检查了 l === 'ready'，若流断开后状态未完全转为 ready 会被拦截。
 * 3. 延迟与 Gate 门禁：j3n 中受 Gate 2899820207 限制，且服务端未下发 retryDelaySeconds。
 * 4. 用户角色门禁：j3n 中硬编码了 s?.role === 'owner'。
 *
 * 修复与增强：
 * 1. 放宽错误卡片门禁：除账号额度耗尽（usageLimitExceeded）外，其余所有附带 turnId 的轮次失败错误卡片均进入 A3n 重试体系。
 * 2. 移除冗余 ready 校验：轮次只要为 failed 且为当前最新轮次，即激活重试倒计时。
 * 3. 缩减重试等待时长：延迟缩减设置为 3 秒（实现更快速的自动续跑）。
 * 4. 激活官方原生重试组件：强制绕过 Gate 2899820207，放宽角色限制（s?.role !== 'follower'）。
 * 5. 注入自动接续消息：倒计时归零时自动通过 startEmptyTurn 发送：
 *    continuationInput: [{ type: "text", text: "继续未完成的工作", text_elements: [] }]
 * 6. 防死循环熔断保护：5 分钟内最多允许自动连续重试 3 轮，达到上限后停止自动倒计时，保留手动重试按钮。
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

function patchSource(source) {
  if (
    source.includes(".errorInfo!=`usageLimitExceeded`&&") &&
    source.includes("retryDelaySeconds:_rds") &&
    source.includes("continuationInput") &&
    source.includes("globalThis.__codexAutoRetries")
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

  // 获取 conversationId 变量名以便传给计数器
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
    // 检查是否所有要点都已经就绪
    if (
      patched.includes(".errorInfo!=`usageLimitExceeded`&&") &&
      patched.includes("continuationInput") &&
      patched.includes("globalThis.__codexAutoRetries")
    ) {
      return { status: "already-patched", source: patched };
    }
    return { status: "not-found", source: patched };
  }

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

  const bundles = locateBundles({
    dir: "assets",
    pattern: /^app-primary-.*\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.log("  [skip] app-primary bundle not found");
    return;
  }

  let patched = 0;
  let failed = 0;

  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const result = patchSource(code);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }
    if (result.status === "not-found") {
      console.log(`  [x] ${label}: auto-retry anchors not found`);
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: parse failed: ${result.error.message}`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [dry-run] ${label}: would patch auto-retry task policy`);
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, result.source, "utf-8");
    console.log(`  [ok] ${label}: patched auto-retry task policy`);
    patched++;
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
