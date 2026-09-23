#!/usr/bin/env node
/**
 * 将 Windows MSIX 的应用清单切换为便携运行模式。
 *
 * 新版 Owl 启动器在 codexWindowsAppContainedCore=1 时会读取当前 MSIX
 * 程序包身份。ZIP 解压运行没有程序包身份，因此必须改用同包 resources/codex.exe。
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const FIELD = "codexWindowsAppContainedCore";

function patchManifestSource(source) {
  const manifest = JSON.parse(source);
  const current = manifest[FIELD];

  if (current == null) {
    return { matched: false, changed: false, source };
  }
  if (current === "0") {
    return { matched: true, changed: false, source };
  }
  if (current !== "1") {
    throw new Error(`Unexpected ${FIELD} value: ${JSON.stringify(current)}`);
  }

  manifest[FIELD] = "0";
  return {
    matched: true,
    changed: true,
    source: JSON.stringify(manifest, null, 2) + "\n",
  };
}

function patchManifestFile(file, { check = false } = {}) {
  const source = fs.readFileSync(file, "utf8");
  const result = patchManifestSource(source);

  if (!result.matched) {
    console.log(`  [skip] ${relPath(file)}: ${FIELD} not declared`);
    return result;
  }
  if (!result.changed) {
    console.log(`  [ok] ${relPath(file)}: portable runtime already enabled`);
    return result;
  }
  if (check) {
    console.log(`  [?] ${relPath(file)}: would enable portable runtime`);
    return result;
  }

  fs.writeFileSync(file, result.source, "utf8");
  console.log(`  [ok] ${relPath(file)}: portable runtime enabled`);
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  if (platform && platform !== "win") {
    console.log(`  [skip] ${platform}: Windows portable runtime patch not applicable`);
    return;
  }

  const file = path.join(SRC_DIR, "win", "_asar", "package.json");
  if (!fs.existsSync(file)) {
    if (platform === "win") throw new Error(`Windows ASAR manifest not found: ${file}`);
    console.log("  [skip] Windows ASAR manifest not found");
    return;
  }

  patchManifestFile(file, { check: args.includes("--check") });
}

if (require.main === module) main();

module.exports = { patchManifestFile, patchManifestSource };
