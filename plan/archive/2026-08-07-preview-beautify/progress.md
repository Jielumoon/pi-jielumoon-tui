# 进度记录

## 审查阶段
- 初始化 `plan/task_plan.md`、`plan/findings.md`、`plan/progress.md`。
- 完成现有 renderer 盘点、主流 CLI 参考研究、问题分级和 wireframe 建议。
- 基线验证：`npm test` 35/35、`npm run typecheck`、`npm run pack:check` 通过。
- 审查阶段未改业务源代码；仓库原有 `AGENTS.md` 未提交修改未触碰。

## P0 实施阶段
- 已将 P0/P1/P2 目标和约束写入 `plan/task_plan.md`。
- 已完成去重复 diff 摘要、稳定 diff/hashline gutter、统一折叠提示和 `visibleWidth` 路径预算。
- 已增加混合行号、CJK 路径、hashline/diff 对齐、重复摘要和折叠提示回归。
- 验证：`npm test` 36/36、`npm run typecheck`、`npm run pack:check` 通过；未执行 git commit。

## P1/P2 实施阶段
- 用户要求继续完成剩余 P1/P2；已确认 Pi 原生 DiffData 的 `language`、`blockRanges`、`inlineDiffs` 契约与现有 message-borders 外框边界。
- 实施策略：在 `src/readmap-renderers.ts` 内做 feature-detect 和纯格式化，不修改 execute/schema，不引入依赖。

### 锚点编辑错误记录
- 连续几次 `edit` 使用了上一次读取的 LINE:HASH 锚点，触发 stale anchor 拒绝；这些失败操作未写入目标文件。
- 修正方式：每次修改前先用当前 `ast_search`/`read(symbol)` 获取新锚点，修改后立即运行 `npm run typecheck`；不再依赖旧的行号。

## P1/P2 完成记录
- `src/readmap-renderers.ts`：增加 color/plain/screen-reader presentation 模式和可选 whitespace/bidi 诊断；hashline 分段着色，diff 使用 `toolDiffAdded`/`toolDiffRemoved`，保留 ANSI 安全净化。
- Bash：stdout 统一 `│ `/`output:` 层级；长输出继续使用统一折叠提示。
- ls：宽度 ≥100 时按 visibleWidth 双列排版，CJK/emoji 长名称安全裁剪，窄屏单列降级。
- diff：feature-detect `language`、`blockRanges`、`inlineDiffs`；增加 hunk 标题、token span 着色、宽屏 split、窄屏 compact/summary 降级。
- 回归新增 2 项，总测试数 38；阶段验证 `npm test`、`npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev` 和 `git diff --check` 全部通过。

## P3 审查整改阶段
- code-review-expert + ponytail-review 共发现 3 项 P1、3 项 P2；用户要求全部修复。
- 已确认根因：Pi 0.83 renderer context/options 没有 `width`、`renderMode`、`diagnostics`；Bash details 没有 `exitCode`/duration；既有测试通过伪造字段覆盖了生产环境不可达分支。
- 已用 smoke case 复现：真实 context 下 ls 120 列仍单列、read 40 列二次换行丢 gutter 缩进、4 项网格误报 showing 2 of 4、多行 replace split 错配、150,000 条折叠 diff 触发 RangeError。
- 宿主契约整改完成：删除虚构 context 展示字段与 Bash metadata，新增单一 `WidthAwareTextComponent`，read/write/bash/ls 均在实际 `render(width)` 排版；同步把无色/诊断测试改为真实环境配置入口。
- diff/ls 数据逻辑已修：split 使用 `inlineDiffs` 的真实 remove/add 索引配对并同时输出 add 侧 hunk；ls 先按条目上限裁切再组网格，shown 数量不再误用网格行数；所有宽度计算改用迭代 reduce。
- 新增 `src/render-mode.ts` 作为唯一模式解析入口；readmap 与 message-borders 同时遵守 `PI_READMAP_RENDER_MODE`/`NO_COLOR`，plain/screen-reader 会绕过自定义 Sakura tool frame 与 Bash repaint，彩色模式保持原样。
- 新增正式回归：连续 remove/add 配对、双侧 hunk、150,000 条 diff、ls fallback/条目计数，以及真实 ToolExecution 原型组合测试。
- 最终验证：`npm test` 40/40、`npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`（0 vulnerabilities）和 `git diff --check` 全部通过；RPC 显式加载 `src/index.ts` 成功，真实伪终端执行 `/reload` 后资源列表包含本扩展 `src` 且未出现 `extension_error`。伪终端由 10 秒 timeout 结束，因此该命令退出码为 124，不代表加载失败。
