# Findings

## User Direction

- GPT Read 分流不应继续放在 `pi-jielumoon` TUI 扩展中。
- 当前 TUI 相关功能、配置和命令需要删除。
- 原始问题应交给 `pi-hashline-readmap` 仓库 agent 处理。
- handoff 只描述“为什么 GPT 模型读不了文件”，不要把本次审查提出的优化方案写成结论。

## Known Evidence To Verify

- `pi-jielumoon` 曾通过 `installReadModelRouter()` 按模型重新注册名为 `read` 的工具。
- GPT 分支只暴露 `path/offset/limit`，实际 execute 仍委托 hashline Read。
- hashline 工具通过全局 `__hashlineToolExecutors` 和 `hashline:tool-executors` 事件暴露 Read。
- Pi 同名工具存在扩展加载顺序语义，当前问题交接需要区分“模型参数契约问题”和“TUI 路由包装问题”。
- 交接文档必须以目标仓库真实源码、模型配置和宿主 Read 契约为证据，不凭审查推测写结论。

## Scope Boundary

本次只删除 `pi-jielumoon` 中的分流功能并创建交接，不修改 `pi-hashline-readmap` 源码，不在 handoff 中预先实现优化。
