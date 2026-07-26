<p align="center">
  <img src="./docs/images/promptsoul-banner.svg" width="100%" alt="PromptSoul gives local AI characters a visible soul through emotion-driven Live2D and safe motion generation">
</p>

# PromptSoul

简体中文 · [English](README.en.md) · [日本語](README.ja.md)

PromptSoul 是一个前后端一体的 AI Live2D NPC 原型。用户发消息后，Next.js 服务端返回角色回复与情绪，浏览器把情绪映射成 Live2D 动作；“动作工坊”还能把自然语言描述编译成当前模型可安全表达的新动作。

> AI 不会直接修改网格、骨骼或 Cubism 绑定。所有动作都只能使用模型已有参数，并且只能注册到项目自有的 `PromptSoul` 动作组。

**从这里开始：**[快速开始](#快速开始) · [接入 AI](#接入-ai) · [用提示词生成动作](#用提示词生成动作) · [更换模型](#更换-live2d-模型) · [安全边界](#安全说明)

<sub>演示角色：Hiyori Momose ©Live2D；模型数据不包含在仓库中。</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## 快速开始

需要仍在官方支持期内的 Node.js 22+、npm、现代浏览器和网络连接，不需要 Python。页面会从官方 CDN 加载 Live2D Cubism Core、PixiJS 与 `pixi-live2d-display`。

```bash
npm ci

# 首次使用：阅读并接受 Live2D 条款后下载官方 Hiyori 样例
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate

npm run dev
```

打开 <http://127.0.0.1:8765>。不配置 API Key 时，聊天使用确定性的本地演示回复；Live2D、已有动作和交互仍然可用。动作工坊需要连接 AI Provider。

生产模式使用同一个 Node 服务：

```bash
npm run build
npm start
```

PromptSoul 需要读取和写入本机模型工作副本，并把临时 Key 保存在进程内存中，因此应使用 Node 自托管运行时，不要部署到 Edge 或无持久磁盘的 Serverless 运行时。Next 的文件跟踪也显式排除了 `models/`、`local-assets/`、`model.config.json` 和 AI 生成定义；部署时应由你在有权限的主机上单独挂载这些本地数据。

生产构建显式使用 Next 支持的 Webpack 构建器，以保持这类运行时动态模型文件跟踪可预测。开发服务仍使用 Next 默认的快速构建链路。

## 接入 AI

页面右上角的“AI Provider”设置支持填写 OpenAI 兼容的 API 地址、模型和 API Key。安全边界如下：

- 浏览器只提交一次 Key，应用不会写入 `localStorage`、Cookie、配置文件或 Git；
- Node 后端只在当前进程内存中保存 Key，公开接口不会返回它，服务重启后自动清除；
- Provider 配置修改只接受本机回环地址上的同源 JSON 请求；
- 远程 Provider 必须使用 HTTPS，只有 `localhost` / `127.0.0.0/8` / `::1` 本机服务可使用 HTTP；
- 聊天和动作生成都由后端调用 Provider，Key 不会被加入模型文件或动作定义。
- 角色设定、聊天内容和动作提示词会发送给你配置的 Provider；Live2D 模型文件、原始参数 ID 和动作曲线不会发送。

长期运行或无人值守部署仍建议使用服务端环境变量：

```bash
export NPC_API_KEY="你的 API Key"
export NPC_API_BASE="https://api.openai.com/v1"
export NPC_MODEL="gpt-5.6-luna"
npm start
```

| 变量 | 说明 | 默认值 |
|---|---|---|
| `NPC_API_KEY` | 首选服务端 API Key | 未设置时读取 `OPENAI_API_KEY` |
| `OPENAI_API_KEY` | 兼容现有 OpenAI 配置的备用 Key | 无 |
| `NPC_API_BASE` | OpenAI 兼容 API 根地址 | `https://api.openai.com/v1` |
| `NPC_MODEL` | 模型名称 | `gpt-5.6-luna` |

`gpt-5.6-luna` 是项目当前默认的 Provider 模型名，并非所有 OpenAI 兼容服务都提供；如果服务返回“模型不存在”，请在设置面板或 `NPC_MODEL` 中改成该 Provider 实际支持的模型。

前端临时配置优先于环境变量；点击“清除临时 Key”后恢复环境变量或演示模式。

## 用提示词生成动作

连接 AI Provider 并导入模型后，页面底部的“动作工坊”会自动启用。输入“先惊讶地睁大眼睛，轻轻后仰，再点头回到原位”一类描述，服务端会：

1. 从模型原有动作估计安全参数范围、基础姿势和物理输出；
2. 只向 Provider 提供不透明控制编号、语义名称和标准化值；
3. 严格校验结构化 JSON，拒绝任意代码、未知参数、物理输出、`PartOpacity`、越界值以及未回到基础姿势的曲线；
4. 原子写入动作，并且只更新 `PromptSoul` 组；`Action`、`Idle`、`Tap` 等模型原有组不会被覆盖；
5. 重新加载模型并自动预览生成结果。

AI 定义保存在 `motion-defs/generated/<model>/`，运行文件保存在 `models/`；它们都是本地工作产物并被 Git 忽略。相同描述会更新同一个动作，每个模型最多保存 24 个 AI 动作。`npm run motions:generate` 会恢复已经验证过的 AI 动作。

动作库只会为 `promptsoul_ai_*` AI 动作显示删除入口。确认删除后，服务端会在写锁内同时移除保存的定义、运行文件和 `PromptSoul` 注册；7 个内置动作以及模型原有的 `Action`、`Idle`、`Tap` 等动作组不能从页面删除。

如果当前模型无法自然、安全地表达描述，接口会返回“不可实现”，而不是强行写入不合适的参数。

## 更换 Live2D 模型

模型目录或 ZIP 必须包含 Cubism 4 的 `*.model3.json` 及其引用的纹理、`.moc3`、物理和动作文件。

```bash
npm run setup:model -- /path/to/model-folder-or.zip
npm run analyze:model
```

必须先阅读分析结果，再为该模型创建 `motion-defs/<model-name>.ts`。不要直接照搬 Hiyori 参数；不同模型的参数含义、安全范围和基础姿势不同。可参考随仓库提供的 `motion-defs/hiyori_pro_t11.ts`。

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
npm run dev
```

更换角色后还要更新 `npc.config.json` 中的角色信息与 `modelAttribution`，确保舞台和页脚持续显示模型许可证要求的署名。

`npm run verify:browser` 需要 Chrome；非 macOS 环境可指定路径：

```bash
CHROME=/path/to/chrome npm run verify:browser
```

该脚本使用 Bash、`curl` 和 `seq`，支持 macOS、Linux 或 WSL；Windows 原生命令行请在 WSL 中运行，或执行等价的手动浏览器检查。

完整的 Agent 工作流和动作设计约束见 [AGENTS.md](AGENTS.md)。

## 项目结构

```text
app/                         Next.js 页面与 Route Handlers
components/                  React UI（包括内存 Key 设置面板）
assets/                      Live2D 浏览器运行时与响应式样式
lib/server/                  Provider、聊天、模型和动作安全逻辑
scripts/                     Node/TypeScript CLI
tests-node/                  node:test 自动化测试
motion-defs/<model>.ts       模型专属基础动作定义
motion-defs/generated/       本地 AI 动作定义（Git 忽略）
npc.config.json              角色、欢迎语、快捷问题和署名
model.config.json            当前模型配置（本地生成，Git 忽略）
local-assets/ , models/      授权受限或生成的模型数据（Git 忽略）
```

## 验证

代码或动作修改完成后运行：

```bash
npm run typecheck
npm test
npm run motions:generate
npm run motions:validate
node --check assets/app.js
npm run build
git diff --check
```

不依赖授权模型数据的通用检查也可以一次运行：

```bash
npm run verify
```

涉及视觉或交互时，再运行 `npm run verify:browser`，并检查桌面与手机布局没有横向溢出。

## 安全说明

- 不要把真实 API Key 写入源码、`.env` 提交、截图、日志或模型文件。前端填写只适合本机开发；生产部署优先使用环境变量和外部 Secret 管理。
- 当前服务没有账号、租户隔离、公网鉴权或限流，只绑定 `127.0.0.1`，不要直接暴露到公网。
- 动作生成会修改本地模型工作副本，但只接受本机同源请求，并且始终受独立校验器约束。
- Hiyori 下载固定到 Live2D 官方 HTTPS 地址；通用模型导入器会拒绝路径穿越、符号链接、特殊文件、ZIP64、加密条目和超限压缩包。仍应只导入你有权使用且可信的模型。
- 页面的三个 SDK 依赖使用固定版本/内容的 SRI 校验和 CSP 来源限制。PixiJS 6 的 WebGL 同步器需要 CSP `unsafe-eval`，因此 SRI 是 CDN 内容篡改的主要防线。离线或生产部署时仍建议在各自许可证允许的前提下自行托管固定依赖。

## 许可证与上游

- 本仓库中版权持有人有权许可的代码和文档采用 [MIT License](LICENSE)，并保留上游 MIT 版权声明；该许可证不覆盖下面列出的模型、SDK 或用户素材。
- Hiyori 模型不包含在仓库中。下载或使用前必须同意 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 与 [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/)。Hiyori 的角色设计不得修改。
- Live2D Cubism Core 受 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 约束。
- PixiJS 与 `pixi-live2d-display` 使用各自许可证；你导入的模型和素材仍受原作者许可约束。

完整的第三方归属和许可证边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开包含漏洞细节、API Key 或受限模型。

PromptSoul 基于 [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui) 扩展。上游项目验证了“不打开 Cubism Editor，仅用 JSON 为现有 Live2D 参数增加动作”的工作流；感谢原作者。
