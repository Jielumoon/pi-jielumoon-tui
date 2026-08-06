# Task Plan: readmap 可视化接管（pi-jielumoon）

## Goal
在 `pi-jielumoon` 内实现独立 renderer 扩展，仅替换 `pi-hashline-readmap` 的 `renderCall`/`renderResult`，保留执行层与 `LINE:HASH` 安全，并用 Sakura 风格改善 read/edit/write/bash/ls 的 TUI 展示。

## Current Phase
Phase 6 complete

## Phases

### Phase 1: Requirements & Discovery
- [x] 阅读 handoff/readmap-renderer.md
- [x] 确认项目入口、message-borders、prototype-patch-registry
- [x] 确认 readmap 0.11.2 renderer 接口与结果形状
- [x] 确认 pi-tool-display 冲突工具已关闭
- [x] 记录 findings
- **Status:** complete

### Phase 2: Planning & Structure
- [x] 定义模块边界与文件布局
- [x] 定义工具发现 / patch / 幂等策略
- [x] 定义 MVP 视觉与 diff 渲染策略
- [x] 定义测试与验证门禁
- **Status:** complete

### Phase 3: Implementation
- [x] 新增 `src/readmap-renderers.ts`（发现 + patch + 五工具 renderer）
- [x] 在 `src/index.ts` 注册 `installReadmapRenderers(pi)`
- [x] 实现 read/edit/write/bash/ls 的 `renderCall`/`renderResult`
- [x] 实现结构化 `diffData` 的宽度安全 diff 组件
- [x] 由 jielumoon 常量接管视觉折叠策略（不读取 hashline settings）
- **Status:** complete

### Phase 4: Testing & Verification
- [x] 新增 `tests/readmap-renderers.test.ts`
- [x] 跑 `npm test` / `npm run typecheck` / `npm run pack:check`
- [x] 记录 audit 已知背景（不 force fix）
- [x] 真实 Pi TUI：本轮未截图；需用户 `/reload` 或 `pi -e` 肉眼确认
- **Status:** complete

### Phase 5: Delivery
- [x] 更新 `docs/work.md`
- [x] 汇总改动文件、hook 路径、execute 不变证据、测试结果
- [x] 交付用户
- **Status:** complete

### Phase 6: ls Renderer Follow-up
- [x] 为 `ls` 增加路径/参数调用行与目录条目结果 renderer
- [x] 补空目录、截断、错误、折叠/展开与宽度安全回归
- [x] 重新运行测试、类型检查、打包检查
- **Status:** complete

## Key Questions
1. 如何发现工具对象且不改 execute？
   → `hashline:tool-executors` + `globalThis.__hashlineToolExecutors` + `registerTool` 观察器（bash）+ session/boot 再扫 global。
2. `getAllTools()` 是否足够？
   → 否（ToolInfo 无 definition）。已用 registerTool 观察器补 bash；ls 等工具从 hashline event/global payload 获取。
3. 是否自画外框？ → 否，内容组件交给 message-borders。
4. edit 默认展开？ → 不再读取外部视觉 settings，只遵循 Pi 的 expanded/Ctrl+O。
5. bash 折叠？ → 短输出直出（≤12 行且 ≤2KB），长输出 preview。
6. ls 展示？ → 折叠态只显示条目统计，展开显示带类型标记的前 N 条，并保留截断提示。

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 只 patch renderCall/renderResult | 不碰执行层 |
| Symbol 标记幂等 | reload 不叠加 |
| 自研 DiffBodyComponent | 不耦合 readmap 私有类 |
| registerTool 观察器兜 bash | bash 不在 tool-executors |
| 单文件 MVP | 反过度设计 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Theme vs ThemeLike 类型不兼容 | 1 | asThemeLike(unknown) 宽化 |
| edit replace 锚点过期 | 1 | 改用 replace_lines + 重跑验证 |

## Notes
- 真实 TUI 需用户本地确认：`pi -e /home/jielumoon/opt/projects/pi-tui/pi-jielumoon` 或 `/reload`
- audit 仍有 Pi 0.83 undici/brace-expansion 上游公告，未 force fix
