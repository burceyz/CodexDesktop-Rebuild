const test = require("node:test");
const assert = require("node:assert/strict");

const { patchSource } = require("./patch-realtime-voice-auth");

test("Windows 语音权限判断额外允许 apikey", () => {
  const source = [
    "function voiceAccess(e,t){",
    "let n=t?.permissions,r=access(e,t,n==null||n.includes(VOICE),",
    "{freeAndGoPlansAllowed:!0});",
    "return e.authMethod!==`chatgpt`&&r.status===`allowed`?",
    "{status:`denied`,reason:`unsupported-auth`}:r",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    /e\.authMethod!==`chatgpt`&&e\.authMethod!==`apikey`/,
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("macOS 的 freePlanAllowed 形态同样受支持", () => {
  const source = [
    "function voiceAccess(e,t){",
    "let n=t?.permissions,r=access(e,t,n==null||n.includes(VOICE),",
    "{freePlanAllowed:!0});",
    "return e.authMethod!==\"chatgpt\"&&r.status===\"allowed\"?",
    "{status:\"denied\",reason:\"unsupported-auth\"}:r",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    /e\.authMethod!=="chatgpt"&&e\.authMethod!==`apikey`/,
  );
});

test("Work Cloud 的 chatgpt 判断保持不变", () => {
  const source = [
    "function workAccess(e,t){",
    "let n=access(e,t,t?.adminWorkModeEnabled,{freePlanAllowed:!1}),",
    "i=e.authMethod===`chatgpt`;",
    "return{workCloud:!i&&n.status===`allowed`?",
    "{status:`denied`,reason:`unsupported-auth`}:n}",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});

test("不带语音权限标记的认证判断保持不变", () => {
  const source = [
    "function unrelated(e,r){",
    "return e.authMethod!==`chatgpt`&&r.status===`allowed`?",
    "{status:`denied`,reason:`unsupported-auth`}:r",
    "}",
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
