# 进度

- 开始：git 工作树仅未跟踪 test.md，未改业务代码；已读工作记录、README、TUI 契约及工具渲染示例。
- 根因已确认并用真实 `EditCallComponent` 复现：`newText` 先到并播完动画后，`oldText` 分块前插使新目标不再是已揭示内容的前缀，旧逻辑把绿行裁回共同前缀并重播，每块到达都倒带一轮——即用户看到的红绿交错闪、卡闪。
- 修复已合入：`edit-stream.ts` 非前缀目标直接呈现新快照（不再倒带），尾部追加保留逐字动画；新增回归 `Edit 后到的旧文本不倒带重播已经显示的新文本`（先在旧代码上确认 fail，再在新代码通过）。
- 按用户要求删除 `scripts/patch-pi-tui-flicker.mjs`、`tests/pi-tui-flicker-patch.test.ts`、package.json 两个 patch script 与 `files.scripts` 入口、README 补丁用法整段；`docs/work.md` 历史记录保留。
- 验证：`npm test` 130/130（原 135 − 已删 6 个补丁测试 + 1 新回归）、typecheck、pack:check、`npm audit --omit=dev` 0 漏洞、`git diff --check` 均通过；RPC 模式全量扩展加载成功；tmux 假终端跑临时探针扩展：流式 23 次更新高度恒 13、展开态红 10 行+绿 10 行共存、原生 edit 完成 `+10 −10`，`/reload` 后重跑探针同样 PASS；探针与临时文件已清理。
- 旧补丁 `--check` 退出 1 的原因：全局 Pi TUI 已是 0.85.1，上游已改差量刷新且锚点不匹配，补丁已无存在必要。
