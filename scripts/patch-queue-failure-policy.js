#!/usr/bin/env node
/**
 * patch-queue-failure-policy.js — 放宽轮次失败后排队消息的自动出队门禁
 *
 * 背景：
 * Codex 在轮次因服务过载（429 / serverOverloaded 等）耗尽 5 次重连重试后，
 * 会将轮次标记为 failed。在新版 upstream 中，排队出队门禁函数（B1t / bdn）硬编码了：
 *   n.status !== 'completed' || !n.items.some(...)
 * 导致失败轮次发生后，队列中的后续排队任务（例如多个“继续执行任务”）被静默阻断，
 * 无法像旧版一样自动顺延启动。
 *
 * 修复：
 * 移除对 `status !== 'completed'` 的限制，恢复旧版行为：
 * 只要当前没有正在运行的轮次（n?.status !== 'inProgress'）且未被手动中断（!r.pausedReason），
 * 队列即自动向后调度消费下一条消息。
 *
 * 锚点：
 * 匹配函数入参 `{conversationNeedsResume:...,hasConversation:...,latestTurn:...,message:...,streamRole:...}`
 *
 * Usage:
 *   node scripts/patch-queue-failure-policy.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-queue-failure-policy.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const PATTERN =
  /function\s+([a-zA-Z0-9_$]+)\(\{conversationNeedsResume:([a-zA-Z0-9_$]+),hasConversation:([a-zA-Z0-9_$]+),latestTurn:([a-zA-Z0-9_$]+),message:([a-zA-Z0-9_$]+),streamRole:([a-zA-Z0-9_$]+)\}\)\{return\s+([^}]+)\}/;

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
}

function patchSource(source) {
  const match = source.match(PATTERN);
  if (!match) {
    return { status: "not-found", source };
  }

  const [fullMatch, fnName, pResume, pHasConv, pTurn, pMsg, pRole, oldBody] = match;

  const targetBody = `${pMsg}.pausedReason||!${pHasConv}||${pRole}?.role===\`follower\`||${pTurn}?.status===\`inProgress\`?!0:!1`;

  if (oldBody === targetBody) {
    return { status: "already-patched", source };
  }

  const newFunc = `function ${fnName}({conversationNeedsResume:${pResume},hasConversation:${pHasConv},latestTurn:${pTurn},message:${pMsg},streamRole:${pRole}}){return ${targetBody}}`;

  const nextSource = source.replace(fullMatch, newFunc);

  try {
    parseCode(nextSource);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  return { status: "patched", source: nextSource, fnName };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.log("  [skip] app-initial bundle not found");
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
      console.log(`  [x] ${label}: queue failure policy anchor not found`);
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: parse validation failed (${result.error.message})`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [?] ${label}: would relax queue failure policy in function ${result.fnName}`);
    } else {
      fs.writeFileSync(bundle.path, result.source, "utf-8");
      console.log(`  [ok] ${label}: queue failure policy relaxed in function ${result.fnName}`);
    }
    patched++;
  }

  console.log(`  [done] ${isCheck ? "would patch" : "patched"} ${patched} file(s)`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { PATTERN, patchSource };
