const CODEX_BINARY_SOURCE = new Map([
  ["mac-arm64", "upstream"],
  ["mac-x64", "upstream"],
  ["win", "upstream"],
  ["linux-x64", "cometix"],
  ["linux-arm64", "cometix"],
]);

/**
 * 桌面端 CLI 必须与同一安装包内的 app-server、code-mode host 保持协议一致。
 * Linux 没有可复用的上游原生资源，才使用对应架构的 @cometix/codex。
 */
function getCodexBinarySource(platform) {
  const source = CODEX_BINARY_SOURCE.get(platform);
  if (!source) throw new Error(`Unsupported Codex binary platform: ${platform}`);
  return source;
}

module.exports = { getCodexBinarySource };
