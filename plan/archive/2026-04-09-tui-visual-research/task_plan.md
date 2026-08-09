# TUI 视觉研究与 Sakura Quiet 实施

## Goal
在已完成的视觉研究基础上，连续实施 Sakura Quiet 的 P0、P1、P2 改造；保持 Thinking 完全不动，并完成全量验证与工作记录。

## Current Phase
Complete

## Phases

### Phase 1: 审计现有视觉系统
- [x] 阅读 Footer、消息、工具调用、Thinking、Working、Editor 的实现与测试
- [x] 归纳现状、约束及主要视觉问题
- **Status:** complete

### Phase 2: 检索参考产品
- [x] 搜索 Pi 生态及其他优秀 TUI/CLI 的成熟视觉模式
- [x] 核验高价值官方/GitHub 来源
- [x] 提炼可迁移而非照抄的设计规律
- **Status:** complete

### Phase 3: 形成改造方案
- [x] 建立统一视觉语言与组件规范
- [x] 给出 read/edit/write/bash/ls 等工具卡片的具体方案
- [x] 绘制终端效果草图并按收益/成本排序
- **Status:** complete

### Phase 4: 交付审校
- [x] 对照用户要求检查完整性
- [x] 明确建议、风险与下一步实施顺序
- **Status:** complete

### Phase 5: P0 视觉降噪
- [x] User message 改为单侧 rail，保留 OSC133 行为
- [x] 完成工具移除满宽渐变框并消除重复状态语义
- [x] Sakura 强调收敛到活动态并通过 P0 定向测试
- **Status:** complete

### Phase 6: P1 信息架构
- [x] Nano context 紧凑化并与 Footer context 去重
- [x] Footer 建立稳定左右锚点和宽度优先级
- [x] 完善 read/edit/write/bash/ls 的折叠与预览策略
- **Status:** complete

### Phase 7: P2 动效与视觉回归
- [x] 简化 Working 动画和短任务 transcript
- [x] 保持 Thinking 实现与视觉完全不变
- [x] 补充 40/60/80/120/160 列与状态回归
- **Status:** complete

### Phase 8: 全量验证与记录
- [x] 更新 `docs/work.md`
- [x] 运行 test、typecheck、pack:check、audit
- [x] 完成 Pi RPC 全扩展加载 smoke test
- [x] 审查最终 diff 和源码改动边界，确认 Thinking 未改动
- **Status:** complete

### Phase 9: 按目视反馈恢复层级
- [x] Read 保持无框并整体左缩进 2 格
- [x] Edit/Write/Bash/Ls 及其它工具恢复单层 Sakura 边框
- [x] 恢复 Footer token/cache/cost/quota 的语义颜色
- [x] 运行定向与全量验证并更新工作记录
- **Status:** complete

### Phase 10: 嵌入边框标题与统一运行态
- [x] 所有有框工具把 canonical header 嵌入上边框
- [x] 工具运行态共享 Pi Braille spinner 与 80ms 节奏
- [x] 用户消息恢复无标题 Sakura 圆框与粗 rail
- [x] 更新文档并运行全量验证
- **Status:** complete

### Phase 11: 封口、溢出与 Blackhole 修正
- [x] 溢出工具标题保留省略号、封口横线和右上角
- [x] 用户消息与 Editor 覆盖 paste、长 ASCII、CJK 及 5–160 列
- [x] 小于 7 列时 Editor 安全回退，避免双宽字符换行递归
- [x] Blackhole 有快照时恢复常态显示
- [x] 更新记录并运行全量验证
- **Status:** complete

### Phase 12: 修正 Bash 标题误省略
- [x] 复现可容纳命令仍出现 `…` 的真实 Bash 渲染
- [x] 标题宽度计算忽略宿主行尾 padding，仅真实溢出时省略
- [x] 增加实机同型回归并完成定向验证
- [x] 更新记录并运行全量验证
- **Status:** complete

### Phase 13: 代码审查整改
- [x] 修复工具边框误删真实输出与扩展状态误吞错误
- [x] 接通 Context 设置并修复窄宽、空 Footer、Ls 默认路径与 plain 排版
- [x] 删除审查确认的死数据和一次性抽象
- [x] 补齐回归、运行全量门禁并归档计划
- **Status:** complete

## Key Questions
1. 当前“比不上别人”的根因是色彩、层级、密度、动效，还是组件之间缺少统一语法？
2. 哪些成熟模式适合 Pi 的终端宽度、主题着色和原生 renderer 约束？
3. 工具调用如何同时做到可扫读、可折叠、错误醒目且不喧宾夺主？

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 先审计再搜索 | 避免把别人的视觉元素生硬贴到现有组件上 |
| 最终用静态终端草图展示 | 用户要求“最好有展示”，且草图比抽象形容更可执行 |
| 本轮只做研究建议，不改产品代码 | 用户明确要求搜索并给推荐，尚未授权实施 |
| 用户确认后连续实施 P0 → P1 → P2 | 用户已明确授权，无需阶段间停下询问 |
| Thinking 完全不动 | 用户明确保留现有 Thinking 视觉与行为 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `findings.md` 追加时锚点过期 | 1 | 使用 edit 返回的新鲜 hashline 锚点重试 |
| `findings.md` 编辑前缺少足够新鲜的锚点 | 1 | 重新读取目标范围后编辑成功 |
