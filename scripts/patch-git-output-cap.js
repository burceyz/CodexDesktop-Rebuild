#!/usr/bin/env node
/**
 * patch-git-output-cap.js — git 执行器输出兜底上限 32MB（治本）
 *
 * 背景：2026-07-04 23:07 第三次崩溃，V3 任务归因直接点名 review-summary：
 * 两个并行任务 60 秒把 worker 堆从 13MB 推到 718MB（old_space 359MB +
 * large_object_space 348MB），随后 V8 共享指针压缩 cage 连续段分配失败，
 * 进程主动 OOM crash（commit 仅 1.7GB，系统内存充足）。
 * 触发场景：用户授权 Codex 扫描 C 盘后跑 review。
 *
 * 根因：worker.js 的 git 执行器 $ 支持 maxOutputBytes（超限 kill 并报
 * outputLimitExceeded），但大量调用点没传上限，其中 review-summary 路径的
 * `git ls-files --others`（枚举全部未跟踪文件）对超大目录会产出几百 MB
 * 的单条 stdout 巨串，再 split 出百万级路径数组——堆瞬间爆炸。
 *
 * 修复：给 $ 的 maxOutputBytes 解构加默认值 32MB：
 *   maxOutputBytes:l  ->  maxOutputBytes:l=33554432
 * 一处改动覆盖所有未传上限的调用点。显式传值的调用（diff 8MB、
 * cat-file 5MB、turn-diff 1MB）不受影响。正常仓库 ls-files 输出仅几 MB，
 * 完全无感；病态场景（扫盘）命令被截停，走现成的 success:false 错误路径，
 * 任务报错但应用不死。
 *
 * 锚点：`maxOutputBytes:<变量>,collectOutput:<变量>=!0`（每个 bundle 内唯一）。
 * 同一 git 执行器还以副本形式打进了 src-*.js（其他进程用的共享库），
 * 一并覆盖；无锚点的 src-*.js 自动跳过。
 * 幂等：已含默认值即跳过。写入前 acorn 校验。
 *
 * Usage:
 *   node scripts/patch-git-output-cap.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-git-output-cap.js --check      # 试运行，只报告
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

const CAP_BYTES = 33554432;
const ANCHOR_OLD_RE =
  /maxOutputBytes:([A-Z_$a-z][\w$]*),collectOutput:([A-Z_$a-z][\w$]*)=!0/g;
const ANCHOR_NEW_RE =
  /maxOutputBytes:([A-Z_$a-z][\w$]*)=33554432,collectOutput:([A-Z_$a-z][\w$]*)=!0/g;

function parseOk(code) {
  try {
    acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
    return true;
  } catch {
    try {
      acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
      return true;
    } catch {
      return false;
    }
  }
}

function patchSource(source) {
  ANCHOR_NEW_RE.lastIndex = 0;
  if (ANCHOR_NEW_RE.test(source)) {
    return { status: "already-patched", source, count: 0 };
  }

  ANCHOR_OLD_RE.lastIndex = 0;
  const matches = [...source.matchAll(ANCHOR_OLD_RE)];
  if (matches.length === 0) {
    if (
      source.includes("maxOutputBytes") &&
      source.includes("collectOutput") &&
      source.includes("outputLimitExceeded")
    ) {
      return { status: "unexpected-shape", source, count: 0 };
    }
    return { status: "not-applicable", source, count: 0 };
  }
  if (matches.length !== 1) {
    return { status: "unexpected-anchor-count", source, count: matches.length };
  }

  const next = source.replace(
    ANCHOR_OLD_RE,
    `maxOutputBytes:$1=${CAP_BYTES},collectOutput:$2=!0`,
  );
  if (!parseOk(next)) {
    return { status: "invalid-output", source, count: 1 };
  }
  return { status: "patched", source: next, count: 1 };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  // locateBundles 对同一 pattern 只返回一个文件，这里需要目录下全部
  // worker.js 与 src-*.js（git 执行器以副本形式存在于多个 bundle）。
  const PLATFORMS = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"];
  const bundles = [];
  for (const plat of PLATFORMS) {
    const d = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f === "worker.js" || /^src-.*\.js$/.test(f)) {
        bundles.push({ platform: plat, path: path.join(d, f) });
      }
    }
  }

  if (bundles.length === 0) {
    console.log("  [skip] no target bundles found");
    return;
  }

  let patched = 0;
  let failed = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    const result = patchSource(code);
    if (result.status === "already-patched") {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }
    if (result.status === "not-applicable") {
      console.log(`  [--] ${relPath(bundle.path)}: no git executor here, skipping`);
      continue;
    }
    if (result.status === "unexpected-shape") {
      console.log(
        `  [x] ${relPath(bundle.path)}: git executor found but output-cap anchor changed`,
      );
      failed++;
      continue;
    }
    if (result.status === "unexpected-anchor-count") {
      console.log(
        `  [!] ${relPath(bundle.path)}: expected exactly 1 anchor, found ${result.count}, skipping`,
      );
      failed++;
      continue;
    }
    if (result.status === "invalid-output") {
      console.log(
        `  [x] ${relPath(bundle.path)}: post-patch parse failed, aborting`,
      );
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would add default git output cap 32MB`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, result.source);
    console.log(
      `  [ok] ${relPath(bundle.path)}: default git output cap 32MB added`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { ANCHOR_NEW_RE, ANCHOR_OLD_RE, CAP_BYTES, patchSource };
