const test = require("node:test");
const assert = require("node:assert/strict");

const { patchSource } = require("./patch-fast-mode");

test("局部变量形式的排除判断只额外放行 apikey", () => {
  const source = [
    `async function fastModeEnabled(){`,
    `let n=await getAuthMethod();`,
    `if(n!==\`chatgpt\`)return!1;`,
    `return requirements.fast_mode!==!1`,
    `}`,
  ].join("");

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, /n!==`chatgpt`&&n!==`apikey`/);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("肯定判断同时允许 chatgpt 与 apikey", () => {
  const source =
    "function canUseFastMode(auth){return auth.authMethod===`chatgpt`&&requirements.fast_mode!==!1}";

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    /auth\.authMethod===`chatgpt`\|\|auth\.authMethod===`apikey`/,
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("fast_mode 函数之外的认证判断保持不变", () => {
  const source = "function unrelated(n){return n!==`chatgpt`}";

  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
