# Findings & Decisions

## Requirements

- 自研订阅用量显示，范围固定为：OpenAI Codex、Anthropic/Claude、OpenRouter、xAI/Grok。
- 删除 `@narumitw/pi-usage` 的独立扩展入口、依赖和 bundled dependency；`@narumitw/pi-tui-kit` 若无其它引用一并删除。
- 当前 Footer 的会话 token/cost 统计必须保留；它来自 `src/footer/usage.ts`，与订阅额度是两套数据。
- 当前模型额度作为 Footer 左侧会话统计 segment，紧跟 cost/sub、位于 elapsed 前；不再作为右侧模型信息或左对齐通用 `usage` extension status 显示，不泄露 token 或完整 API 错误正文。
- `npm test`、`npm run typecheck`、`npm run pack:check` 必须通过；依赖变更后执行 `npm audit --omit=dev`。

## Research Findings

### 本地架构

- `src/vibrant-footer.ts` 管 Footer 生命周期、30 秒轻量刷新循环以及 `footerData.getExtensionStatuses()`；`renderStatsLines()` 已有 Provider/Model/Thinking 右侧布局位。
- `src/footer/render.ts` 的 extension status 是独立整行，只有 planning 会右对齐，因此不适合承载模型额度。
- `src/footer/types.ts` 的 `FooterRenderData` 可安全追加可选结构化额度状态；`renderFooter()` 纯函数适合跨宽度回归测试。
- `tests/footer-format.test.ts` 是实际 Footer 格式测试入口；此前误猜的 `tests/footer-render.test.ts` 不存在。
- `src/footer/usage.ts` 的 `SessionUsageCollector` 只累计当前会话 assistant message 的 input/output/cache/cost，不能替换成 quota collector。

### 参考项目和接口

- `juanibiapina/pi-usage` 当前源代码使用四个目标接口中的三个相同契约：
  - Codex：`GET https://chatgpt.com/backend-api/wham/usage`，响应 `rate_limit.primary_window`、`secondary_window`、可选 `additional_rate_limits`、`credits`。
  - OpenRouter：`GET https://openrouter.ai/api/v1/key`，响应位于 `data`，关键字段为 `limit`、`limit_remaining`、`limit_reset`、`usage_daily/weekly/monthly`、`usage`。
  - xAI/Grok：`GET https://cli-chat-proxy.grok.com/v1/billing` 和 `?format=credits`，响应 `config.monthlyLimit.val`、`used.val`、`billingPeriodEnd`、`creditUsagePercent`、weekly `currentPeriod`。
- 参考项目的 Anthropic provider 使用 `GET https://api.anthropic.com/api/oauth/usage`，header 为 `Authorization: Bearer <OAuth access>` 和 `anthropic-beta: oauth-2025-04-20`；响应 `five_hour`、`seven_day`、`extra_usage`。
- 参考项目的两个关键修复纳入自研实现：显式非目标 provider 不做模型名误判；刷新遵守缓存 TTL，不在每次 turn/tool 结束时强刷。
- 本地 Pi 0.83 的 `ModelRegistry` 提供 `getApiKeyAndHeaders(model)`、`getProviderAuth(provider)`、`getProviderAuthStatus(provider)`；认证应优先走这些 API。
- `readStoredCredential(providerId)` 可在需要时读取非展示性的 OAuth 扩展字段，例如 Codex OAuth credential 的可选 `accountId`；不能把 credential 内容写日志或 UI。

### 认证和安全边界

- 当前模型必须与目标 Provider 匹配，并且模型 `baseUrl`/解析后的 `auth.baseUrl` 必须是对应官方域名；自定义代理不能把凭证送到官方额度接口。
- Codex、Anthropic、xAI/Grok 的订阅接口按 OAuth access token 处理；OpenRouter 使用当前模型解析出的 API key。
- 所有请求使用 `AbortController`，默认 5 秒超时；响应体限制在小范围内，错误正文只用于内部归一化为状态文本，不展示 token/正文。
- header 合并要保留 Pi 解析出来的必要 header；`Authorization` 统一归一化，避免输出 secret。

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 新增 `src/footer/subscription-usage.ts` | 将 quota provider、缓存和状态控制器与现有 session token 统计分开，避免污染 `usage.ts` |
| 内部统一 `UsageSnapshot`：provider/displayName/windows/capturedAt/error | 四家返回数据形状不同，但 Footer 只需要有限额度窗口和重置时间 |
| 状态控制器查询当前模型并写 `ctx.ui.setStatus("usage", ...)` | 复用既有 Footer 状态渲染，不再依赖第三方 UI 包 |
| `/usage` 只做当前模型强制刷新并用 notify 展示简要明细 | 保留原扩展的可手动查询入口，但不复制复杂菜单和额外 Provider 浏览器 |
| 60 秒成功 TTL、错误 60 秒退避、Retry-After 优先 | 降低 429 风险；同一 Provider 的过期失败不会在事件风暴中重复请求 |
| 同一时刻单请求、generation/stale context 防护 | 模型切换或 reload 后旧请求不能覆盖新状态 |
| 额度视觉接入 `FooterRenderData` 的结构化快照，而非解析 `formatUsageStatus()` 字符串 | 色彩、窗口数、右对齐和响应式降级必须基于数据结构，不能对展示文本做二次拆解 |
| 额度紧跟 cost/sub 插入左侧 session metrics，位于 elapsed 前 | 额度反映订阅消耗，和 context/traffic/cache/cost 同属会话统计；右侧只保留 Provider/Model/Thinking 身份信息 |
| 重置文案统一为 `↻ 1h` | 箭头与时间单位必须留空格，避免字符粘连造成调试文本观感 |
| `SubscriptionUsageController` 暴露只读 source（`getState`/`subscribe`），由 `installSubscriptionUsage()` 返回给 Footer | 不使用全局可变状态，也不把结构化数据编码成 `setStatus` 字符串；source 更新直接请求 Footer 重绘 |
| 继续用 `settings.extensions` 控制订阅额度可见性 | 保留原来“关闭扩展状态会隐藏 usage”的用户配置语义，设置标签改为“扩展状态 / 订阅额度” |
| 周窗口标签统一为 `7d`，不显示 `1w` | 与 `5h`、`1d` 使用同一时间轴，避免内部风格缩写造成视觉突兀 |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 计划工具初始生成的是空模板 | 已写入本任务的五阶段计划、发现和决策，进入实现前的完整结构阶段 |
| 参考仓库使用 `.js` 扩展而本项目源码使用 `.ts` | 新模块遵循本仓库 TypeScript 原生 ESM 风格和 `strict` 类型检查 |

## Resources

- `https://github.com/juanibiapina/pi-usage`
- `/tmp/pi-usage-research.dv5wnJ`：本轮只读 clone 的参考源码
- 本地 `node_modules/@narumitw/pi-usage/src/`：已移除目标依赖前的当前实现，仅用于行为对照
