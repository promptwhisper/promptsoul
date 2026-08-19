<p align="center">
  <img src="./docs/images/promptsoul-banner.svg" width="100%" alt="PromptSoul AI Live2D NPC">
</p>

# PromptSoul

简体中文 · [English](README.en.md) · [日本語](README.ja.md)

PromptSoul 是一个本地优先的 AI Live2D NPC 原型。它支持流式聊天、情绪动作、本地语音与实时口型，也能根据提示词为当前模型生成受约束的新动作。

- Next.js 前后端一体运行
- AI 回复自动触发 Live2D 情绪动作；可选 DSH 后端支持实时参数 cue
- AivisSpeech 本地语音与 Web Audio 实时口型
- 使用提示词生成、预览和删除安全动作
- 支持导入自定义 Cubism 4 模型

<sub>演示角色：Hiyori Momose ©Live2D。模型数据不包含在仓库中。</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## 快速开始

需要 Node.js 22.19+、npm 和现代浏览器，不需要 Python。首次安装和页面加载需要网络连接。

Hiyori 是 Live2D 官方示例模型。运行下载命令前，请先阅读并接受 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 和 [Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/)。

```bash
npm ci
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate
npm run dev
```

打开 <http://127.0.0.1:8765>。

没有配置 LLM API Key 时，聊天会使用确定性的本地演示回复；AivisSpeech 没有启动时，不会阻断文字聊天、Live2D 和动作功能。

## 配置 AI 对话

在 `.env.local` 中填写服务端配置：

```dotenv
NPC_API_KEY=your-key
NPC_API_BASE=https://api.openai.com/v1
NPC_MODEL=gpt-5.6-luna
```

`NPC_MODEL` 必须改成所用 OpenAI-compatible Provider 实际支持的模型。也可以使用 `OPENAI_API_KEY` 作为备用变量。

API Key 只由 Node.js 服务端读取，不会发送到浏览器，也不要把 `.env.local` 提交到 Git。修改配置后需要重启服务。

角色设定、聊天内容和动作提示词会发送给你配置的 Provider，但 Live2D 模型文件、原始参数和动作曲线不会发送。

## DeepSeek Harness 实时对话（可选）

默认聊天链路保持不变。需要让回复片段和 Live2D 动作按语音时间实时同步时，可在 `.env.local` 中启用 DSH：

```dotenv
CHAT_BACKEND=dsh-realtime
DEEPSEEK_API_KEY=your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DSH_MODEL=deepseek-v4-flash
```

DSH 会把每个通过校验的 NDJSON 片段立即交给浏览器：文本进入现有 TTS 队列，短期 cue 按同一个 AudioContext 时钟逐帧执行。cue 只存在于内存，不会写入 `.motion3.json`、修改模型动作组或替代“动作工坊”。TTS 不可用时会退回性能时钟和已有情绪动作。

DSH 会收到当前模型可用控制的原始 Cubism Parameter/PartOpacity ID、范围和基础值，以及按请求选出的最多 3 份完整、未经删减的现有 `.motion3.json`。实时协议支持单 cue 最多 40 条曲线、每条 64 个关键点，足以参考 Hiyori `hiyori_m08` 的 35 条原始曲线生成全身多部件协同动作。`PartOpacity` 只能与同一 cue 中的主姿势曲线配合使用，浏览器会在 cue 结束、取消或模型卸载时恢复原值。参考配置不会被直接写回模型或持久化为动作。

对跳舞、摇头、点头、挥手等明确动作请求，服务端会把“轻柔 / 普通 / 大幅”对应的最低主曲线幅度（40% / 65% / 85%）、动作时长和往返次数交给 DSH。服务端不会替 DSH 生成或放大曲线；输出不达标时会把校验原因反馈给 DSH 重生成，浏览器只播放最终通过校验的 DSH cue。离线语音模式下每个动作片段保留 3 秒。

`DEEPSEEK_API_KEY` 仅由服务端读取，DSH 子进程也只接收必要的白名单环境变量。DSH 会收到上述原始控制元数据和完整动作 JSON 参考，但不会收到 `.moc3`、纹理、API Key、reasoning 或 Provider 错误正文；同源浏览器只接收服务端解析并校验后的临时曲线。关闭 `CHAT_BACKEND` 即恢复原有 Provider/本地演示链路。

## 配置本地语音（可选）

PromptSoul 通过本机 [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) 合成语音，不需要云 TTS Key。

1. 安装并启动 AivisSpeech。
2. 在 AivisSpeech 中导入你有权使用的声音模型。
3. 将 [`.env.example`](.env.example) 中需要的 TTS 配置复制到 `.env.local`。
4. 检查声音并生成一段测试音频：

```bash
npm run tts:check
npm run tts:smoke
npm run dev
```

默认配置查找 `コハク / あまあま`。`AIVIS_STYLE_ID` 通常应留空，由服务端通过 `/speakers` 解析当前机器的全局 Style ID；不要直接使用模型内部显示的 Style ID `1`。

启动后可在页面右上角的“本地语音”面板中试听。浏览器只访问同源 `/api/tts`，不会直接连接 AivisSpeech 的 10101 端口。语音失败只会跳过播放，不影响文字回复和情绪动作。

