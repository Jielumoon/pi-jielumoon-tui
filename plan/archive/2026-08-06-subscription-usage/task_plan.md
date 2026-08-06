# Task Plan: 自研订阅用量 Provider

## Goal
移除内置的 `@narumitw/pi-usage`，在本扩展内自研 Codex、Anthropic、OpenRouter、xAI/Grok 四个用量适配器，并继续把当前模型的额度稳定显示在 Footer。

## Current Phase
Phase 8：审查问题修复 complete

## Phases

### Phase 1: Requirements & Discovery
- [x] 确认范围：Codex、Anthropic、OpenRouter、xAI/Grok
- [x] 对照现有 Footer 生命周期、状态栏和 token/cost 统计
- [x] 核对参考项目的接口、认证与缓存策略
- [x] 记录实现边界与安全约束
- **Status:** complete

### Phase 2: Planning & Structure
- [x] 定义自有模块的数据结构和 Provider 契约
- [x] 定义认证解析、官方域名校验、缓存与刷新策略
- [x] 规划 `/usage` 命令和 Footer status 集成
- [x] 确定依赖、包入口与回归测试调整范围
- **Status:** complete

### Phase 3: Implementation
- [x] 实现四个 Provider 的请求与响应归一化
- [x] 实现认证、缓存、退避和状态行控制器
- [x] 接入 `src/index.ts`，移除第三方扩展和依赖
- [x] 补齐单元测试、包清单和 README
- **Status:** complete

### Phase 4: Testing & Verification
- [x] 运行 `npm test`
- [x] 运行 `npm run typecheck`
- [x] 运行 `npm run pack:check`
- [x] 运行 `npm audit --omit=dev` 并区分既有上游公告
- [x] 检查四个 Provider、缓存 TTL、429 退避、官方域名限制和 stale context
- **Status:** complete

### Phase 5: Delivery
- [x] 更新 `docs/work.md` 与交接说明
- [x] 检查工作区 diff、打包内容和无密钥泄露
- [x] 向宝宝报告实现范围与实际验证结果
- **Status:** complete

### Phase 6: Footer 额度视觉整合
- [x] 确认视觉方向：额度属于当前模型右侧信息；重置格式固定为 `↻ 1h`
- [x] 将当前结构化额度快照接入 Footer，移除通用左对齐 status 依赖
- [x] 实现宽屏同列、受限宽度右对齐换行、窄屏紧凑降级
- [x] 补充跨宽度、重置间距和旧 extension status 兼容回归测试
- [x] 运行完整验证门禁并记录实际效果
- **Status:** complete

### Phase 7: 额度归入会话统计
- [x] 确认视觉归属：紧跟 `cost/sub`，位于 elapsed 前
- [x] 移除右侧额度布局，改为左侧 session metric segment
- [x] 将周窗口统一由 `1w` 改为 `7d`
- [x] 更新跨宽度、顺序和标签回归测试
- [x] 运行完整验证门禁并记录实际效果
- **Status:** complete

### Phase 8: 审查问题修复
- [x] 复现并确认 readmap 的终端控制序列透传与 429 缓存闪烁
- [x] 在 readmap 外部文本边界净化终端控制序列并补回归测试
- [x] 429 时保留已有缓存 ready 状态，并补即时状态回归
- [x] 统一所有 Provider 的周标签为 `7d`，为 `/usage` 失败提供反馈
- [x] 删除死 formatter/重复分支，运行完整验证门禁
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 只实现 Codex、Anthropic、OpenRouter、xAI/Grok | 宝宝明确指定四家，避免复制参考项目未要求的 Provider |
| 保留 `src/footer/usage.ts` 的会话 token/cost 统计 | 它统计本地会话消耗，不等于订阅额度，不能误删 |
| 用本扩展的 `SubscriptionUsageSource` 向 Footer 提供结构化额度快照 | Footer 直接消费数据并监听更新，不再把额度编码进 `ctx.ui.setStatus("usage", ...)` 的左对齐文本 |
| Footer 状态只查询当前模型 | 与现有状态栏语义一致；多 Provider 详情通过 `/usage` 当前实现展示，避免后台并发轰炸 |
| 默认缓存 60 秒，刷新遵守 TTL，失败按 Retry-After/60 秒退避 | 继承参考项目修复，避免 `turn_end`/工具事件造成 429 闪烁 |
| 认证优先使用 Pi ModelRegistry，并校验模型/解析出的官方 base URL | 不读取未知代理的凭证去请求官方额度接口，避免跨域泄露 |
| xAI/Grok 使用 OAuth access token和 `cli-chat-proxy.grok.com` billing 接口 | Grok 订阅额度不是普通 xAI API token 的 usage；接口契约来自参考项目 |
| 不引入新的运行时依赖 | 四个 Provider 都是简单 HTTP JSON 请求，避免再次形成黑盒 usage 包 |
| 结构化额度 source 与 Footer renderer 分离 | Provider/缓存层不因位置调整而改动；仅 renderer 决定其在 session metrics 的位置与样式 |
| 订阅额度紧跟 cost/sub，位于 elapsed 前 | 它表达会话订阅消耗而非模型身份；与 context、traffic、cache、cost 同属左侧 metrics 流 |
| readmap 在主题着色前净化所有外部文字 | Pi TUI `Text` 保留 ANSI；文件、命令和模型参数不得传递 OSC/CSI 控制序列给终端 |
| 429 遇到已缓存额度时继续发布 ready | 额度显示避免在 Retry-After 期间闪成失败文案；无缓存或非 429 仍给出真实错误状态 |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| 参考仓库 README 与本地 `@narumitw/pi-usage` 版本不是同一实现 | 以 `juanibiapina/pi-usage` 当前源代码作 Provider 蓝本，以本地 Pi 0.83 的 ModelRegistry API 作认证接入 |
| Codex account id 不一定会出现在通用 Authorization header | 实现中从 Pi 解析后的认证和存储 OAuth credential 的 `accountId` 可选字段补充 `ChatGPT-Account-Id` |

## Scope Notes
- 不改变 `SessionUsageCollector` 的输入/输出/cache/cost 统计。
- 不复制参考项目的 Copilot、Gemini、Antigravity、Kiro、z.ai。
- 不把 API token、OAuth token、响应错误正文写入 Footer、日志或计划文件。
- API 响应只解析有限字段；未知字段忽略，错误正文截断且不展示给用户。
