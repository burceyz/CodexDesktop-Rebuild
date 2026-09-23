const test = require("node:test");
const assert = require("node:assert/strict");

const { CAP_BYTES, patchSource } = require("./patch-git-output-cap");

test("Git 输出上限兼容压缩变量名变化", () => {
  const source =
    "async function run(r={}){let{maxOutputBytes:u,collectOutput:d=!0}=r;return [u,d]}";

  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.match(
    result.source,
    new RegExp(`maxOutputBytes:u=${CAP_BYTES},collectOutput:d=!0`),
  );
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("不含 Git 执行器的代码不被修改", () => {
  const source = "function run(){return true}";

  assert.equal(patchSource(source).status, "not-applicable");
});

test("Git 执行器结构漂移时明确失败", () => {
  const source =
    "function run(){const maxOutputBytes=1,collectOutput=true,outputLimitExceeded=false}";

  assert.equal(patchSource(source).status, "unexpected-shape");
});
