# Codex Desktop Rebuild

Cross-platform Electron build for OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | ✅     |
| Windows  | x64          | ✅     |
| Linux    | x64, arm64   | ✅     |

## Build

```bash
# Install dependencies
npm install

# Sync upstream resources, then apply all patches
npm run sync
npm run patch

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

## 补丁链路

- `src/<platform>/_asar` 是 ASAR 内资源的补丁目标。
- `src/<platform>/plugins` 与 `src/<platform>/cua_node` 是 Browser / Computer Use 等外置运行时的补丁目标；直打包流程会显式覆盖这两个目录，避免重新复制上游安装包缓存时丢失补丁。
- `patch-browser-auth.js` 兼容 API-key 登录：ChatGPT 身份与 request-header 策略可用时保持原行为；身份读取失败时仅关闭该可选请求头并继续本地浏览器通道，不会把 API key 伪装或发送为 ChatGPT token。
- `patch-image-generation-auth.js` 兼容自定义 `base_url` 的 API-key 登录：仅对非 OpenAI/ChatGPT 官方地址为 app-server 注入 provider 认证、`image_gen` 能力参数，并在没有静态模型目录时启用远端模型发现；显式关闭项及已有 `model_catalog_json`/`model_catalog_url` 均优先，API key 只经子进程环境传递，不写入用户配置或命令行。
- `patch-realtime-voice-auth.js` 为 API-key 登录放行实时语音入口；实时会话仍由 app-server 使用当前 model provider 的 `base_url` 与认证创建，ChatGPT 工作区能力的认证限制保持不变。
- 上游更新后应先执行 `npm run patch -- --check` 或完整 `npm run patch`，再运行测试和构建。

## Development

```bash
npm run dev
```

## Project Structure

```
├── src/
│   └── <platform>/
│       ├── _asar/       # Extracted app.asar patch target
│       ├── plugins/     # Bundled plugin patch target
│       └── cua_node/    # Browser / Computer Use runtime patch target
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   ├── patch-all.js
│   └── patch-browser-auth.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

GitHub Actions automatically builds on:
- Push to `master` / `main` and tag `v*` → build artifacts
- 每日上游同步工作流：逐平台比较已保存的版本；仅在任一平台版本变化时下载上游、重新应用补丁、构建并更新 Release

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild & Linux [@cometix/codex](https://www.npmjs.com/package/@cometix/codex) binaries
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.
