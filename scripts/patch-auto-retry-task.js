#!/usr/bin/env node
/**
 * patch-auto-retry-task.js — 服务过载（429 / serverOverloaded）失败后自动发送“继续未完成的工作”进行新一轮重试
 *
 * 背景：
 * 当 Codex 轮次遭遇官方服务容量瓶颈（serverOverloaded / 429）并在尝试 5 次重连均失败后，
 * 轮次状态变为 failed，并在界面上呈现错误提示卡片。
 * 原生代码中实际上内置了倒计时自动重试组件（j3n / LDr），但因受到 Statsig Gate `2899820207`
 * 以及服务端未返回 `retryDelaySeconds`（导致值为 null）的阻断，自动倒计时从未被激活。
 *
 * 修复与增强：
 * 1. 默认延迟：当 `retryDelaySeconds` 为 null/undefined 时，默认赋予 5 秒退避倒计时。
 * 2. 激活原生倒计时：绕过 Gate `2899820207`（强制为 true），激活原生进度条倒计时组件（S3n / ODr）。
 * 3. 注入延续提示语：在倒计时结束或手动点击重试派发新轮次时，注入 `continuationInput`：
 *    [{ type: "text", text: "继续未完成的工作", text_elements: [] }]
 *    使模型无缝接续上文未完成的任务。
 * 4. 防死循环熔断机制：在自动重试触发时，通过全局状态检查当前会话的连续自动重试次数。
 *    若在 5 分钟内连续自动重试达到 3 次，将停止自动倒计时（转为静态重试按钮），防止服务宕机或欠费导致的无限死循环；
 *    用户手动点击重试时将重置连续计数。
 *
 * 锚点：
 * 1. 门禁：`o=X(cC,'2899820207')`
 * 2. 参数解构：`{conversationId:n,hostId:r,retryDelaySeconds:i}=e`
 * 3. 调度函数：`ife(a,r,n,{turnTrigger:e,collaborationMode:c})`
 * 4. 自动触发：`if(e===0){_('capacity_retry_automatic');return}f(e)`
 * 5. 手动触发：`b=()=>_('capacity_retry_manual')`
 *
 * Usage:
 *   node scripts/patch-auto-retry-task.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-auto-retry-task.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const GATE_REGEX =
  /([a-zA-Z0-9_$]+)=([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),[`'"]2899820207[`'"]\)/;

const DESTR_REGEX =
  /\{conversationId:([a-zA-Z0-9_$]+),hostId:([a-zA-Z0-9_$]+),retryDelaySeconds:([a-zA-Z0-9_$]+)\}=([a-zA-Z0-9_$]+)/;

const DISPATCH_REGEX =
  /([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+),([a-zA-Z0-9_$]+),\{turnTrigger:([a-zA-Z0-9_$]+),collaborationMode:([a-zA-Z0-9_$]+)\}\)/;

const AUTO_RETRY_REGEX =
  /if\(([a-zA-Z0-9_$]+)===0\)\{([a-zA-Z0-9_$]+)\([`'"]capacity_retry_automatic[`'"]\);return\}([a-zA-Z0-9_$]+)\(\1\)/;

const MANUAL_RETRY_REGEX =
  /([a-zA-Z0-9_$]+)=\(\)=>([a-zA-Z0-9_$]+)\([`'"]capacity_retry_manual[`'"]\)/;

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
}

function patchSource(source) {
  if (
    source.includes("globalThis.__codexAutoRetries") &&
    source.includes("继续未完成的工作")
  ) {
    return { status: "already-patched", source };
  }

  const gateMatch = source.match(GATE_REGEX);
  const destrMatch = source.match(DESTR_REGEX);
  const dispatchMatch = source.match(DISPATCH_REGEX);
  const autoRetryMatch = source.match(AUTO_RETRY_REGEX);
  const manualRetryMatch = source.match(MANUAL_RETRY_REGEX);

  if (
    !gateMatch ||
    !destrMatch ||
    !dispatchMatch ||
    !autoRetryMatch ||
    !manualRetryMatch
  ) {
    return {
      status: "not-found",
      details: {
        gateMatch: !!gateMatch,
        destrMatch: !!destrMatch,
        dispatchMatch: !!dispatchMatch,
        autoRetryMatch: !!autoRetryMatch,
        manualRetryMatch: !!manualRetryMatch,
      },
      source,
    };
  }

  const [dFull, convVar, hostVar, rdsVar, paramVar] = destrMatch;
  const [gFull, gVar] = gateMatch;
  const [dispFull, fnCall, argA, argR, argN, tTrigger, cMode] = dispatchMatch;
  const [arFull, secVar, fnRetry, fnSetSec] = autoRetryMatch;
  const [manFull, manVar, manFn] = manualRetryMatch;

  let patched = source;

  // 1. 默认赋予 5 秒重试倒计时
  patched = patched.replace(
    dFull,
    `{conversationId:${convVar},hostId:${hostVar},retryDelaySeconds:_rds}=${paramVar},${rdsVar}=_rds??5`,
  );

  // 2. 绕过 Gate 门禁，激活原生重试组件
  patched = patched.replace(gFull, `${gVar}=!0`);

  // 3. 注入延续指令：“继续未完成的工作”
  patched = patched.replace(
    dispFull,
    `${fnCall}(${argA},${argR},${argN},{turnTrigger:${tTrigger},collaborationMode:${cMode},continuationInput:[{type:\`text\`,text:\`继续未完成的工作\`,text_elements:[]}]})`,
  );

  // 4. 自动倒计时触发时的防死循环连续重试限制（最多 3 轮，5 分钟超时重置）
  patched = patched.replace(
    arFull,
    `if(${secVar}===0){globalThis.__codexAutoRetries=globalThis.__codexAutoRetries||new Map();let _ar=globalThis.__codexAutoRetries.get(${convVar})||{count:0,time:0};if(Date.now()-_ar.time>3e5)_ar={count:0,time:Date.now()};if(_ar.count<3){_ar.count++;_ar.time=Date.now();globalThis.__codexAutoRetries.set(${convVar},_ar);${fnRetry}(\`capacity_retry_automatic\`)}else{${fnSetSec}(null)}return}${fnSetSec}(${secVar})`,
  );

  // 5. 手动重试时清空连续失败重试计数
  patched = patched.replace(
    manFull,
    `${manVar}=()=>(globalThis.__codexAutoRetries?.delete(${convVar}),${manFn}(\`capacity_retry_manual\`))`,
  );

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
      console.log(
        `  [x] ${label}: auto-retry anchors not found: ${JSON.stringify(result.details)}`,
      );
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
