const test = require("node:test");
const assert = require("node:assert/strict");

const { patchManifestSource } = require("./patch-windows-portable-runtime");

test("Windows 便携构建禁用依赖 MSIX 身份的 contained core", () => {
  const source = JSON.stringify({
    name: "openai-codex-electron",
    codexWindowsAppContainedCore: "1",
  });
  const result = patchManifestSource(source);

  assert.equal(result.matched, true);
  assert.equal(result.changed, true);
  assert.equal(JSON.parse(result.source).codexWindowsAppContainedCore, "0");
});

test("Windows 便携运行时补丁可重复执行", () => {
  const source = JSON.stringify({ codexWindowsAppContainedCore: "0" });
  const result = patchManifestSource(source);

  assert.equal(result.matched, true);
  assert.equal(result.changed, false);
  assert.equal(result.source, source);
});

test("上游未声明 contained core 时无需修改", () => {
  const source = JSON.stringify({ name: "openai-codex-electron" });
  const result = patchManifestSource(source);

  assert.equal(result.matched, false);
  assert.equal(result.changed, false);
});

test("未知 contained core 值会明确失败", () => {
  assert.throws(
    () => patchManifestSource(JSON.stringify({ codexWindowsAppContainedCore: "auto" })),
    /Unexpected codexWindowsAppContainedCore value/,
  );
});
