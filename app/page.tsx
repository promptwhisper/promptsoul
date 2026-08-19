import { LegacyRuntime } from "@/components/legacy-runtime";
import { ProviderSettings } from "@/components/provider-settings";
import { VoiceSettings } from "@/components/voice-settings";

export default function HomePage() {
  return (
    <>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <div className="app-shell">
        <header className="topbar">
          <a className="brand" href="./" aria-label="PromptSoul 首页">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-copy">
              <strong id="brandName">PromptSoul</strong>
              <small id="brandLabTitle">AI Live2D NPC Lab</small>
            </span>
          </a>

          <div className="topbar-meta">
            <span className="lab-tag"><i aria-hidden="true" /> EXPERIMENT 01</span>
            <ProviderSettings />
            <VoiceSettings />
            <span className="connection-pill" id="modelState" data-state="loading">
              <span className="state-dot" aria-hidden="true" />
              <span className="state-copy">模型连接中</span>
            </span>
          </div>
        </header>

        <main className="lab-grid">
          <section className="character-card" aria-labelledby="characterTitle">
            <div className="card-heading character-heading">
              <div>
                <p className="eyebrow">LIVE CHARACTER</p>
                <h1 id="characterTitle">角色正在醒来</h1>
              </div>
              <div className="character-state">
                <span className="online-dot" aria-hidden="true" />
                <span id="characterRole">AI 游戏世界向导</span>
              </div>
            </div>

            <div className="stage-wrap">
              <div className="stage-grid" aria-hidden="true" />
              <div className="stage-orbit orbit-one" aria-hidden="true" />
              <div className="stage-orbit orbit-two" aria-hidden="true" />
              <div id="stage" aria-label="Live2D 角色舞台">
                <div className="model-placeholder" id="modelPlaceholder">
                  <span className="loader-orb" aria-hidden="true" />
                  <strong>正在载入 Live2D 模型</strong>
                  <small>读取角色参数与动作列表…</small>
                </div>
              </div>

              <div className="stage-topline" aria-hidden="true"><span>LIVE RENDER</span><span>60 FPS</span></div>
              <div className="stage-attribution" id="stageAttribution">Hiyori Momose ©Live2D</div>

              <div className="stage-controls">
                <div className="status-pill" id="status" role="status" aria-live="polite">
                  <span className="status-signal" aria-hidden="true" />
                  <span className="status-text">正在初始化角色…</span>
                </div>
                <button className="icon-button" id="resetView" type="button" title="重置角色位置与大小" aria-label="重置角色位置与大小">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.9 7.5A8 8 0 1 1 4 12M4 4v4h4" /></svg>
                </button>
              </div>

              <div className="gesture-hint">
                <span><i className="mouse-icon" aria-hidden="true" />拖动角色</span>
                <span><i className="zoom-icon" aria-hidden="true">＋</i>滚轮缩放</span>
              </div>
            </div>

            <section className="motion-deck" aria-labelledby="motionTitle">
              <div className="motion-deck-head">
                <div><p className="eyebrow">EMOTION DECK</p><h2 id="motionTitle">试试角色动作</h2></div>
                <span className="deck-note"><span id="motionCount">0</span> 个可用情绪</span>
              </div>
              <div className="motion-grid" id="newButtons" aria-live="polite">
                <div className="motion-empty">模型载入后会显示动作</div>
              </div>
              <div className="legacy-groups" id="buttons" />
            </section>
          </section>

          <aside className="chat-card" aria-labelledby="chatTitle">
            <div className="chat-heading">
              <div className="npc-avatar" id="npcAvatar" aria-hidden="true"><span>PS</span><i /></div>
              <div className="npc-meta">
                <p className="eyebrow">NOW CHATTING WITH</p>
                <h2 id="chatTitle">小予 <span className="verified" title="PromptSoul 实验角色">✦</span></h2>
                <p id="npcRole">来自游戏世界的见习向导</p>
              </div>
              <span className="mode-badge" id="chatMode" data-mode="auto">AUTO</span>
            </div>

            <div className="chat-history" id="chatHistory" role="log" aria-live="polite" aria-label="聊天记录" />
            <div className="typing-row" id="typingState" role="status" aria-live="polite" aria-atomic="true" hidden>
              <div className="message-avatar" aria-hidden="true">PS</div>
              <div className="typing-bubble" aria-label="角色正在思考"><span /><span /><span /></div>
              <small>正在想怎么回答你</small>
            </div>

            <div className="suggestion-area"><p>不知道聊什么？</p><div className="suggestion-list" id="suggestions" /></div>

            <form className="chat-composer" id="chatForm">
              <label className="sr-only" htmlFor="chatInput">输入你想对角色说的话</label>
              <textarea id="chatInput" rows={1} maxLength={240} placeholder="和她说点什么…" autoComplete="off" />
              <button id="sendButton" type="submit" aria-label="发送消息">
                <span>发送</span>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-4.5 14-3-5.5L5 12Z" /><path d="m11.5 13.5 3-3" /></svg>
              </button>
            </form>

            <div className="chat-footer">
              <span><i aria-hidden="true" /> 情绪动作 · 语音口型</span>
              <span id="replySource">本地演示已就绪</span>
            </div>
          </aside>

          <section className="motion-workshop wardrobe-workshop" id="wardrobeWorkshop" aria-labelledby="wardrobeWorkshopTitle" data-state="loading">
            <div className="workshop-overview">
              <div className="workshop-title-row">
                <div><p className="eyebrow">PROMPT WARDROBE</p><h2 id="wardrobeWorkshopTitle">给角色切换服装风格</h2></div>
                <span className="workshop-availability" id="wardrobeAvailability">检查衣橱中</span>
              </div>
              <p className="workshop-intro">选择已经生成的衣服立即切换，或写一段提示词交给 PromptSkin 重绘纹理。角色的 UV、绑定、物理和动作保持不变。</p>
              <div className="workshop-guardrails" aria-label="换装安全规则">
                <span>只替换纹理 PNG</span><span>拒绝变更 moc3 / model3</span><span>仅处理你有权使用的模型</span>
              </div>
            </div>

            <form className="workshop-form wardrobe-form" id="wardrobeForm" aria-busy="false">
              <div className="wardrobe-presets-block">
                <div className="workshop-label-row">
                  <label id="wardrobePresetsLabel">已保存衣服</label>
                  <button className="wardrobe-refresh" id="wardrobeRefresh" type="button">刷新</button>
                </div>
                <div className="wardrobe-preset-list" id="wardrobePresetList" aria-labelledby="wardrobePresetsLabel" aria-live="polite">
                  <div className="wardrobe-empty">正在读取当前模型的衣橱…</div>
                </div>
              </div>

              <div className="workshop-field">
                <div className="workshop-label-row"><label htmlFor="wardrobePrompt">新衣服描述</label><span id="wardrobePromptCounter">0 / 1200</span></div>
                <p className="workshop-help" id="wardrobePromptHelp">写清服装类型、配色、材质和风格；生成完成后会自动保存为预设并穿上。</p>
                <textarea
                  id="wardrobePrompt"
                  name="prompt"
                  rows={3}
                  maxLength={1200}
                  aria-describedby="wardrobePromptHelp wardrobeStatus"
                  placeholder="例如：暗黑未来学院风，黑色短外套搭配紫蓝霓虹发光线条，金属扣件，保留角色原有脸部与发型"
                  autoComplete="off"
                />
              </div>

              <div className="workshop-examples">
                <span>快速风格</span>
                <div className="workshop-example-list" id="wardrobePromptExamples">
                  <button type="button" data-prompt="二次元暗黑未来学院风服装，黑色短外套与分层裙装，紫蓝霓虹发光线条，精致金属扣件和机能腰带；保留角色原有脸部、发型、身体比例和透明边界。">暗黑发光</button>
                  <button type="button" data-prompt="清爽海盐夏日风服装，白色与浅蓝色水手领上衣，轻薄半透明防晒外套，少量贝壳和浪花纹样；保留角色原有脸部、发型、身体比例和透明边界。">海盐夏日</button>
                  <button type="button" data-prompt="精致复古侦探风服装，深棕短风衣、格纹马甲、皮革肩带和黄铜细节，暖灰与酒红配色；保留角色原有脸部、发型、身体比例和透明边界。">复古侦探</button>
                </div>
              </div>

              <div className="workshop-action-row">
                <div className="workshop-status" id="wardrobeStatus" role="status" aria-live="polite" aria-atomic="true" data-state="loading">
                  <span className="workshop-status-mark" aria-hidden="true" />
                  <span className="workshop-status-copy">正在检查 PromptSkin 和当前模型…</span>
                </div>
                <button className="workshop-generate" id="wardrobeGenerateButton" type="submit" disabled>
                  <span className="generate-label">生成并穿上</span>
                  <span className="generate-indicator" aria-hidden="true"><i /><i /><i /></span>
                </button>
              </div>
            </form>
          </section>

          <section className="motion-workshop" id="motionWorkshop" aria-labelledby="motionWorkshopTitle" data-state="loading">
            <div className="workshop-overview">
              <div className="workshop-title-row">
                <div><p className="eyebrow">MOTION WORKSHOP</p><h2 id="motionWorkshopTitle">用一句话设计新动作</h2></div>
                <span className="workshop-availability" id="motionWorkshopAvailability">检查生成能力中</span>
              </div>
              <p className="workshop-intro">描述角色的表情、头部与身体节奏。生成器只会使用当前模型已有参数，并将结果加入项目自有动作组。</p>
              <div className="workshop-guardrails" aria-label="动作生成安全规则">
                <span>不修改模型设计</span><span id="motionWorkshopGroup">仅写入 PromptSoul</span>
              </div>
            </div>

            <form className="workshop-form" id="motionWorkshopForm" aria-busy="false">
              <div className="workshop-field">
                <div className="workshop-label-row"><label htmlFor="motionPrompt">动作描述</label><span id="motionPromptCounter">0 / 240</span></div>
                <p className="workshop-help" id="motionPromptHelp">写清动作顺序、幅度和结束姿势。想要全身可见的效果，请明确写“大幅、快速、接近安全范围 80%”。</p>
                <textarea
                  id="motionPrompt"
                  name="prompt"
                  rows={3}
                  maxLength={240}
                  aria-describedby="motionPromptHelp motionWorkshopStatus"
                  placeholder="例如：大幅左右摇头三次，身体反向摆动，最后回到原位"
                  autoComplete="off"
                />
              </div>

              <div className="workshop-examples" aria-labelledby="motionExamplesLabel">
                <span id="motionExamplesLabel">试试这些描述</span>
                <div className="workshop-example-list" id="motionPromptExamples">
                  <button type="button" data-prompt="动作幅度必须非常明显：快速、大幅地左右摇头三次表示坚决拒绝。头部左右转向达到模型安全范围的80%左右，身体同步反向摆动，眉毛和嘴型表现坚定，最后完整回到原位。">大幅摇头</button>
                  <button type="button" data-prompt="动作幅度非常明显：突然受到惊吓，头部和上身快速大幅后仰到安全范围的85%，双眼睁大、双眉抬高、嘴巴张圆、肩膀抬起。停顿半秒后回弹并完整恢复原位。">强烈惊讶</button>
                  <button type="button" data-prompt="害羞地低下头，轻轻侧过脸，然后自然恢复">害羞地低头</button>
                </div>
              </div>

              <div className="workshop-action-row">
                <div className="workshop-status" id="motionWorkshopStatus" role="status" aria-live="polite" aria-atomic="true" data-state="loading">
                  <span className="workshop-status-mark" aria-hidden="true" />
                  <span className="workshop-status-copy">正在确认当前模型是否支持动作生成…</span>
                  <button id="motionWorkshopRefresh" type="button" hidden>重新检查</button>
                </div>
                <button className="workshop-generate" id="motionGenerateButton" type="submit" disabled>
                  <span className="generate-label">生成动作</span>
                  <span className="generate-indicator" aria-hidden="true"><i /><i /><i /></span>
                </button>
              </div>

              <div className="workshop-result" id="motionWorkshopResult" hidden>
                <div><strong id="motionWorkshopResultTitle">动作已加入动作库</strong><span id="motionWorkshopResultMeta" /></div>
                <button id="motionReplayButton" type="button">再播放一次</button>
              </div>
            </form>
          </section>
        </main>

        <footer className="page-footer">
          <span className="copyright-note" id="footerModelAttribution">演示角色：Hiyori Momose ©Live2D</span>
          <span>Built for playable AI characters.</span>
          <span id="footerBrand">PromptSoul / 2026</span>
        </footer>
      </div>

      <LegacyRuntime />
    </>
  );
}