本地语音缓存可能包含合成后的对话内容。共享设备上可设置 `TTS_CACHE_ENABLED=false`，已有缓存可在停止服务后删除 `.cache/aivis-tts/`。

## 用提示词生成动作

先配置 AI Provider 并加载模型，然后在页面的“动作工坊”输入动作描述。生成结果会自动校验、保存并预览。

新动作只会写入项目自有的 `PromptSoul` 动作组，不会覆盖模型原有的 `Action`、`Idle`、`Tap` 等动作。模型不能安全表达的动作会被拒绝。

生成定义位于 `motion-defs/generated/`，运行文件位于 `models/`，两者都是本地生成内容，不会提交到 Git。

## 提示词换装与衣服预设

PromptSoul 可以连接 [PromptSkin](https://github.com/promptwhisper/PromptSkin)，在页面的“Prompt Wardrobe”中用提示词生成新衣服，也可以在已经生成的衣服和模板原始服装之间即时切换。

先启动 PromptSkin 后端（默认 `127.0.0.1:8000`），再把以下配置写入 PromptSoul 的 `.env.local`：

```dotenv
PROMPTSKIN_API_BASE=http://127.0.0.1:8000
PROMPTSKIN_PROVIDER=openai
PROMPTSKIN_GENERATION_TIMEOUT_MS=720000
```

OpenAI 图片 Key 只配置在 PromptSkin 后端，不要放入 PromptSoul 或浏览器。也可把 `PROMPTSKIN_PROVIDER` 设为 `mock` 验证完整流程。

每次生成时，PromptSoul 会在服务端临时打包当前模型并交给 PromptSkin。返回包只有在 `.model3.json`、`.moc3`、纹理引用和纹理尺寸都与当前模型一致时才会被接受；最终只保存和替换 PNG 纹理，UV、绑定、物理、参数与动作不会修改。衣服预设保存在被 Git 忽略的 `local-assets/wardrobe/`。Hiyori 的角色设计不可修改，因此衣橱会对 Hiyori 自动关闭。

已有 PromptSkin 导出包也可以先导入衣橱，再从页面选择：

```bash
npm run wardrobe:import -- /path/to/promptskin-export.zip --name "暗黑学院风"
# 加上 --activate 可在导入后立即穿上
```

如果 PromptSkin 使用云图片 Provider，提示词和待编辑纹理会发送给该 Provider。请只使用你有权修改和上传的模型与素材。

## 更换 Live2D 模型

模型目录或 ZIP 应使用 Cubism 4 格式，并包含 `*.model3.json` 及其引用文件；最终以浏览器验证结果为准。

```bash
npm run setup:model -- /path/to/model-folder-or.zip
npm run analyze:model
```

设计动作前必须先查看分析结果，再为模型创建对应的 `motion-defs/<model-name>.ts`。不同模型的参数、范围和基础姿势不同，不能直接套用 Hiyori 的参数。

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
npm run dev
```

同时更新 `npc.config.json` 中的角色信息和 `modelAttribution`，保留模型许可证要求的署名。完整动作开发约束见 [AGENTS.md](AGENTS.md)。

## 生产运行

```bash
npm run build
npm start
```

服务默认只绑定 `127.0.0.1:8765`。项目需要本地模型文件和可写缓存，不适合 Edge Runtime 或无持久磁盘的 Serverless 环境，也不应在没有鉴权和限流的情况下直接暴露到公网。

## 验证

通用检查：

```bash
npm run verify
git diff --check
```

有本地模型时再运行：

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
```

`npm run verify` 已包含仓库检查、TypeScript、ESLint、单元测试、`assets/app.js` 语法检查和生产构建。真实语音测试需另行运行 `npm run tts:check` 与 `npm run tts:smoke`。

## 本地文件与安全

- `models/`、`local-assets/`、`model.config.json`、`motion-defs/generated/`、语音缓存和录制产物均被 Git 忽略。
- 不要提交 API Key、Live2D 模型、AIVMX、缓存 WAV、截图或录制视频。
- 只导入来源可信且你有权使用的模型与素材。
- PromptSoul 是本地开发原型，没有账号、租户隔离或公网鉴权。

## 许可证与上游

本仓库中有权许可的代码和文档采用 [MIT License](LICENSE)。第三方模型、SDK、声音和素材不在 MIT 授权范围内，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

- Hiyori 不包含在仓库中，其角色设计不得修改；相关截图和演示必须保留 `Hiyori Momose ©Live2D` 及 Live2D 要求的声明。
- Live2D Cubism Core 受 Live2D 专有软件许可证约束。
- AivisSpeech Engine 与各 AIVMX 声音模型可能使用不同许可证，使用者需要自行确认并遵守，本项目不代替模型作者授权。
- DeepSeek Harness SDK/runtime 当前锁定为 `0.1.0-rc.6`；其 MIT 软件许可不包含 DeepSeek API 或模型服务，使用者仍需遵守相应服务条款。
- 自定义 Live2D 模型和素材仍受各自作者许可约束。

PromptSoul 基于 [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui) 扩展。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
