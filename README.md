# pi-jielumoon-tui

`pi-jielumoon-tui` 是 Pi 的扩展包：完整继承 `pi-vibrant-footer` 的 Footer 能力，只额外加入 sakura 风格的 Thought trail。

- Footer：路径、分支、模型、上下文、token、费用、会话时间和 Blackhole 状态
- Provider usage、缓存、扩展状态和上下文用量彩条
- `✦ Thought trail` 树形思考显示，支持折叠预览
- `/jielumoon-tui` 配置面板与 Footer 显示开关

不接管 Pi 默认编辑器、Working 动画或工具执行组件。

## 本地试用

```bash
pi -e /home/jielumoon/opt/projects/pi-tui/pi-jielumoon
```

## 安装

```bash
pi install /home/jielumoon/opt/projects/pi-tui/pi-jielumoon
```

加载后可用以下命令：

```text
/jielumoon-tui              打开设置面板
/jielumoon-tui settings     打开设置面板
/jielumoon-tui on            开启 Footer
/jielumoon-tui off           恢复 Pi 默认 Footer
/jielumoon-tui reset         恢复 Footer 默认显示项
```

## 开发

```bash
npm install --legacy-peer-deps
npm run typecheck
npm run pack:check
```

配置会继续保存在 Pi agent 目录的 `pi-vibrant-footer.json` 中，以保持已有 Footer 设置兼容。
