# 参与 Cue 开发

## 规则

1. 通过 `ds-bot/src/engine/` 使用 Cue 自有的 Pi Durable host。
2. 不要修改依赖包，也不要使用它们的私有文件。
3. 不要提交 key、token、Cookie、含个人数据的日志或用户数据文件夹。
4. 只能引入与 Apache 2.0 兼容的第三方代码，并在 `NOTICE` 里记录。
5. 测试使用临时文件夹和模拟服务。

## 协作流程

功能和修复的 Pull Request 提到 `dev`。`main` 只用于发版和紧急修复。已经推送的分支不要 rebase 或 force-push。

Pull Request 要链接 Issue，说明用户能看到的改动和已运行的检查。改动已定行为前，先读 `docs/plans/` 中的相关文件。

## 搭建环境

核心：

```sh
cd ds-bot
npm ci
npm run build
npm test
npm run lint
```

桌面应用：

```sh
cd app
npm ci
npm run build
npm test
```

Docker：

```sh
docker compose up --build
```

## 目录

- `ds-bot/src/engine/`：Pi Durable 适配层和自有 host
- `ds-bot/src/host/`：Bot 和团队行为
- `ds-bot/src/client/`：共用界面代码
- `ds-bot/src/server/`：自有 HTTP 边界
- `ds-bot/test/`：核心测试
- `app/`：Electron 应用和桌面界面
- `docker/`：独立 host 镜像

## 测试改动

编辑时先运行最接近的测试文件。改动横跨核心和桌面应用时，在提 Pull Request 前运行两边的完整测试。改界面后构建桌面应用。改 Docker 或 server 边界后构建 Docker 镜像。

## 写代码

遵循周围代码的写法。函数保持小，名字用简单词。注释隐藏约束，不要重复代码。中英文用户文字要同步。

## 报告问题

请提供 Cue 版本、操作系统、模型 provider、复现步骤、预期结果、实际结果和已脱敏日志。不要附上 key、token、Cookie 或私密对话内容。

## 许可

贡献使用 [Apache License 2.0](LICENSE)。
