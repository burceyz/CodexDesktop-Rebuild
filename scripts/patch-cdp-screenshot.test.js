const test = require("node:test");
const assert = require("node:assert/strict");

const { MARKER, patchSource } = require("./patch-cdp-screenshot");

test("CDP 截图守卫兼容独立 timeout 参数", () => {
  const source = [
    "class BrowserHost{",
    "async sendDebuggerCommand(e,t,n,r={},i=this.cdpCommandTimeoutMs){",
    "let a=r.sessionId;",
    "return await wait(e.webContents.debugger.sendCommand(t,n,a),i,`timeout`)",
    "}",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    new RegExp(`sendCommand\\(t,globalThis\\.${MARKER}\\(t,n\\),a\\),i,`),
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("不含截图管线的代码保持不变", () => {
  const source = "async function unrelated(){return true}";

  assert.equal(patchSource(source).status, "not-applicable");
});

test("截图管线结构漂移时明确失败", () => {
  const source = [
    "async function sendDebuggerCommand(){",
    "return Page.captureScreenshot({captureBeyondViewport:true})",
    "}",
  ].join("");

  assert.equal(patchSource(source).status, "unexpected-shape");
});
