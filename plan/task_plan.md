# pi-jielumoon-tui 修订计划

## Goal
完整继承 `pi-vibrant-footer` 的功能，只额外加入 sakura 风格的 Thought trail 思维链显示。

## Current Phase
Complete

## Phases
### Phase 1: 迁移 Footer 功能
- [x] 迁移 Footer、nano-context、settings、usage、Blackhole
- [x] 迁移运行时 bundled dependencies
- **Status:** complete

### Phase 2: 加入 Thought trail
- [x] 迁移 sakura 的 `Thought trail · N steps`
- [x] 保留 `├─ ◇` / `╰─ ◇` 树形结构
- **Status:** complete

### Phase 3: 删除无关 UI
- [x] 删除自定义 editor
- [x] 删除自定义 Working 动画
- [x] 删除自定义工具 rail
- **Status:** complete

### Phase 4: 验证和安装
- [x] 类型检查
- [x] npm 打包检查
- [x] 运行时审计
- [x] Pi 扩展加载验证
- [x] 移除旧 `pi-vibrant-footer` 安装项
- **Status:** complete

### Phase 5: 修复彩条视觉
- [x] 根据截图定位低用量时 used segment 标签吞掉彩色块的问题
- [x] 验证彩色标签在当前主题下可见（终端 ANSI 输出为主题色）
- [x] 重新加载并确认 Pi 中的实际显示（TUI 启动与彩条渲染正常）
- **Status:** complete

### Phase 6: 恢复原版彩条
- [x] 对比当前截图与原版截图
- [x] 从 Git 原始版本确认背景色块实现
- [x] 恢复原版背景色、文字色和空格填充
- [x] 验证并重新安装
- **Status:** complete

### Phase 7: 调整扩展状态布局
- [x] 将 `planning-with-files` 状态与其它扩展状态分离
- [x] 将计划状态右对齐到 Footer 最右侧
- [x] 类型检查、重新安装并进行 TUI 输出验证
- **Status:** complete

### Phase 8: 简化 Thought trail 并重命名命令
- [x] 将 Footer 命令从 `/vibrant-footer` 改为 `/jielumoon-tui`
- [x] 让 `/jielumoon-tui` 无参数直接打开设置面板
- [x] 同步 README 命令说明
- [x] 移除 Thought trail 每步内容开头的 `Thinking:` 前缀
- [x] 初始化 Git 仓库并提交最终版本
- **Status:** complete

### Phase 9: 统一 Thought trail 正文颜色
- [x] 修复只有第一条思考正文带颜色的问题
- [x] 让所有正文统一经过 `softBody()`，保留树枝和菱形渐变
- [x] 类型检查、打包检查、审计并重新安装
- **Status:** complete

### Phase 10: 增加消息边框
- [x] 确认用户消息独立、助手回复含 Thought trail、工具调用保持独立
- [x] 设计与 Thought trail/工具调用兼容的消息卡片
- [x] 实现、验证并重新安装
- **Status:** complete

### Phase 11: 还原 Sakura 用户消息样式
- [x] 使用 Sakura 默认粗 rail `▐` 替代细线 rail
- [x] 迁移完整 macaron Markdown 主题映射
- [x] 类型检查、打包检查、审计并重新安装
- **Status:** complete

### Phase 12: 增加计划状态显示开关
- [x] 新增独立 `planning` Footer 设置项，默认开启
- [x] 设置面板和 `/jielumoon-tui planning on/off` 可切换
- [x] 关闭时只隐藏 `planning-with-files` 状态，不影响其它扩展状态
- [x] 类型检查、打包检查、审计并重新安装
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 以 `pi-vibrant-footer` 为唯一功能基线 | 先保证已有 Footer 功能完整，不重新发明数据和设置系统 |
| 只迁移 Thought trail | 用户明确不需要额外 editor、Working 和工具视觉 |
| Pi 核心包只放 peerDependencies | 由宿主 Pi 提供，避免把宿主依赖和审计风险打进包 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| sakura 文件复制路径错误 | 1 | 改用 `/home/jielumoon/opt/projects/pi-tui/pi-sakura-cyberdeck` |
| prototype patch adapter 类型遗漏 | 1 | 补充 `assistant-thinking-hidden-render` 类型 |
| 本地 Pi binary 被 peer 依赖清理 | 1 | 改用系统 Pi 验证扩展加载 |
