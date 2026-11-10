# 已知问题

## Linux 的 Wayland 环境下，电脑操控功能受限

Cue 的电脑操控 driver 在 X11 下工作最完整。Wayland 下部分查看和操作功能不可用。

需要完整电脑操控时，请使用 X11 会话。

## Windows 上无法直接导入使用 v20 加密的 Chrome 和 Edge Cookie

先用浏览器扩展把 Cookie 导出为文件，再导入 Cue。

## 本地 Agent 会保留自己的全局设置

部分本地 Agent CLI 会全局保存选中的模型或账号。在 Cue 里改动后，终端里的同一个 CLI 也可能受影响。

不想改动 CLI 的全局模型时，请选择 **CLI 默认**。
