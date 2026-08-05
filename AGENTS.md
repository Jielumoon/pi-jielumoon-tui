# Repository Guidelines

## Project Structure & Module Organization

这是一个 TypeScript 原生 ESM 的 Pi TUI 扩展包。`package.json` 只暴露 `src/index.ts` 作为自有入口，由它统一注册以下模块：

- `src/vibrant-footer.ts`：Footer 生命周期、事件刷新与快照
- `src/footer/`：Footer 类型、渲染、设置、usage 和 Blackhole 数据
- `src/nano-context.ts`：上下文用量组件
- `src/thinking.ts`、`src/thinking-message.ts`：Thought trail
- `src/message-borders.ts`：用户消息、工具和 Bash 卡片样式
- `src/sakura-editor.ts`：Sakura 圆角输入框，保留 Pi 原生编辑行为并与其它 Editor 让位
- `src/working.ts`：Working Shimmer、spinner 和耗时 transcript
- `src/prototype-patch-registry.ts`：原型补丁的安装与清理

## Build, Test, and Development Commands

要求 Node.js `>=22.19.0`，与 `@earendil-works/pi-coding-agent >=0.83.0` 的官方运行时要求一致。首次安装使用：

```bash
npm install --legacy-peer-deps
```

提交前至少运行：

```bash
npm test
npm run typecheck
npm run pack:check
npm audit --omit=dev
```

测试位于 `tests/`，使用 Node `assert` 和 `tsx --test`；新增行为时优先为纯格式化、聚合逻辑或 mock 后的 Pi 生命周期补回归测试。涉及真实 Pi 生命周期或 TUI 渲染的改动，仍应使用 Pi RPC 模式加载全部扩展，或本地 `pi install` 后执行 `/reload` 手动确认。

## Coding Style & Naming Conventions

遵循现有 TypeScript 风格：严格类型检查、ES module 导入、制表符缩进；函数和变量使用 `camelCase`，类型使用 `PascalCase`，常量使用全大写下划线。原型补丁必须使用现有 registry，保证幂等安装，并在生命周期结束时清理可清理的补丁。不要把宿主 Pi 核心包重复加入 bundled dependencies。

## Commit & Pull Request Guidelines

现有提交使用中文、动作开头的 Emoji 摘要，例如 `🐛 修复缓存失效`，正文用短横线列出关键变更。每次提交只解决一类问题，并附上实际运行过的验证命令。界面改动应说明影响的 Pi 组件和手动验证方式。

## Security & Configuration Tips

不要提交令牌、账号或本地运行时配置。Footer 设置保存在 `~/.pi/agent/pi-vibrant-footer.json`，不属于仓库文件；修改依赖后必须重新执行依赖审计。根目录的 `npm audit --omit=dev` 会因测试用 Pi 0.83 core 报告其 `undici` / `brace-expansion` 上游公告，禁止用 `npm audit fix --force` 降级 Pi 掩盖问题；发布前还应在隔离目录对实际 tarball 的 `--omit=dev` 生产依赖树审计。不要将 `node_modules/` 或打包生成的 `.tgz` 加入版本控制。
