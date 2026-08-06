# Progress Log

## Session: 2026-08-06

### Current Status
- **Phase:** 7 - 额度归入会话统计 complete
- **Started:** 2026-08-06

### Actions Taken
- 阅读本地 Footer 生命周期、会话 token/cost 统计、状态行渲染、入口和现有测试。
- 阅读参考仓库 `juanibiapina/pi-usage` 的 Codex、Anthropic、xAI、缓存、检测和类型实现；对照本地第三方版本的 Codex/OpenRouter 归一化。
- 创建 `plan/task_plan.md`、`plan/findings.md`，确定四 Provider、官方域名校验、Pi ModelRegistry 认证、60 秒 TTL、Retry-After/60 秒退避和 stale generation 约束。
- 新增 `src/footer/subscription-usage.ts`：四个 Provider 请求/响应归一化、OAuth/API key 认证、Grok CLI fallback、Codex account id、官方 URL 防代理泄露、限长响应、状态行控制器、`/usage` 命令和刷新缓存。
- 在 `src/index.ts` 接入自研用量控制器；删除 `@narumitw/pi-usage` 入口、`@narumitw/pi-tui-kit` 和相关 bundled dependency；保留 `src/footer/usage.ts` 的本地 token/cost 统计。
- 更新 `README.md`、manifest 测试、用量 Provider 回归测试和 `docs/work.md`。
- Phase 6 设计定稿：`SubscriptionUsageController` 提供只读 state source 给 Footer；移除 quota 对通用 extension status 文本的展示依赖，宽度变窄时由 renderer 响应式降级。
- 已实现 `SubscriptionUsageSource` 到 `FooterRenderData` 的只读订阅链路；右侧额度使用语义颜色，宽屏同列、80 列级别右对齐换行、极窄宽度保留百分比并隐藏 reset。
- 完整门禁已通过：`npm test` 33/33、`npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`（0 vulnerabilities）和 `git diff --check`。
- 宝宝目视反馈右侧模型区仍不适合额度；确认新布局为 `cost/sub · quota · elapsed`，并将 `1w` 统一改为 `7d`。
- 已移除右侧额度布局：quota 直接作为 `renderStatsLines()` 的 segment 插入 cost/sub 后、elapsed 前；周窗口标签源头改为 `7d`，跨宽度顺序回归通过。
- Phase 7 完整门禁通过：`npm test` 33/33、`npm run typecheck`、`npm run pack:check`（21 文件、49.3 kB）、`npm audit --omit=dev`（0 vulnerabilities）和 `git diff --check`。

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `npm test` | 全部回归通过 | 33/33 通过（含额度跨宽度视觉回归） | pass |
| `npm run typecheck` | 无 TypeScript 错误 | 通过 | pass |
| `npm run pack:check` | tarball 只含本扩展入口和源码 | 通过，21 个文件、49.3 kB | pass |
| `npm audit --omit=dev` | 生产依赖无漏洞 | `found 0 vulnerabilities` | pass |
| `git diff --check` | 无空白错误 | 通过 | pass |
| Provider 请求/归一化 | 四家端点、header、响应解析 | 测试覆盖 Codex、Anthropic、OpenRouter、xAI/Grok | pass |
| 缓存与退避 | 60 秒 TTL、Retry-After 防重复请求 | 回归测试通过 | pass |
| 实际 TUI 目视 | `/reload` 后核对终端主题与真实列宽 | 未自动执行，待宝宝确认 | pending |

### Errors
| Error | Resolution |
|-------|------------|
| 初始计划工具提供空模板 | 已改写为本任务的五阶段计划并完成发现/规划阶段 |
| 本地第三方版本与 GitHub 参考仓库结构不同 | Provider 接口按参考仓库取舍，认证接入按本地 Pi 0.83 API 实现 |
| 首版请求头类型不接受 `null` 值 | 用 `Object.fromEntries` 过滤非字符串 header 后通过类型检查 |
| xAI 月度账单接口可能暂时失败 | 月度窗口按可选数据处理，周额度仍可显示；认证失败仍快速终止 |
| 失败退避 key 初版与缓存 key 不一致 | 统一使用解析后凭证 fingerprint 生成的 cache key，回归测试覆盖 |
| 初查测试时误用了 `tests/footer-render.test.ts` | 文件不存在；改为读取实际 `tests/` 下的 Footer 渲染测试后继续，不影响代码或验证 |
| 重写 controller 回归断言时误删 `fetchImpl` 夹具 | `npm test`/`typecheck` 明确报 `fetchImpl is not defined`；已恢复夹具后重新执行完整验证 |
| 429 退避断言仍期待错误 notice | 新策略会保留已缓存的有效额度以避免 Footer 闪烁；断言改为验证 `ready` 缓存状态和不重复请求 |
| 计划文件更新时误把 `postEditVerify` 放入 edits 数组 | 工具未改写任何文件；按正确 schema 重发并确认写入 |

### Delivery Notes
- 工作区尚未提交或推送，等待宝宝决定是否 commit/push。
- 当前本地 Pi 已通过项目路径加载；执行 `/reload` 即可换成 `sub · quota · elapsed` 布局，不需要重复安装本地项目。
- 自动测试已覆盖排版、状态 source 和 Provider 逻辑；真实 TUI 主题与当前列宽需宝宝 `/reload` 后目视确认。

### Post-delivery Visual Iteration
- 宝宝目视反馈右侧模型区仍不适合额度；最终确定额度属于左侧会话统计。
- quota 现严格位于 `cost/sub` 后、elapsed 前，周窗口统一由 `1w` 改为 `7d`；右侧只保留 Provider/Model/Thinking。
- 自动跨宽度与顺序回归通过；等待宝宝执行 `/reload` 对当前终端实际效果做目视确认。

### Review: 当前工作区与 `b46acae`
- 用户要求全修后已完成：readmap 在调用参数/结果/diff/ls 边界净化 OSC、CSI 与其它终端控制序列；主题 ANSI 在净化之后生成。
- 429 现在若已有缓存会立即保持 `ready`，不会先闪 failure notice；无缓存或非 429 保持真实 notice。
- Anthropic、OpenRouter、xAI 与 Codex 的周窗口统一为 `7d`；`/usage` 无结果时显示简短 warning；死 `formatUsageStatus` 与重复周分支已删除。
- 完整门禁通过：`npm test` 35/35、`npm run typecheck`、`npm run pack:check`（21 文件、49.7 kB）、`npm audit --omit=dev`（0 vulnerabilities）和 `git diff --check`。
