# 调研与修订记录

## 用户要求
- 新包位置：`/home/jielumoon/opt/projects/pi-tui/pi-jielumoon`
- 包名：`pi-jielumoon-tui`
- 目标是完整拥有 `pi-vibrant-footer` 功能，只额外模仿思维链。
- 不应擅自增加 editor、Working 动画、工具 rail 或其它视觉系统。

## 迁移基线
- 迁移当前 `/home/jielumoon/opt/projects/pi-vibrant-footer` 的 `nano-context.ts`。
- 迁移 `vibrant-footer.ts` 和 `footer/` 六个模块。
- 迁移 `@narumitw/pi-usage` 与 `@narumitw/pi-tui-kit` 为 bundled dependencies。
- 思维显示使用 sakura 的 `thinking-message.ts`、渐变辅助和 prototype patch registry，视觉为 `Thought trail · N steps`、`├─ ◇`、`╰─ ◇`。

## 已删除
- 初版自定义 editor、Footer、Working、context widget、tools rail、Moon palette 和统一入口。

## 验证
- `npm run typecheck` 通过。
- `npm run pack:check` 通过，包含完整 footer 与 thinking 文件。
- `npm audit --omit=dev` 通过，0 vulnerabilities。
- 使用系统 Pi 加载四个扩展入口的 RPC 验证通过，退出码 0。
- 修正了迁移自 sakura 的 prototype patch adapter 类型遗漏。

## 彩条原版视觉证据
- 当前重构版把 used 区改成 `theme.fg(..., "█")`，free 区改成 muted `░`，与用户原图不符。
- Git 原版使用 RGB 背景色块：system `#82CA7A`、prompt `#E89BC1`、assistant `#8BC7C2`、thinking `#73D0D2`、tools `#D8A657`。
- 标签文字为 `#15181D`；free 背景为 `#242731`、文字为 `#C7D46A`，填充字符是空格。
- 两张截图的占比也不同：当前模型约 `4.8k/1.0M`，原图约 `85k/272k`；恢复样式后，色块宽度仍应按各自真实上下文占比变化。

## 错误记录
- 第一次复制 sakura 文件使用了错误路径 `/home/jielumoon/opt/projects/pi-sakura-cyberdeck`；正确路径为 `/home/jielumoon/opt/projects/pi-tui/pi-sakura-cyberdeck`，随后已改用正确路径。
- 调整 peer 依赖布局后，本地 `node_modules/.bin/pi` 被清理；改用系统 Pi 验证扩展加载，未修改包运行时依赖边界。

## pi-ui 工作状态 Shimmer 调研
- `pi-ui/src/working.ts` 使用 `setWorkingIndicator()` 配置单色 `·`，再用 `setWorkingMessage()` 每 90ms 更新彩虹渐变文案和耗时。
- retry/compaction 没有走 working indicator 配置，因此 pi-ui patch `Loader.prototype.updateDisplay`，只对 `kind=retry/compaction` 或对应状态文案做渐变，避免改变 Bash loader 与其它 Pi loader。
- 结束时通过 `appendEntry("pi-ui-elapsed", { elapsedMs })` 持久化，再用 `registerEntryRenderer` 渲染 `Worked for Ns`；本项目不迁移 pi-ui 的 todo 镜像逻辑。