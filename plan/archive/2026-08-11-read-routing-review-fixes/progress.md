# Progress

## Session: 2026-08-11

### Phase 1: 删除当前 TUI 分流
- **Status:** complete
- 按用户最新指令取消 Read 路由整改，删除 `readmap-renderers.ts` 中的 GPT 判断、参数过滤、动态注册和相关类型。
- 删除 Footer 的 `readRouting` 字段、默认值、设置菜单项、命令回调和 `vibrantFooter` / `index.ts` wiring。
- 删除分流专用测试、README 说明和 `docs/work.md` 记录。
- 核对源码与 HEAD 对比，TUI 源码恢复为只接管 readmap renderer；Thinking 文件未修改。

### Phase 2: 准备 hashline 仓库交接
- **Status:** complete
- 将 `https://github.com/Jielumoon/pi-hashline-readmap` 克隆到 `/home/jielumoon/opt/projects/pi/pi-hashline-readmap`。
- 阅读 `src/read.ts` 的参数 schema、空 symbol / 互斥参数校验、文件读取分支和结果生成。
- 阅读根 `index.ts` 的 Read 注册、全局 executor 暴露和 `hashline:tool-executors` 事件。
- 在 `handoff/2026-08-11-gpt-read-failure.md` 写入问题复现、源码证据、责任边界、历史纠正和待验证问题；未修改目标仓库源码。

### Phase 3: 验证与收尾
- **Status:** complete
- 当前 TUI `npm test`：53/53 通过。
- `npm run typecheck`：通过。
- `npm run pack:check`：通过。
- `npm audit --omit=dev`：0 vulnerabilities。
- `git diff --check`：通过。
- Pi RPC `get_state`：`success: true`，扩展加载无 `extension_error`。
- `ast_search` 未发现 `readRouting`、`isGptReadModel` 或 `installReadModelRouter` 残留。
- 当前 TUI 的源码 diff 已清除；剩余 `docs/work.md` 仅有末尾换行差异，另有本次 active plan 文件。
- 目标仓库保持 `main...origin/main`，仅新增未提交的 `handoff/` 交接目录，源码未修改。

## Test Results

| Test | Result |
|---|---|
| npm test | 53/53 passed |
| npm run typecheck | passed |
| npm run pack:check | passed |
| npm audit --omit=dev | 0 vulnerabilities |
| git diff --check | passed |
| Pi RPC get_state | success: true |
| Read routing residue search | no matches |
