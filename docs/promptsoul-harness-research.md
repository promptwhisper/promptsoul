# PromptSoul 与 DeepSeek Harness（DSH）动作生成接入研究（历史）

研究日期：2026-08-17。源码快照固定为 PromptSoul
[`a64f23e`](https://github.com/promptwhisper/promptsoul/tree/a64f23e02762edcdf9f473a374b98843b6ac9bf3)
和 DeepSeek Harness
[`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。
本文只使用这两个仓库的源码和官方文档。

> **文档状态（2026-08-17）：**本文保留为基线研究记录，其中关于“实时聊天只能播放预置 emotion motion”“DSH 只能在后台生成未来动作”和“实时只应报告离线生成阶段”的结论，已由当前 `CHAT_BACKEND=dsh-realtime` 实现取代。当前实现让 DSH 按完整 NDJSON 片段同时生成回复和短期 cue，浏览器收到每段后立即排入基于语音时钟的内存时间轴；它不写 `.motion3.json`、不注册动作、不重载 Live2D。本文关于动作工坊持久化资产生成的分析仍有效，但不再描述实时聊天架构；当前操作说明以根目录 `README.md` 为准。

## 结论

可行，而且接入点很窄：让 DSH 取代 PromptSoul 当前的
`callChatCompletions()`，只负责把自然语言动作描述生成成候选动作规格；
PromptSoul 自己的模型分析、严格 JSON 解析、参数映射、二次校验、写锁、
原子落盘和 `PromptSoul` 动作组注册全部保留。当前边界正好位于
[`generateMotion()` 的 provider 调用与 `authorMotion()` 之间](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-api.ts#L267-L340)。

推荐用 DSH 的 TypeScript SDK 持有一个长期运行的 JSON-RPC 子进程，
每次动作生成使用一个全新 session。专用 DSH 组合只暴露一个无副作用的
`submit_motion_plan` 工具；模型必须用该工具提交结构化候选，工具成功后调用
`concludeTurn()` 直接结束本轮。PromptSoul 只接受同一 `callId` 的
`tool/call` 与成功 `tool/result` 配对，之后再执行自己的完整校验。DSH 官方的
进程内 structured-output 实现采用的正是“schema 工具、成功结果两阶段确认、
单调 guard、`concludeTurn()`”模式
([官方实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent-in-process-driver/src/structured.ts#L64-L141))。

SDK 本来就会惰性启动并跨多次 `run()` 复用运行时，且 PromptSoul 与 DSH 都运行在 Node 22 系列；
但 DSH 当前要求 Node `^22.19 || >=24`，所以 PromptSoul 的实际最低版本
应同步提高到 22.19
([SDK 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md#L9-L32)，
[DSH engines](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/package.json#L7-L10))。
PromptSoul 明确以“Node 22+、不需要 Python”为运行约束，因此这里应使用 TS SDK
加 DSH runtime 可执行文件，不增加 Python bridge 或常驻 Python sidecar
([PromptSoul 快速开始](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/README.md#L32-L46))。

“实时”应定义为实时报告 DSH 的运行阶段，最终动作仍在完整规格通过校验后
一次性提交。把尚未闭合的 JSON 或未校验曲线逐 token 写进 Live2D 会绕过
PromptSoul 最关键的安全保证。

## PromptSoul 当前实际链路

1. 浏览器动作工坊只发送 `{prompt}` 到 `POST /api/motions/generate`，客户端
   超时 120 秒；整个请求目前是一次性 JSON，不是流
   ([端点与超时](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/assets/app.js#L9-L14)，
   [提交逻辑](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/assets/app.js#L1686-L1738))。
2. Route Handler 强制 loopback、同源 JSON mutation，再调用 `generateMotion()`
   ([route](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/app/api/motions/generate/route.ts#L22-L40)，
   [同源检查](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/provider-request.ts#L37-L85))。
3. 服务端只接受唯一字段 `prompt`，限制 1,000 字符并做 Unicode/控制字符
   校验；同一 Node 进程一次只允许一个生成或删除任务
   ([payload 校验](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-api.ts#L83-L106)，
   [busy 状态](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-api.ts#L66-L77))。
4. `loadModelProfile()` 从模型原有 motion、CDI 和 physics 文件推导安全范围、
   base pose、physics output 与 `PartOpacity`，只把可写参数映射成 `c01`、
   `c02` 等不透明 token
   ([推导与过滤](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L680-L778))。
5. PromptSoul 给模型的内容只有 token、语义名称、标准化值约束和严格 schema；
   不给原始参数 ID、模型路径或现有曲线。服务端同时按规范化描述的 SHA-256
   前 12 位决定动作 ID，因此相同描述覆盖同一动作
   ([动作 ID](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L378-L392)，
   [模型消息](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L786-L836))。
6. 当前动作模型调用是 OpenAI-compatible Chat Completions，固定
   `stream: false`，90 秒超时，回复上限 64 KiB
   ([调用位置](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-api.ts#L296-L320)，
   [HTTP body](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/provider-client.ts#L109-L139))。
7. 返回值经过拒绝重复 key 的 strict JSON scanner，再校验字段、数量、时长、
   fade、`[-1,1]` 值、递增时间以及首尾归零；`unsupported` 会变成
   `motion_not_feasible`
   ([strict JSON](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L174-L328)，
   [规格校验](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L409-L501))。
8. 编译器把标准化值映射回当前模型的实际安全区间，再次拒绝未知参数、
   physics output、opacity、越界值、重复曲线和错误 base pose
   ([编译与复验](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L839-L935))。
9. `authorMotion()` 在跨进程独占锁内重新加载 profile 并比较 revision，然后
   原子写保存规格、`.motion3.json` 和 `model3.json`；注册只触碰
   `PromptSoul` 组
   ([revision/锁](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L1045-L1124)，
   [注册与写入](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-authoring.ts#L1141-L1239))。
10. 浏览器收到 `{motion, message, modelRevision}` 后销毁并重载整个 Live2D
    实例，再以 `model.motion(group,index,FORCE)` 播放
    ([响应类型](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-api.ts#L261-L265)，
    [重载](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/assets/app.js#L866-L943)，
    [播放](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/assets/app.js#L442-L479))。

## 不要混淆的两种“动作”（基线行为，实时聊天部分已取代）

PromptSoul 的实时聊天动作不是新生成曲线。聊天流结束后只得到八种 emotion
之一，浏览器把 emotion 映射到已经加载的 motion 并播放
([chat 返回类型](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/chat-service.ts#L13-L24)，
[播放时机](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/assets/app.js#L1556-L1567))。
动作工坊才会生成新曲线、写磁盘并重载模型。仅替换动作 Provider 不会自动让
每一轮聊天都即时生成新动作。

## DSH 应怎样接入

### 1. 增加动作规格后端接口

在 PromptSoul 内把“生成候选规格”抽成专用接口，不要让 DSH 直接调用
`authorMotion()`：

```ts
interface MotionSpecBackend {
  readiness(): Promise<{ available: boolean; mode: 'provider' | 'dsh' }>
  generate(
    request: MotionDesignRequest,
    options: { signal: AbortSignal; onPhase?: (phase: MotionPhase) => void },
  ): Promise<unknown>
}
```

`MotionDesignRequest` 由可信服务端组装，包含 server-assigned ID、规范化动作描述、
`[{control,name}]` 目录、数值/数量约束和输出 schema。现有 OpenAI 后端把它
转成 system/user messages；DSH 后端把固定安全规则放进专用 Cordis persona，
把每次变化的目录和请求作为一条 JSON 用户消息。DSH JSON-RPC 服务会把 SDK
传入的 content blocks 原样交给模型，system prompt 与工具则由外围
`cordis.yml` 决定
([SDK server 模型输入](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/server/README.zh.md#L23-L37))。

### 2. 用长期 DSH runtime、每次唯一且串行的 session

`DshMotionSpecBackend` 持有一个 `DeepSeekHarness` 实例；进程启动时可预热，
请求之间复用子进程，但每次动作生成都用新的 session ID，并沿用 PromptSoul
当前的 single-flight busy gate 串行执行。官方 SDK 明确建议
独立任务使用新 session，只有需要延续同一对话时才复用 ID
([SDK 用法](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.zh.md#L73-L81))。
这也避免旧动作、steering 或队列工作污染本次结果；DSH 的 `finalResponse`
只代表活动区间最后一个 assistant 文本，并不保证因果上属于某条 prompt
([TypeScript run 语义](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md#L24-L30))。

不要把普通 `result.finalResponse` 当作动作规格。推荐的 terminal tool 在参数
schema 中声明 PromptSoul motion DSL；工具体只返回固定确认值并调用
`exec.concludeTurn()`，不读写模型文件。DSH 只会把该标记放在成功结果上，agent
loop 在提交工具结果后立即以 `completed` 结束本轮，不再追加一次模型请求
([终止工具约定](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools/src/index.ts#L404-L420)，
[loop 行为](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L373-L399))。

PromptSoul 从 `tool/call.arguments` 取得候选，但必须等同一 `callId` 的
`tool/result` 成功后才接收，再把候选交给现有 `parseMotionSpec()`。同时检查根
session 最后一个 `turn/end`，仅接受 `reason.kind === 'completed'`。DSH 的结束原因
还包括 `aborted`、`blocked`、`error`、`max-tokens` 和 `interrupted`，否则截断调用
可能被误当作普通格式错误
([工具事件关联](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts#L274-L297)，
[结束原因](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts#L152-L177))。

### 3. 用通知做实时进度，不提交 partial spec

DSH 协议提供 `session.event`、`session.status` 与 subagent 生命周期通知；
`assistant/chunk` 又区分 `text-delta`、`reasoning-delta`、tool delta 和 finish
([协议通知](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/protocol/README.zh.md#L11-L25)，
[chunk 类型](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/types.ts#L283-L303))。

建议把 `/api/motions/generate` 改为 NDJSON，并只向浏览器发稳定、去敏的阶段事件：

```json
{"type":"phase","phase":"queued"}
{"type":"phase","phase":"designing"}
{"type":"phase","phase":"validating"}
{"type":"phase","phase":"installing"}
{"type":"done","motion":{},"message":"动作已生成，可以预览了。","modelRevision":"rev_..."}
```

不要转发 `reasoning-delta`、原始 text delta、完整 DSH session event、控制目录或
provider 错误 body。PromptSoul 当前已经把“raw provider response 留在服务端”
作为安全要求，且聊天 route 已有可复用的 NDJSON `ReadableStream` 模式
([PromptSoul 动作安全规则](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/AGENTS.md#L67-L76)，
[聊天 NDJSON route](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/app/api/chat/route.ts#L47-L87))。

### 4. 使用只含提交工具的专用 Cordis 组合

不能直接复用官方 `jsonrpc-agent` 默认配置：它面向无人值守编码，公开
`bash`、读写编辑、subagent 与 todo 工具
([官方示例](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/examples/jsonrpc-agent/README.zh.md#L1-L14))。
动作生成 runtime 应只组合 JSON-RPC server、DeepSeek LLM adapter、agent spine
和本地 `submit_motion_plan` 插件；设置 `workspaceContext: false`、
`toolBash: false`、关闭 skills/jobs/goals，不加载 fs、shell、subprocess、
subagent、MCP 或其他面向模型的工具。提交工具只做 schema 校验、结果确认和
turn 终止，不拥有 PromptSoul 文件写权限。DSH 的 agent spine 官方文档确认 LLM
adapter 和入口由叶配置选择，bash 工具可禁用
([spine 组成与可替换项](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/examples/agent-spine-demo/README.zh.md#L9-L50)，
[配置](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/examples/agent-spine-demo/README.zh.md#L54-L64))。

PromptSoul 的安全指南还写着 authoring 不应增加 shell 或 subprocess。DSH TS SDK
本身恰好以子进程承载 provider transport，因此这是需要显式记录的边界调整，
不能悄悄实现：runtime command、args 和 Cordis 路径只能来自管理员配置，绝不能
来自用户 prompt 或 DSH 输出；子进程内也不提供执行工具。这样仍满足其更核心的
要求，即把模型输出只当数据，并禁止 provider 选择路径、代码或命令
([PromptSoul 规则](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/AGENTS.md#L67-L74))。

若加载 JSONL persistence，DSH 会额外持久化动作 prompt、模型 chunks、reasoning
和完整候选 JSON；这扩大了 PromptSoul 原有的本地数据面。默认应不加载该插件，
或使用独立的 `DSH_SESSION_ROOT`、权限与清理策略。官方示例明确说明 session
目录会保存包含组装请求和工具调用的 JSONL
([持久化说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/guide/python-sdk.zh.md#L40-L50))。

### 5. 单独配置与收紧子进程环境

当前 `motionCapabilities()` 以 `NPC_API_KEY` 是否存在判断可用，必须改成查询所选
`MotionSpecBackend.readiness()`；否则只配置 `DEEPSEEK_API_KEY` 的 DSH 会被误判
为 demo/不可用
([当前 capability gate](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/motion-api.ts#L168-L185)，
[当前 Provider env](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/lib/server/provider-store.ts#L157-L169))。

建议新配置至少包含 `MOTION_BACKEND=dsh`、DSH runtime command/args、Cordis 配置
路径、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、model 和总超时。TypeScript SDK
不会替调用方定位捆绑 runtime，启动 command/args 必须显式提供
([SDK 启动责任](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md#L5-L7)，
[已知限制](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md#L44-L49))。

必须给 `HarnessClientOptions.env` 传经过白名单筛选的完整环境，只保留 DSH 必需
变量；若省略，SDK 会原样继承 PromptSoul 进程环境，可能把 `NPC_API_KEY`、TTS
配置等无关秘密暴露给子进程
([环境继承约定](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/src/types.ts#L22-L45)，
[spawn 实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/src/client.ts#L196-L210))。

### 6. 超时必须销毁并重建 runtime

DSH 协议目前没有 prompt cancel。客户端放弃一次运行只能关闭整个 runtime；
高层 `run()` 在收到 inbox 回执后会一直等到 agent 进入 idle
([无取消限制](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.zh.md#L44-L49)，
[等待循环](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/src/api.ts#L146-L193))。
因此 DSH adapter 需要自己的“整次生成”deadline；超时、浏览器断开或协议异常时，
先 `close()` 并等待子进程退出，再清除 PromptSoul 的 busy 状态，下一次请求创建
新 runtime。不能只 `Promise.race` 后继续复用旧进程，否则旧任务仍可能运行。

本文检出的 DSH 源码是 `0.1.0-rc.5`，协议也没有版本协商；而 2026-08-17
npm registry 的 `latest` 仍指向旧版本族 `0.0.1-rc.1`，`next` 才是
`0.1.0-rc.6`。因此不能裸装 package 或只写 `latest`，应精确 pin 同一
`0.1.0-rc.x` family 的 client、peer packages 与 runtime，并在启动时校验
`initialize.serverInfo.name`，升级时跑协议与动作回归测试
([SDK package](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/package.json#L1-L20)，
[npm 官方版本列表](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-client?activeTab=versions)，
[协议限制](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/protocol/README.zh.md#L35-L39))。

## 建议改动清单

| 位置 | 改动 |
|---|---|
| `lib/server/motion-api.ts` | 依赖 `MotionSpecBackend`，保留 payload/profile/ID/parse/author/error mapping；把 capability readiness 与 `NPC_API_KEY` 解耦。 |
| 新 `lib/server/motion-backend-*.ts` | 保留 OpenAI backend；增加 DSH singleton manager、fresh session、finish-reason 检查、deadline、restart 和错误映射。 |
| 新 `config/motion-dsh.cordis.yml` | JSON-RPC + DeepSeek adapter + 仅有 terminal submit tool 的 agent；静态动作 persona；无 workspace 工具。 |
| 新 `config/plugins/submit-motion-plan.mjs` | 注册 motion DSL schema、成功结果两阶段确认、重复提交 guard 和 `concludeTurn()`；不读写文件。 |
| `app/api/motions/generate/route.ts` | 第一阶段可保持现有 JSON；需要实时阶段反馈时改 NDJSON，并把 `request.signal` 传入 backend。 |
| `assets/app.js` | 读取 `phase/done/error`；仅在 `done` 后复用现有 `normalizeGeneratedMotion()`、重载和播放逻辑。 |
| `provider-store.ts` 或新配置模块 | 分离聊天 Provider 与动作 backend 配置；公开状态只返回 `mode: dsh`、model、ready，不返回命令、路径、环境或错误尾部。 |
| `package.json` / 部署 | pin DSH SDK/runtime；把 Node 最低版本改为 22.19；启动时预热并在进程退出时关闭 runtime。 |

## 验收重点

- 复用现有测试不变量：provider 看不到 raw parameter ID；只写 `PromptSoul`；
  `Idle`/`Action` 等组完全不变。PromptSoul 已有对应测试
  ([opaque controls](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/tests-node/motion-authoring.test.ts#L131-L143)，
  [原组保持不变](https://github.com/promptwhisper/promptsoul/blob/a64f23e02762edcdf9f473a374b98843b6ac9bf3/tests-node/motion-authoring.test.ts#L145-L171))。
- 新增 fake DSH runtime 测试：chunk 分片、成功 submit 配对、缺失或失败的
  `tool/result`、重复 submit、`completed`、`max-tokens`、`error`、恶意/超大/
  重复-key 参数和 transport death。
- 验证超时会真正回收旧子进程并允许下一次生成；并发请求仍返回
  `generation_in_progress`，revision 变化仍在写入前失败。
- 验证 DSH 子进程环境白名单、Cordis 只有 `submit_motion_plan`、无其他
  model-facing tools，且日志不进入 stdout JSON-RPC 通道；官方 server 要求
  stdout 只能承载协议帧
  ([stdout 约束](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/server/README.zh.md#L15-L21))。
- 浏览器 NDJSON 测试覆盖任意字节分片、断线和只有 `done` 才触发模型重载。

## 实施顺序（历史建议）

先做“DSH backend + 现有 JSON HTTP 响应”，验证生成结果与原 Provider 完全同一条
安全编译链；再加 NDJSON 阶段事件；最后才考虑把聊天触发与新动作生成联动。
若目标是每轮聊天都立刻有动作，保留现有 emotion motion 作为当前轮低延迟路径，
DSH 在后台生成并缓存未来可复用动作。以当前“写文件 + 重载整个 Live2D 模型”
的机制，逐轮临时生成无法达到 token 级的即时播放。
