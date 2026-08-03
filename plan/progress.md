# 进度记录

## 2026-08-03：初版
- 曾在 `pi-jielumoon` 创建一套自定义 editor、Footer、Working、context 和工具 rail。
- 用户反馈这些不是需求，已全部删除，不保留旧入口。

## 2026-08-03：按需求修订
- 以当前 `/home/jielumoon/opt/projects/pi-vibrant-footer` 重构版为唯一功能基线。
- 迁移 `nano-context.ts`、`vibrant-footer.ts`、`footer/` 六个模块。
- 迁移 `@narumitw/pi-usage`、`@narumitw/pi-tui-kit` 为 bundled dependencies。
- 只额外迁移 sakura 的 Thought trail：`src/thinking-message.ts`、`src/thinking.ts`、渐变支持和 patch registry。
- 不再接管 editor、Working 或工具执行组件。
- 修正 Thinking patch registry 的 adapter 类型遗漏。
- `npm run typecheck`：通过。
- `npm run pack:check`：通过。
- `npm audit --omit=dev`：通过，0 vulnerabilities。
- 系统 Pi 加载四个扩展入口的 RPC 验证：退出码 0。
- 已重新执行 `pi install /home/jielumoon/opt/projects/pi-tui/pi-jielumoon`。

## 2026-08-03：计划提示修正
- `pi-planning-with-files` 检测到旧计划只有列表状态，没有 `### Phase N:` 标题，因此提示 `no phase headers yet`。
- 将 `plan/task_plan.md` 改为扩展可识别的 `Goal / Current Phase / Phases / **Status:**` 格式。

## 2026-08-03：第一次彩条修补（未达到原图）
- 曾把 used 标签从普通文本色改为语义前景色，只解决“标签看不见”，没有恢复原版背景色块。
- 用户提供当前图与原图对比后，确认这次修补方向错误。

## 2026-08-03：恢复原版彩条
- 对比两张截图：当前版是彩色前景字符与灰色 `░`，原版是连续 RGB 背景色块与空格填充。
- 通过 `git show HEAD:nano-context.ts` 找回 `pi-vibrant-footer` 原始实现和六组固定色值。
- 恢复 used segment 背景色、深色标签、free 背景色与黄绿色文字；保留重构后的 session 生命周期和 resize listener 清理。
- TUI 终端采样确认原版 `system/free` 背景色与两组文字色控制码均存在，`░` 已完全消失。
- `npm run typecheck`：通过。
- `npm run pack:check`：通过。
- `npm audit --omit=dev`：通过，0 vulnerabilities。
- 已重新执行 `pi install /home/jielumoon/opt/projects/pi-tui/pi-jielumoon`。

## 2026-08-03：扩展状态行布局
- Footer 原本按扩展 key 排序后全部左对齐，导致 `planning-with-files` 计划提示出现在状态行中间。
- 修改 `src/footer/render.ts`：普通扩展状态保留左侧，`planning-with-files` 单独作为右侧状态并贴齐终端最右边。
- `npm run typecheck`：通过。
- 已重新执行 `pi install /home/jielumoon/opt/projects/pi-tui/pi-jielumoon`。
- TUI 输出验证：`6/6 phases complete` 位于 80 列行的右端。

## 2026-08-03：Thought trail 与命令收尾
- Thought trail 现在只移除每步开头的 `Thinking:` 前缀，保留原始思考内容和树形结构。
- `/jielumoon-tui` 无参数直接打开 Footer 设置面板；`settings/reset/on/off` 子命令继续可用。
- Git 仓库已初始化为 `main`，最终 commit 已完成。

## 2026-08-03：Thought trail 正文颜色统一
- 原因：Markdown/ANSI 保留逻辑导致第一条正文和后续正文走不同渲染路径，颜色不一致。
- 修改 `src/thinking-message.ts`：所有 Thought trail 正文统一经过 `softBody()`，只保留树枝与菱形的渐变色。
- `npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`：通过。
- 已重新安装 `pi-jielumoon-tui`。

## 2026-08-03：调研消息边框
- 当前 `pi-jielumoon-tui` 只改造 Footer 和 Thought trail，用户消息与助手回复仍使用 Pi 默认无边框渲染。
- Sakura 的 `user-message.ts` 通过 patch `UserMessageComponent.render()` 绘制顶部/底部渐变横线和左侧 rail；Pi 原生 `AssistantMessageComponent` 没有对应的完整消息卡片。
- 新增 Phase 10，待确认助手边框是否包含 Thought trail、工具调用后再实现，避免错误包住整段执行输出。

## 2026-08-03：修正消息边框分层
- 上一版错误地把助手回复和 Thought trail 一起包进边框，已移除该逻辑。
- `src/message-borders.ts` 现在复用 Sakura 用户消息结构；工具调用才使用工具卡片边框，Bash 只重绘 Pi 原有上下边框。
- `npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`、RPC 加载：通过。
- 已重新安装 `pi-jielumoon-tui`。

## 2026-08-03：还原 Sakura 用户消息样式
- 用户消息左侧 rail 改回 Sakura 默认粗 glyph `▐`，不再使用细线 `│`。
- 补齐 Sakura 的 macaron Markdown 主题映射：标题、链接、代码、引用、列表和文本强调。
- `npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`、RPC 加载：通过。
- 已重新安装 `pi-jielumoon-tui`。

## 2026-08-03：计划状态显示开关
- 新增独立 Footer 设置项 `planning`，默认开启，设置面板显示为“计划阶段状态”。
- 关闭时只过滤 `planning-with-files` 的 `9/9 phases complete`，其它扩展状态和 usage 不受影响。
- 支持 `/jielumoon-tui planning on`、`/jielumoon-tui planning off`，配置持久化到现有 Footer 设置文件。
- `npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`、RPC 加载：通过。
- 已重新安装 `pi-jielumoon-tui`。

## 2026-08-03：优化消息渲染性能
- 原因：消息边框扩展在每次 TUI 重绘时重复渲染所有历史用户 Markdown 和已完成工具边框，消息增多后复杂度持续放大。
- `src/message-borders.ts` 新增用户消息缓存、已完成工具缓存，以及 `invalidate` 失效清理；流式工具不缓存，保持实时输出。
- `npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`、RPC 加载：通过。
- 已重新安装 `pi-jielumoon-tui`。

## 2026-08-03：主动性能审计与资源生命周期
- 审计发现 Thought trail 组件、已完成 Bash 边框、隐藏思考标签和 nano-context token 估算仍有可避免的重复计算。
- `src/thinking-message.ts` 增加按宽度/主题缓存、快速路径和失效清理；`src/message-borders.ts` 增加 Bash 完成态缓存及 invalidate patch；`src/nano-context.ts` 缓存历史消息 token 分段。
- 修复 `src/thinking.ts` 在 session shutdown 后遗留 prototype patch 的资源生命周期问题。
- `npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`、RPC 加载：通过。
- 已重新安装 `pi-jielumoon-tui`。

## 2026-08-03：恢复 Footer 即时刷新
- 确认 30 秒定时器与原版 `pi-vibrant-footer` 一致，延迟来自普通事件中同步执行全量 usage/Blackhole 扫描。
- `src/vibrant-footer.ts` 将 context、message_end、model 和 thinking 事件改为轻量 snapshot 更新；usage/Blackhole 全量采集仅在 agent_end、压缩、分支变化、设置变更和定时刷新执行。
- 保留每次 snapshot 后立即调用 `tui.requestRender()`，不延迟 Footer 重绘。
- `npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`、RPC 加载：通过。
- 已重新安装 `pi-jielumoon-tui`。