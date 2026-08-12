# Repository Guidelines

## Project Structure & Module Organization

这是 TypeScript 原生 ESM 的 Pi TUI 扩展。`package.json` 的 `pi.extensions` 只暴露 `./src/index.ts`，由它统一注册：

- `src/vibrant-footer.ts` + `src/footer/`：Footer 生命周期、渲染、设置、会话 usage、Blackhole，以及自研 `subscription-usage.ts`（Codex / Anthropic / OpenRouter / xAI）
- `src/nano-context.ts`：上下文用量彩条
- `src/thinking.ts`、`src/thinking-message.ts`：Thought trail
- `src/message-borders.ts`：用户消息、工具和 Bash 卡片样式
- `src/sakura-editor.ts`：Sakura 圆角输入框；保留 Pi 原生编辑，遇其它 Editor 时让位
- `src/working.ts`：Working Shimmer、spinner 与耗时 transcript
- `src/readmap-renderers/`：接管 read / edit / write / bash / ls 的展示与折叠，不改 execute；入口 `index.ts`，内部按 presentation / header / diff / stream-animation / write-stream / edit-stream / results / patch 分层
- `src/prototype-patch-registry.ts`：原型补丁安装与清理
- `src/ansi.ts`、`src/guards.ts`、`src/duration.ts`、`src/token-estimate.ts`：跨模块共享的样式剥离、类型判断、时长格式化与 token 估算
- `tests/`：Node `assert` + `tsx --test` 回归；`plan/archive/` 仅存已完成计划

## Build, Test, and Development Commands

要求 Node.js `>=22.19.0`，peer 为 `@earendil-works/pi-* >=0.83.0`。首次安装：

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

新增行为优先覆盖纯格式化、聚合逻辑，或 mock 后的控制器 / renderer。真实 TUI 改动需 Pi RPC 全量加载扩展，或本地 `pi install` 后 `/reload` 目视确认。

## Coding Style & Naming Conventions

严格 TypeScript、ESM、制表符缩进；函数/变量 `camelCase`，类型 `PascalCase`，常量全大写下划线。原型补丁走现有 registry，幂等安装，可清理项在生命周期结束时还原。不要把宿主 Pi 核心包打进 bundled dependencies。readmap 在主题着色前净化外部文本中的终端控制序列；订阅额度只查当前模型，遵守 60s 缓存与 Retry-After 退避。

## Testing Guidelines

测试位于 `tests/`，用 `tsx --test tests/*.test.ts` 跑全量。优先为 footer 格式化、subscription-usage 缓存/退避、readmap 折叠与控制序列净化、以及 package 入口清单补回归。涉及真实生命周期或终端渲染时，单元测试不够，仍需 `/reload` 手动确认。

## Commit & Pull Request Guidelines

默认分支是 `main`。提交用中文、动作开头的 Emoji 摘要，例如 `🐛 修复缓存失效`，正文用短横线列关键变更；每次只做一类事并写明实际验证命令。界面改动说明影响的 Pi 组件和 `/reload` 检查方式。

## Security & Configuration Tips

不要提交令牌、账号或本地运行时配置。Footer 设置在 `~/.pi/agent/pi-vibrant-footer.json`，不属于仓库。修改依赖后重跑 `npm audit --omit=dev`；禁止 `npm audit fix --force` 降级宿主 Pi 掩盖问题。发布前在隔离目录对实际 tarball 的生产依赖树再审计一次。不要把 `node_modules/` 或 `*.tgz` 纳入版本控制。
