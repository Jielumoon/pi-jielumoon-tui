# 预览美化实施计划

## 目标
在不改变工具执行逻辑和外框职责的前提下，改善 read/edit/write/bash/ls 的信息层级、gutter 对齐和折叠提示；每一阶段都配套回归测试与真实 TUI 检查。

## 优先级
### P0：信息层级与稳定排版（本轮）
- [x] 删除 edit/overwritten write 的重复 diff 摘要，只保留一个结果 summary。
- [x] 用 `visibleWidth` 对齐 diff 行号、read/write hashline gutter 与路径预算。
- [x] 统一隐藏内容提示为 `… showing X of Y lines · Ctrl+O to expand`，区分已展示条目与总条目。
- [x] 为重复摘要、混合行号、Unicode 宽度和折叠提示补回归测试。

### P1：内容层美化（已完成）
- [x] read/write hashline 的行号、hash、正文分色分段。
- [x] Bash stdout 增加统一子层级与结构化 output 摘要。
- [x] ls 在宽屏尝试双列布局，窄屏保持可读单列。
- [x] 增加暗色主题对比度与无色模式回归。

### P2：高级能力（已完成）
- [x] feature-detect `blockRanges` / `inlineDiffs`，增加 hunk 与 token 级 diff 强调。
- [x] 在足够宽度启用 split diff，窄屏自动降级。
- [x] 增加可选 whitespace/bidi 诊断和 plain/screen-reader 线性输出。
- [x] 不引入新的 diff 算法或语法高亮大依赖。

### P3：审查整改（已完成）
- [x] 对齐 Pi 0.83 的真实 `ToolRenderContext` / `BashToolDetails`，删除测试伪造字段。
- [x] 让 read/write/bash/ls 在 `Component.render(width)` 使用真实宽度。
- [x] 修复多行 split 配对、add 侧 hunk、ls 条目计数和大数组 spread 崩溃。
- [x] 让 plain/screen-reader 与 `message-borders` 共享输出模式，补端到端回归。
- [x] 重跑全量门禁并完成真实 Pi `/reload` 可执行性检查。

## 实施约束
- renderer 不绘制外框；状态外框继续由 `src/message-borders.ts` 负责。
- 不修改工具 `execute`、参数 schema 或 readmap 数据生产逻辑。
- 先拆少量纯格式化函数，再改渲染流程；不搭通用 renderer 框架。
- 不执行 git commit；完成前运行定向测试、全量测试、类型检查和打包检查。
