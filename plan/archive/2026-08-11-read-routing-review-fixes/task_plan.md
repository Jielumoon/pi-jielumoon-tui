# 删除 Read 分流并准备 hashline 交接

## Goal

删除 `pi-jielumoon` 中新增的 GPT Read 分流功能及其开关，恢复 TUI 原本只负责 readmap renderer 的边界；将 `pi-hashline-readmap` 克隆到 `~/opt/projects/pi/`，并在其 `handoff/` 下写一份只描述原始问题与证据的详细交接，不提前写优化方案。

## Current Phase

Phase 3: 验证与收尾

## Phases

### Phase 1: 删除当前 TUI 分流
- [x] 删除 readRouting 设置、命令、Footer 回调和 index wiring
- [x] 删除 readmap-renderers 中 GPT 判断与动态路由
- [x] 删除仅服务于分流的测试与文档
- [x] 保留原有 hashline renderer、Thinking 和其它 TUI 行为
- **Status:** complete

### Phase 2: 准备 hashline 仓库交接
- [x] 克隆或确认 `~/opt/projects/pi/pi-hashline-readmap`
- [x] 阅读真实 hashline Read 实现、注册入口、宿主 Read 对照和当前配置证据
- [x] 在目标仓库 `handoff/` 写详细问题交接
- **Status:** complete

### Phase 3: 验证与收尾
- [x] 当前 TUI 测试、typecheck、pack:check、audit
- [x] 确认分流关键词和配置已删除
- **Status:** complete

## Decisions

| Decision | Rationale |
|---|---|
| 删除而不是继续修复 TUI 内分流 | 用户明确认为该功能不应放在这个 TUI 扩展中 |
| handoff 只记录原始问题 | 交给 hashline 仓库的 agent 自行决定实现，避免提前注入优化方案 |
| Thinking 不修改 | 原有项目约束仍然有效 |

## Superseded Work

此前的“修复 Read 路由审查问题”计划已被用户最新指令取消，未执行其 Phase 1–3。

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| 旧 active plan 仍描述 Read 路由整改 | 1 | 按最新用户指令改写为删除分流与仓库交接计划 |
