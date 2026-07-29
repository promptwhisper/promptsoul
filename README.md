<p align="center">
  <img src="./docs/images/promptsoul-banner.svg" width="100%" alt="PromptSoul gives local AI characters a visible soul through emotion-driven Live2D and safe motion generation">
</p>

# PromptSoul

简体中文 · [English](README.en.md) · [日本語](README.ja.md)

> 中文 README 是完整且规范性的主文档；英文和日文版是持续维护的概要。如表述存在差异，以本页为准。

PromptSoul 是一个前后端一体的 AI Live2D NPC 原型。用户发消息后，Next.js 服务端流式返回角色回复与情绪，浏览器把情绪映射成 Live2D 动作，并把可朗读的助手原文按日语优化规则分段后依次交给本机 AivisSpeech 合成。真正播放的 Web Audio 振幅会实时驱动口型；“动作工坊”仍能把自然语言描述编译成当前模型可安全表达的新动作。

> AI 不会直接修改网格、骨骼或 Cubism 绑定。所有动作都只能使用模型已有参数，并且只能注册到项目自有的 `PromptSoul` 动作组。

**从这里开始：**[快速开始](#快速开始) · [接入 AI](#接入-ai) · [接入角色语音](#接入角色语音) · [用提示词生成动作](#用提示词生成动作) · [更换模型](#更换-live2d-模型) · [安全边界](#安全说明)

<sub>演示角色：Hiyori Momose ©Live2D；模型数据不包含在仓库中。</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## 当前能力

- **流式角色对话：**服务端通过 `@aituber-onair/chat` 增量返回回复，浏览器持续更新同一条消息并触发对应情绪动作。
- **免云 API 费用的本地语音：**Next.js 只在服务端访问 AivisSpeech，默认解析コハク的「あまあま」风格，不需要云端 TTS Key；声音模型仍受各自许可证约束。
- **真实音频口型：**单实例 Web Audio 队列按句播放，`AnalyserNode` 的实时 RMS 会在 `beforeModelUpdate` 阶段写入已解析的 `LipSync` 参数。
- **提示词生成动作：**自然语言只会被编译成当前模型已有参数能够安全表达的曲线，并注册到项目自有的 `PromptSoul` 组。
- **模型与动作保护：**安全解压 ZIP，并在导入后、设计动作前分析模型，再独立校验动作；不会覆盖 `Action`、`Idle`、`Tap` 等原始动作组。
- **可诊断的无人值守 TTS 录制：**CDP 连续帧与同一 AudioContext 音频同步采集；真实声音、RMS 和嘴部参数读回变化未被检测到时会明确失败。

PromptSoul 目前是本地优先的实验性原型，没有账号、租户隔离、公网鉴权或限流。服务默认只绑定 `127.0.0.1`，请勿直接暴露到公网。

## 快速开始

需要仍在官方支持期内的 Node.js 22+、npm、现代浏览器和网络连接，不需要 Python。页面会从官方 CDN 加载 Live2D Cubism Core、PixiJS 与 `pixi-live2d-display`。

首次下载 Hiyori 前，请阅读 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 与 [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/)，只有同意后才能执行带 `--accept-license` 的命令。

```bash
npm ci

# 首次使用：阅读并接受 Live2D 条款后下载官方 Hiyori 样例
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate

npm run dev
```

打开 <http://127.0.0.1:8765>。不配置 API Key 时，聊天使用确定性的本地演示回复；AivisSpeech 未启动时，文字聊天、Live2D、已有动作和交互也不会被阻塞。动作工坊需要连接 AI Provider；本地语音的安装和预检见[接入角色语音](#接入角色语音)。

生产模式使用同一个 Node 服务：

```bash
npm run build
npm start
```

PromptSoul 需要读取和写入本机模型工作副本、动作定义和有界语音缓存，因此应使用 Node 自托管运行时，不要部署到 Edge 或无持久磁盘的 Serverless 运行时。Next 的文件跟踪也显式排除了 `models/`、`local-assets/`、`model.config.json` 和 AI 生成定义；部署时应由你在有权限的主机上单独挂载这些本地数据。

生产构建显式使用 Next 支持的 Webpack 构建器，以保持这类运行时动态模型文件跟踪可预测。开发服务仍使用 Next 默认的快速构建链路。

## 接入 AI

页面右上角的“AI Provider”面板只显示服务端配置状态，不能填写或读取 API Key。普通 NPC 对话由 `@aituber-onair/chat` 提供 OpenAI-compatible 流式适配；动作生成继续使用 PromptSoul 的有界非流式客户端和独立安全编译器。安全边界如下：

- API Key 只从启动 Node 进程时的服务端环境变量读取，绝不发送到浏览器；
- 应用不会把 Key 写入 React 状态、`localStorage`、Cookie、配置文件、日志、响应或 Git；
- 公开 Provider 接口只返回模式、来源、模型和 API 根地址等非敏感状态；
- 远程 Provider 必须使用 HTTPS，只有 `localhost` / `127.0.0.0/8` / `::1` 本机服务可使用 HTTP；
- 聊天和动作生成都由后端调用 Provider，Key 不会被加入模型文件或动作定义。
- 角色设定、聊天内容和动作提示词会发送给你配置的 Provider；Live2D 模型文件、原始参数 ID 和动作曲线不会发送。

使用服务端环境变量启动：

```bash
export NPC_API_KEY="你的 API Key"
export NPC_API_BASE="https://api.openai.com/v1"
export NPC_MODEL="gpt-5.6-luna"
npm run dev
```

生产运行应先执行 `npm run build`，再使用同一组服务端环境变量运行 `npm start`。

| 变量 | 说明 | 默认值 |
|---|---|---|
| `NPC_API_KEY` | 首选服务端 API Key | 未设置时读取 `OPENAI_API_KEY` |
| `OPENAI_API_KEY` | 兼容现有 OpenAI 配置的备用 Key | 无 |
| `NPC_API_BASE` | OpenAI 兼容 API 根地址 | `https://api.openai.com/v1` |
| `NPC_MODEL` | 模型名称 | `gpt-5.6-luna` |

`gpt-5.6-luna` 是项目当前默认的 Provider 模型名，并非所有 OpenAI 兼容服务都提供；如果服务返回“模型不存在”，请把服务端 `NPC_MODEL` 改成该 Provider 实际支持的模型并重启 PromptSoul。

## 接入角色语音

角色语音只使用本机 [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine)，默认地址为 `http://127.0.0.1:10101`，不使用收费云 TTS，也不需要语音 API Key。浏览器不能直接访问 10101：它只向同源 `/api/tts` 发送文本，Next.js 服务端依次调用 `/audio_query` 与 `/synthesis` 并返回 WAV。

本机诊断接口包括 `GET /api/tts/status`、`GET /api/tts/voices` 和 `POST /api/tts`；总健康检查 `GET /api/status` 会保留原字段并增加 `tts`。声音列表只返回精简名称、UUID、风格和全局 Style ID，所有接口都不会返回 Engine 地址。

### 安装和配置

1. 从 AivisSpeech 官方渠道安装并启动 AivisSpeech。Engine 启动后可打开 <http://127.0.0.1:10101/docs> 查看 Swagger。
2. 在 AivisSpeech 中自行导入コハク声音模型，并确认模型包含「あまあま」风格。PromptSoul 不下载、不复制，也不会自动修改 AIVMX 或其许可证。
3. 查看当前机器真实安装结果：

   ```bash
   curl --fail http://127.0.0.1:10101/speakers
   ```

   AivisHub 显示的「あまあま」Style ID `1` 是模型内部的本地 ID，不能直接当作 HTTP API 的 `speaker=1`。AivisSpeech Engine 会根据模型 UUID 动态生成全局 Style ID；PromptSoul 运行时从 `/speakers` 按 UUID、角色名和风格名解析并验证它，并对声音目录做 60 秒短时缓存。

4. 复制 `.env.example` 中的非敏感配置到你已有的 `.env.local`，不要覆盖现有文件：

   ```dotenv
   TTS_PROVIDER=aivis
   AIVIS_BASE_URL=http://127.0.0.1:10101
   AIVIS_SPEAKER_UUID=5680ac39-43c9-487a-bc3e-018c0d29cc38
   AIVIS_SPEAKER_NAME=コハク
   AIVIS_STYLE_NAME=あまあま
   AIVIS_STYLE_ID=
   ```

   通常应让 `AIVIS_STYLE_ID` 留空。只有明确知道当前 Engine 的全局 ID 时才填写；填写后 PromptSoul 仍会通过 `/speakers` 验证它确实属于目标角色和风格，不会静默换声音。

5. 执行真实预检和冒烟测试：

   ```bash
   npm run tts:check
   npm run tts:smoke
   npm run dev
   ```

   `tts:check` 会输出当前机器解析到的全局 Style ID；`tts:smoke` 会真实生成 `artifacts/tts-smoke.wav` 并校验非空 RIFF/WAVE 结构，本机安装 `ffprobe` 时还会校验正时长。`artifacts/`、缓存 WAV 和 AIVMX 都被 Git 忽略且由仓库检查器拒绝发布。

6. 打开页面右上角“本地语音”面板。它会显示 Engine、コハク、あまあま和全局 Style ID，可刷新声音列表、输入日语、试听和停止。默认试听台词是：

   ```text
   おかえりなさい。今日も会えて、すごくうれしいです。
   ```

### 语音和口型链路

LLM 增量文本只更新现有助手消息；TTS 副本会移除 Markdown、URL 和不可朗读代码，再按 `。！？`、换行、省略号和约 52 字符的自然停顿分段。第一句完整后即可开始合成，不必等待整篇回答结束，最后没有句号的内容会在流结束时 flush。分句规则偏向日语，但不会检测语言或把文本翻译成日语；当前角色默认使用和用户相同的语言回答。要保证日语发音，请使用日语对话，或在 `npc.config.json` 的角色设定中明确要求日语回复。

浏览器中的单实例队列严格按顺序播放，并在当前句播放时预合成下一句。音频结构为 `AudioBufferSourceNode → AnalyserNode → GainNode → AudioContext.destination`；无人值守录制时，同一个 `GainNode` 还会连接 `MediaStreamAudioDestinationNode`。口型来自正在播放音频的真实时域 RMS，包含噪声门和 attack/release 平滑，不使用 Web Speech API、文字长度或计时器伪造。播放结束、停止或失败后嘴型会自然归零。TTS 失败只跳过语音，文字回复和情绪动作继续工作。

口型优先读取模型 `model3.json` 的 `LipSync` 分组；没有声明时才尝试常见参数。官方 Hiyori 使用 `ParamMouthOpenY`，写入发生在现有 Live2D `beforeModelUpdate` 阶段，不修改模型文件、动作定义或任何动作组。

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `TTS_PROVIDER` | 本地 TTS Provider，目前只支持 `aivis` | `aivis` |
| `AIVIS_BASE_URL` | 仅服务端读取的 Engine 回环地址 | `http://127.0.0.1:10101` |
| `AIVIS_SPEAKER_UUID` | 优先精确匹配的角色 UUID | コハク UUID |
| `AIVIS_SPEAKER_NAME` | UUID 留空时的角色名回退 | `コハク` |
| `AIVIS_STYLE_NAME` | 目标风格名 | `あまあま` |
| `AIVIS_STYLE_ID` | 可选的真实全局 ID；填写后必须验证通过 | 空 |
| `AIVIS_CONNECT_TIMEOUT_MS` | `/speakers` 超时 | `3000` |
| `AIVIS_QUERY_TIMEOUT_MS` | `/audio_query` 超时 | `15000` |
| `AIVIS_SYNTHESIS_TIMEOUT_MS` | `/synthesis` 超时 | `60000` |
| `AIVIS_SPEED_SCALE` | 可选语速覆盖，范围 0.5–2.0 | Engine 默认 |
| `AIVIS_INTONATION_SCALE` | 可选抑扬覆盖，范围 0.0–2.0 | Engine 默认 |
| `AIVIS_TEMPO_DYNAMICS_SCALE` | 可选节奏动态，范围 0.0–2.0 | Engine 默认 |
| `AIVIS_VOLUME_SCALE` | 可选音量覆盖，范围 0.0–2.0 | Engine 默认 |
| `TTS_MAX_TEXT_LENGTH` | 单次 TTS 最大 Unicode 字符数 | `500` |
| `TTS_CACHE_ENABLED` | 是否启用有界 WAV 缓存 | `true` |
| `TTS_CACHE_DIR` | 缓存目录 | `.cache/aivis-tts` |
| `TTS_CACHE_MAX_MB` | 缓存容量上限 | `256` |
| `AIVIS_AUTOSTART` | macOS 上是否允许预检执行 `open -a AivisSpeech` | `false` |

留空的合成参数保持 Engine 生成的 AudioQuery 原值；PromptSoul 不主动提高 `pitchScale`，也不修改音素、重音、假名或 pause 参数。

本地 WAV 缓存包含已经合成的对话语音。共享设备或敏感对话场景可设置 `TTS_CACHE_ENABLED=false`；需要清理已有内容时，先停止 PromptSoul，再删除 `.cache/aivis-tts/`。缓存和清理失败都不会改变文字聊天结果。

### 无人值守录制

在 macOS、Linux 或 WSL 中准备 Chrome/Chromium、`ffmpeg`、`ffprobe`、Bash、`curl` 和 `seq`，并让 AivisSpeech/コハク/あまあま就绪后运行：

```bash
npm run record:browser
```

当前脚本生成的是聚焦 TTS 与口型证据的测试片段：它不会发送聊天消息或调用 LLM，而是把 `TTS_TEXT` 直接送入页面现有的单实例 TTS 管理器。流程为 `tts:check → 启动 127.0.0.1:8765 → /api/status → 独立 Headless Chrome → Live2D ready → 解锁 AudioContext → 真实播放 → CDP 连续帧与同一 AudioContext 音频捕获 → ffmpeg 编码 → ffprobe → 三帧文件完整性检查`。它保留 SwiftShader、后台计时器、远程调试和无窗口持续渲染设置，不使用 `--disable-gpu` 或传统桌面录屏。

录制开始必须同时观测到 `playing`、运行中的 AudioContext、正播放位置、非静音 RMS 和 Live2D 嘴部参数的写入后读回变化；结束前会 flush 分句缓冲，并等待队列清空、真实 `onended` 和嘴型接近零。这个门槛证明了真实音频与运行时参数链路，但当前不会比较 ArtMesh 顶点，也不会自动判断抽帧中的视觉语义；发布前仍需人工观看成片。任一硬性条件不满足都会返回非零且不会发布新的无声视频。

默认输出为 `artifacts/promptsoul-unattended.mp4`，默认画面为 720×1280。可用 `OUT`、`PORT`、`CHROME`、`FFMPEG`、`FFPROBE`、`TTS_TEXT`、`WIDTH`、`HEIGHT` 和 `RECORD_TIMEOUT_MS` 覆盖，也可在 `npm run record:browser --` 后传入对应的 `--out`、`--port`、`--text`、`--width`、`--height` 与 `--timeout` 参数。抽出的三张检查帧只在临时目录中做存在性与大小检查，不会作为成品保留。

### 常见问题

- **10101 无法连接：**先启动 AivisSpeech；macOS 可显式设置 `AIVIS_AUTOSTART=true`，但脚本不会安装应用或模型。
- **模型没有安装：**在 AivisSpeech UI 中导入コハク AIVMX；不要把模型复制进本仓库。
- **风格名称不匹配：**查看 `/speakers` 或 `npm run tts:check` 输出，按实际 Unicode 名称配置。
- **Style ID 1 无效：**它是模型内部 ID；删除 `AIVIS_STYLE_ID=1`，让服务端解析当前机器的全局 ID。
- **AudioContext 是 suspended：**点击页面或“试听”；无头流程会先执行真实 CDP 点击并验证 Context 为 running。
- **有声音但嘴型不动：**确认模型 `LipSync` 分组和嘴部参数存在，并查看 `window.__AITUBER_DIAGNOSTICS__.tts.lipSyncParameterIds`。
- **有嘴型但录制文件没声音：**使用 `npm run record:browser`，检查 `ffmpeg`/`ffprobe` 和最终音频流；不要只录屏幕画面。

## 用提示词生成动作

连接 AI Provider 并导入模型后，页面底部的“动作工坊”会自动启用。输入“先惊讶地睁大眼睛，轻轻后仰，再点头回到原位”一类描述，服务端会：

1. 从模型原有动作估计安全参数范围、基础姿势和物理输出；
2. 只向 Provider 提供不透明控制编号、语义名称和标准化值；
3. 严格校验结构化 JSON，拒绝任意代码、未知参数、物理输出、`PartOpacity`、越界值以及未回到基础姿势的曲线；
4. 原子写入动作，并且只更新 `PromptSoul` 组；`Action`、`Idle`、`Tap` 等模型原有组不会被覆盖；
5. 重新加载模型并自动预览生成结果。

AI 定义保存在 `motion-defs/generated/<model>/`，运行文件保存在 `models/`；它们都是本地工作产物并被 Git 忽略。相同描述会更新同一个动作，每个模型最多保存 24 个 AI 动作。`npm run motions:generate` 会恢复已经验证过的 AI 动作。

动作库只会为 `promptsoul_ai_<12 位十六进制>` AI 动作显示删除入口。确认删除后，服务端会在写锁内移除保存定义、运行注册和对应运行文件；若最后的未注册本地残留清理失败，接口会明确返回 `cleanupPending`。当前 Hiyori 定义中的 7 个内置动作，以及任何模型原有的 `Action`、`Idle`、`Tap` 等动作组，都不能从页面删除；其他模型的内置动作数量由各自定义决定。

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
components/                  React UI（Provider 状态与 AivisSpeech 调试面板）
components/legacy-runtime.tsx 固定加载 SDK，并接入经过验证的旧版浏览器运行时
assets/app.js                唯一的 Live2D 控制器、聊天/TTS 接线与动作 UI
assets/                      其余浏览器运行时入口与响应式样式
lib/server/aivis-*.ts        AivisSpeech 客户端、声音解析与有界缓存
lib/shared/browser-tts.ts    日语优化分句、Web Audio 队列、RMS 口型与录音
lib/server/                  聊天 Provider、模型和动作安全逻辑
scripts/                     Node/TypeScript CLI、TTS 预检与 CDP 录制
tests-node/                  node:test 自动化测试
tools/record_browser.sh      TTS 预检、Next 启动和无人值守录制编排
motion-defs/<model>.ts       模型专属基础动作定义
motion-defs/generated/       本地 AI 动作定义（Git 忽略）
npc.config.json              角色、欢迎语、快捷问题和署名
model.config.json            当前模型配置（本地生成，Git 忽略）
local-assets/ , models/      授权受限或生成的模型数据（Git 忽略）
.cache/aivis-tts/            有界本地语音缓存（Git 忽略）
artifacts/                   冒烟 WAV 与录制输出（Git 忽略）
```

## 验证

代码或动作修改完成后运行：

```bash
npm run typecheck
npm run lint
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

涉及视觉或交互时，再运行 `npm run verify:browser`，并检查桌面与手机布局没有横向溢出。`npm run tts:check` 和 `npm run tts:smoke` 是显式依赖本机 AivisSpeech 的真实测试，不会加入普通 CI；涉及语音录制时再运行 `npm run record:browser`。

## 安全说明

- 不要把真实 LLM API Key 写入源码、`.env` 提交、截图、日志或模型文件。Key 只能通过服务端环境变量或外部 Secret 管理，浏览器没有填写入口。
- AivisSpeech 在本机运行，不需要语音 API Key；Engine 地址只在 Node 服务端读取并限制为回环 HTTP，客户端不能提交任意 `baseUrl`。
- 当前服务没有账号、租户隔离、公网鉴权或限流，只绑定 `127.0.0.1`，不要直接暴露到公网。
- 不要提交 AIVMX、缓存 WAV、冒烟音频或录制视频；仓库忽略规则和 `npm run check:repo` 会共同拦截这些产物。
- 动作生成会修改本地模型工作副本，但只接受本机同源请求，并且始终受独立校验器约束。
- Hiyori 下载固定到 Live2D 官方 HTTPS 地址；通用模型导入器会拒绝路径穿越、符号链接、特殊文件、ZIP64、加密条目和超限压缩包。仍应只导入你有权使用且可信的模型。
- 页面的三个 SDK 依赖使用固定版本/内容的 SRI 校验和 CSP 来源限制。PixiJS 6 的 WebGL 同步器需要 CSP `unsafe-eval`，因此 SRI 是 CDN 内容篡改的主要防线。离线或生产部署时仍建议在各自许可证允许的前提下自行托管固定依赖。

## 许可证与上游

- 本仓库中版权持有人有权许可的代码和文档采用 [MIT License](LICENSE)，并保留上游 MIT 版权声明；该许可证不覆盖下面列出的模型、SDK 或用户素材。
- Hiyori 模型不包含在仓库中。下载或使用前必须同意 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 与 [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/)。Hiyori 的角色设计不得修改；包含 Hiyori 的截图和演示必须在画面中可见保留 `Hiyori Momose ©Live2D` 及适用条款要求的声明。
- Live2D Cubism Core 受 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 约束。
- PixiJS 与 `pixi-live2d-display` 使用各自许可证；你导入的模型和素材仍受原作者许可约束。
- `@aituber-onair/chat` 按 MIT License 使用，精确版本见 `package-lock.json`。
- AivisSpeech Engine 不包含在本仓库中，按上游 [GNU LGPL v3](https://github.com/Aivis-Project/AivisSpeech-Engine/blob/master/LICENSE) 发布；AIVMX 声音模型可能采用各自不同的许可证。使用者必须自行查看并遵守所选模型条款，本项目不代表模型作者重新授权。

完整的第三方归属和许可证边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开包含漏洞细节、API Key 或受限模型。

PromptSoul 基于 [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui) 扩展。上游项目验证了“不打开 Cubism Editor，仅用 JSON 为现有 Live2D 参数增加动作”的工作流；感谢原作者。
