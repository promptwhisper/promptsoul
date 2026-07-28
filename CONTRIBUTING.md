# Contributing / 参与贡献

感谢你帮助改进 PromptSoul。提交补丁即表示你确认自己有权按仓库的 MIT License 提供该贡献；第三方模型、图片、SDK 和其他素材仍受各自许可证约束。

## 开始之前

- 使用仍在官方支持期内的 Node.js 22+ 和 npm；推荐版本见 `.nvmrc`。
- 不要提交 API Key、`.env`、聊天记录、私有提示词、模型 ZIP、`.moc3`、纹理、`models/`、`local-assets/`、`model.config.json`、生成动作定义或验证截图。
- 不要在公开 Issue 中披露漏洞细节。请按 [SECURITY.md](SECURITY.md) 私下报告。
- Hiyori 仅用于遵守 Live2D 条款的演示。截图必须在画面内保留 `Hiyori Momose ©Live2D`。
- AI 辅助生成的代码仍需由提交者逐行审查，并确认其安全性、正确性和许可证来源。

## 本地开发

```bash
npm ci
npm run dev
```

聊天在没有 API Key 时使用确定性的本地演示回复。真实 Key 只应通过本机 UI 临时提交，或在启动进程的 shell 中导出；不要写入文件。

如果需要官方 Hiyori 演示，请先阅读 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 与 [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/)，确认同意后再显式运行：

```bash
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate
```

## 变更规则

- 保留 Next.js/Node 一体架构，不恢复 Python 运行时依赖。
- 聊天与语音 API Key 只能分别存在于 Node 进程内存中；禁止浏览器持久化、日志记录或接口回传。
- 新动作只能注册到 `PromptSoul`。不得编辑或覆盖 `Action`、`Idle`、`Tap` 等模型原有动作组。
- 更换模型后先运行 `npm run analyze:model`，不得照搬 Hiyori 参数。
- 不直接编辑 `models/` 下的 `.motion3.json` 或 `model3.json`。
- 保持手机端无横向溢出，输入字号至少 16px，交互目标至少 44×44px。
- 一个 PR 聚焦一个可审查问题，并为行为变化补充测试和文档。

## 提交前检查

普通代码改动至少运行：

```bash
npm run verify
git diff --check
```

动作、模型或视觉改动还必须运行：

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
```

请人工检查生成截图中的真实动作、版权署名和 390×844 手机布局。不要为了让测试通过而弱化动作安全校验。

`npm run verify:browser` 依赖 Chrome、Bash、`curl` 与 `seq`，应在 macOS、Linux 或 WSL 中运行；Windows 原生命令行请使用 WSL 或完成等价的手动检查。

## Pull Request

PR 描述应说明问题、方案、风险和验证结果。不要上传真实模型或密钥作为复现材料；请使用最小、无版权的测试夹具。维护者可能要求拆分过大的变更或补充许可证来源。
