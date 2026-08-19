import {
  TtsPlaybackManager,
  getUnstreamedReplyTail,
} from "../lib/shared/browser-tts";
import { ActionCueScheduler } from "../lib/shared/action-cue-scheduler";
import { playFallbackWithRetry } from "../lib/shared/fallback-playback";

(() => {
  "use strict";

  const CUSTOM_GROUP_PRIORITY = ["PromptSoul", "Action"];
  const MOTION_CAPABILITIES_ENDPOINT = "/api/motions/capabilities";
  const MOTION_GENERATE_ENDPOINT = "/api/motions/generate";
  const MOTION_DELETE_ENDPOINT = (motionId) => `/api/motions/${encodeURIComponent(motionId)}`;
  const MOTION_REQUEST_TIMEOUT_MS = 120000;
  const MOTION_DELETE_TIMEOUT_MS = 30000;
  const WARDROBE_ENDPOINT = "/api/wardrobe";
  const WARDROBE_GENERATE_ENDPOINT = "/api/wardrobe/generate";
  const WARDROBE_SELECT_ENDPOINT = "/api/wardrobe/select";
  const WARDROBE_GENERATION_TIMEOUT_MS = 14 * 60 * 1000;
  const TTS_STATUS_ENDPOINT = "/api/tts/status";
  const TTS_SYNTHESIS_ENDPOINT = "/api/tts";
  const REALTIME_FALLBACK_SEGMENT_SECONDS = 3;
  const PART_OPACITY_ADDRESS_PREFIX = "PartOpacity:";
  const MOUTH_PARAMETER_IDS = [
    "ParamMouthOpenY",
    "PARAM_MOUTH_OPEN_Y",
    "MouthOpenY",
    "ParamMouthOpen",
    "PARAM_MOUTH_OPEN",
    "MouthOpen",
  ];
  const GENERATED_MOTION_ID_PATTERN = /^promptsoul_ai_[0-9a-f]{12}$/;
  const MOTION_REVISION_PATTERN = /^rev_[0-9a-f]{16}$/;
  const EMOTIONS = [
    "happy",
    "wink",
    "nod",
    "thinking",
    "surprised",
    "shy",
    "shakehead",
    "neutral",
  ];
  const EMOTION_LABELS = {
    happy: "开心",
    wink: "眨眨眼",
    nod: "点头",
    thinking: "思考中",
    surprised: "惊讶",
    shy: "害羞",
    shakehead: "摇摇头",
    neutral: "平静",
  };
  const EMOTION_ALIASES = {
    happy: ["happy", "joy", "smile", "开心", "喜ぶ", "高兴"],
    wink: ["wink", "眨眼", "ウィンク"],
    nod: ["nod", "点头", "うなずき"],
    thinking: ["thinking", "think", "思考", "考え中"],
    surprised: ["surprised", "surprise", "惊讶", "びっくり"],
    shy: ["shy", "害羞", "照れる"],
    shakehead: ["shakehead", "head_shake", "摇头", "首ふり"],
  };

  const DEFAULT_CONFIG = {
    brand: "PromptSoul",
    labTitle: "AI Live2D NPC Lab",
    modelAttribution: "Hiyori Momose ©Live2D",
    apiEndpoint: "/api/chat",
    requestTimeoutMs: 45000,
    npc: {
      name: "小予",
      avatar: "PS",
      role: "来自游戏世界的见习向导",
      greeting: "嗨，我是小予。这里还只是一个实验室，但我已经能听懂你的话，再用表情和动作回答你了。要不要试着和我聊两句？",
    },
    suggestions: [
      "你是谁？",
      "给我一个惊喜",
      "你会哪些动作？",
      "被夸奖时会害羞吗？",
    ],
    demoReplies: {
      happy: "被你发现啦。现在的我已经会用表情回应你，虽然动作还不算多，但每一个都是认真练过的。",
      wink: "这个算我们之间的小暗号。下次你一提到眨眼，我就知道该怎么回应了。",
      nod: "嗯，我同意。对游戏里的角色来说，能把回答和动作连起来，才更像真的在和你交流。",
      thinking: "让我想一想……我会先理解你这句话的情绪，再从已有动作里挑一个最合适的回应。",
      surprised: "哇，你真的触发了隐藏反应。台词和动作同时发生时，角色是不是一下子鲜活了很多？",
      shy: "突然这么说，我会有点不好意思……不过谢谢你，我把这句话收下了。",
      shakehead: "这次我先摇摇头。我的动作来自现有模型参数，做不到的事情可不能假装会。",
      neutral: "我听见了。你可以继续问我，也可以点下面的动作按钮，看看我还能怎么回应。",
    },
  };

  const dom = {
    stage: document.getElementById("stage"),
    status: document.querySelector("#status .status-text"),
    modelState: document.getElementById("modelState"),
    modelPlaceholder: document.getElementById("modelPlaceholder"),
    resetView: document.getElementById("resetView"),
    characterTitle: document.getElementById("characterTitle"),
    characterRole: document.getElementById("characterRole"),
    newButtons: document.getElementById("newButtons"),
    existingButtons: document.getElementById("buttons"),
    motionCount: document.getElementById("motionCount"),
    npcAvatar: document.getElementById("npcAvatar"),
    chatTitle: document.getElementById("chatTitle"),
    npcRole: document.getElementById("npcRole"),
    chatMode: document.getElementById("chatMode"),
    chatHistory: document.getElementById("chatHistory"),
    typingState: document.getElementById("typingState"),
    suggestions: document.getElementById("suggestions"),
    chatForm: document.getElementById("chatForm"),
    chatInput: document.getElementById("chatInput"),
    sendButton: document.getElementById("sendButton"),
    replySource: document.getElementById("replySource"),
    brandName: document.getElementById("brandName"),
    brandLabTitle: document.getElementById("brandLabTitle"),
    footerBrand: document.getElementById("footerBrand"),
    stageAttribution: document.getElementById("stageAttribution"),
    footerModelAttribution: document.getElementById("footerModelAttribution"),
    wardrobeWorkshop: document.getElementById("wardrobeWorkshop"),
    wardrobeAvailability: document.getElementById("wardrobeAvailability"),
    wardrobeForm: document.getElementById("wardrobeForm"),
    wardrobePresetList: document.getElementById("wardrobePresetList"),
    wardrobeRefresh: document.getElementById("wardrobeRefresh"),
    wardrobePrompt: document.getElementById("wardrobePrompt"),
    wardrobePromptCounter: document.getElementById("wardrobePromptCounter"),
    wardrobePromptExamples: document.getElementById("wardrobePromptExamples"),
    wardrobeStatus: document.getElementById("wardrobeStatus"),
    wardrobeStatusCopy: document.querySelector("#wardrobeStatus .workshop-status-copy"),
    wardrobeGenerateButton: document.getElementById("wardrobeGenerateButton"),
    wardrobeGenerateLabel: document.querySelector("#wardrobeGenerateButton .generate-label"),
    motionWorkshop: document.getElementById("motionWorkshop"),
    motionWorkshopAvailability: document.getElementById("motionWorkshopAvailability"),
    motionWorkshopGroup: document.getElementById("motionWorkshopGroup"),
    motionWorkshopForm: document.getElementById("motionWorkshopForm"),
    motionPrompt: document.getElementById("motionPrompt"),
    motionPromptCounter: document.getElementById("motionPromptCounter"),
    motionPromptExamples: document.getElementById("motionPromptExamples"),
    motionWorkshopStatus: document.getElementById("motionWorkshopStatus"),
    motionWorkshopStatusCopy: document.querySelector("#motionWorkshopStatus .workshop-status-copy"),
    motionWorkshopRefresh: document.getElementById("motionWorkshopRefresh"),
    motionGenerateButton: document.getElementById("motionGenerateButton"),
    motionGenerateLabel: document.querySelector("#motionGenerateButton .generate-label"),
    motionWorkshopResult: document.getElementById("motionWorkshopResult"),
    motionWorkshopResultTitle: document.getElementById("motionWorkshopResultTitle"),
    motionWorkshopResultMeta: document.getElementById("motionWorkshopResultMeta"),
    motionReplayButton: document.getElementById("motionReplayButton"),
  };

  function createActionCueScheduler() {
    return new ActionCueScheduler({
      onCueApplied: (event) => {
        const run = state.activeChatRun;
        if (
          !isCurrentChatRun(run)
          || run.turnId !== event.turnId
          || run.modelEpoch !== event.modelEpoch
        ) return;
        publishRealtimeDiagnostics({
          cueApplications: state.realtimeDiagnostics.cueApplications + 1,
          lastCueClockMode: event.clockId,
          lastCueParameterIds: [...event.parameterIds],
        });
        if (run.clockMode !== "audio" || event.clockId !== "audio") return;
        recordRealtimeSyncDrift(
          Math.max(0, (event.appliedAt - event.scheduledAt) * 1_000),
        );
      },
      onFrameApplied: (event) => {
        const run = state.activeChatRun;
        if (
          !isCurrentChatRun(run)
          || run.turnId !== event.turnId
          || run.modelEpoch !== event.modelEpoch
        ) return;
        const partOpacityIds = event.parameterIds.filter((parameterId) => (
          parameterId.startsWith(PART_OPACITY_ADDRESS_PREFIX)
        ));
        publishRealtimeDiagnostics({
          frameWrites: state.realtimeDiagnostics.frameWrites + 1,
          parameterWrites: state.realtimeDiagnostics.parameterWrites + event.writeCount,
          partOpacityWrites: state.realtimeDiagnostics.partOpacityWrites + partOpacityIds.length,
          partOpacityIds: [...new Set([
            ...state.realtimeDiagnostics.partOpacityIds,
            ...partOpacityIds,
          ])].sort(),
          lastCueClockMode: event.clockId,
          lastCueParameterIds: [...event.parameterIds],
        });
      },
      onSegmentEnded: handleRealtimeCueSegmentEnded,
    });
  }

  const state = {
    config: DEFAULT_CONFIG,
    pixiApp: null,
    model: null,
    modelReady: false,
    modelEpoch: 0,
    userAdjusted: false,
    layoutModel: null,
    messages: [],
    chatBusy: false,
    chatRevision: 0,
    chatController: null,
    activeChatRun: null,
    emotionMotions: new Map(),
    activeMotionButton: null,
    pendingEmotion: null,
    motionCapabilities: null,
    workshopBusy: false,
    deletingMotionId: null,
    generatedMotion: null,
    wardrobe: null,
    wardrobeBusy: false,
    ttsEnabled: false,
    ttsStatus: null,
    ttsStatusRevision: 0,
    ttsPlaybackRevision: 0,
    pendingSpeechEmotion: null,
    activeSpeechEmotion: null,
    speechMotionRestartScheduled: false,
    ttsManager: null,
    lipSyncValue: 0,
    appliedLipSyncValue: 0,
    peakAppliedLipSyncValue: 0,
    lipSyncParameterIds: [],
    lipSyncParameterReadbackVerified: false,
    lipSyncAvailable: false,
    lipSyncResetPending: false,
    frameEffectsBinding: null,
    actionCueScheduler: createActionCueScheduler(),
    realtimeClockMode: null,
    realtimeDiagnostics: {
      ttfcMs: null,
      invalidCues: 0,
      bufferUnderruns: 0,
      syncDriftMs: null,
      syncDriftP95Ms: null,
      segmentsReceived: 0,
      cueSegmentsAccepted: 0,
      cueSegmentsBound: 0,
      cueSegmentsFallback: 0,
      bindFailures: 0,
      cueApplications: 0,
      frameWrites: 0,
      parameterWrites: 0,
      partOpacityWrites: 0,
      partOpacityIds: [],
      noopSegments: 0,
      clockMode: null,
      lastCueClockMode: null,
      lastCueParameterIds: [],
    },
    realtimeDriftSamples: [],
  };

  function mergeConfig(remote) {
    return {
      ...DEFAULT_CONFIG,
      ...(remote || {}),
      npc: { ...DEFAULT_CONFIG.npc, ...(remote?.npc || {}) },
      suggestions: Array.isArray(remote?.suggestions)
        ? remote.suggestions
        : DEFAULT_CONFIG.suggestions,
      demoReplies: { ...DEFAULT_CONFIG.demoReplies, ...(remote?.demoReplies || {}) },
    };
  }

  async function loadNpcConfig() {
    try {
      const response = await fetch("npc.config.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.config = mergeConfig(await response.json());
    } catch (error) {
      state.config = mergeConfig(null);
      console.info("PromptSoul: using the bundled NPC defaults.", error);
    }
  }

  function applyNpcConfig() {
    const { npc, brand, labTitle, modelAttribution } = state.config;
    const avatar = String(npc.avatar || npc.name || "PS").slice(0, 2).toUpperCase();
    document.title = `${brand} · ${labTitle}`;
    dom.brandName.textContent = brand;
    dom.brandLabTitle.textContent = labTitle;
    dom.footerBrand.textContent = `${brand} / 2026`;
    dom.stageAttribution.textContent = modelAttribution;
    dom.footerModelAttribution.textContent = `演示角色：${modelAttribution}`;
    dom.characterTitle.textContent = npc.name;
    dom.characterRole.textContent = npc.role;
    dom.chatTitle.replaceChildren(document.createTextNode(`${npc.name} `));
    const verified = document.createElement("span");
    verified.className = "verified";
    verified.title = `${brand} 实验角色`;
    verified.textContent = "✦";
    dom.chatTitle.appendChild(verified);
    dom.npcRole.textContent = npc.role;
    dom.npcAvatar.querySelector("span").textContent = avatar;
    document.querySelectorAll(".message-avatar").forEach((node) => {
      node.textContent = avatar;
    });
  }

  function setStatus(message) {
    dom.status.textContent = message;
  }

  function setModelState(mode, copy) {
    dom.modelState.dataset.state = mode;
    dom.modelState.querySelector(".state-copy").textContent = copy;
  }

  function setPlaceholderError(message) {
    dom.modelPlaceholder.classList.add("is-error");
    dom.modelPlaceholder.querySelector("strong").textContent = "模型暂时没有连接";
    dom.modelPlaceholder.querySelector("small").textContent = message;
  }

  function hidePlaceholder() {
    dom.modelPlaceholder.classList.add("is-hidden");
  }

  function showModelPlaceholder(message = "正在重新载入 Live2D 模型") {
    dom.modelPlaceholder.classList.remove("is-hidden", "is-error");
    dom.modelPlaceholder.querySelector("strong").textContent = message;
    dom.modelPlaceholder.querySelector("small").textContent = "正在读取最新的角色参数与动作列表…";
  }

  function setWorkshopStatus(mode, message, options = {}) {
    dom.motionWorkshop.dataset.state = mode;
    dom.motionWorkshopStatus.dataset.state = mode;
    dom.motionWorkshopStatusCopy.textContent = message;
    dom.motionWorkshopRefresh.hidden = !options.retry;
  }

  function updateMotionPromptCounter() {
    const maxLength = Number(dom.motionPrompt.maxLength) || 240;
    dom.motionPromptCounter.textContent = `${dom.motionPrompt.value.length} / ${maxLength}`;
  }

  function syncWorkshopControls() {
    const available = Boolean(state.motionCapabilities?.available);
    const disabled = state.workshopBusy || state.wardrobeBusy || Boolean(state.deletingMotionId) || !available;
    dom.motionPrompt.disabled = disabled;
    dom.motionGenerateButton.disabled = disabled;
    dom.motionPromptExamples.querySelectorAll("button").forEach((button) => {
      button.disabled = disabled;
    });
    dom.motionWorkshopRefresh.disabled = state.workshopBusy || Boolean(state.deletingMotionId);
    syncMotionDeleteControls();
  }

  function setWorkshopBusy(busy) {
    state.workshopBusy = busy;
    dom.motionWorkshopForm.setAttribute("aria-busy", String(busy));
    dom.motionGenerateButton.classList.toggle("is-busy", busy);
    dom.motionGenerateLabel.textContent = busy ? "正在生成" : "生成动作";
    syncWorkshopControls();
  }

  function getApiErrorMessage(payload, fallback) {
    const candidate = payload?.error;
    const code = typeof candidate?.code === "string" ? candidate.code : "";
    const localized = {
      motion_generation_unavailable: "当前未配置动作生成服务。请在服务端配置 API Key 后重新检查。",
      generation_in_progress: "已有动作生成或删除任务正在进行，请稍候再试。",
      motion_not_feasible: "当前模型无法安全完成这个动作。请减小幅度，或改用表情、头部和身体动作。",
      motion_limit_reached: "当前模型已保存 24 个 AI 动作。请先整理本地生成动作后再继续。",
      model_changed: "动作库或当前模型发生了变化，已停止本次操作。",
      invalid_prompt: "动作描述无效，请换一种更清楚、简短的说法。",
      prompt_too_large: "动作描述太长，请缩短后重试。",
      provider_timeout: "AI 服务响应超时，请稍后重试。",
      provider_auth_error: "API Key 无效或没有模型权限，请在 AI 设置中更新。",
      provider_error: "AI 服务暂时不可用，请稍后重试。",
      provider_response_invalid: "AI 返回的动作不符合安全格式，请调整描述后重试。",
      authoring_failed: "动作未能安全写入，请调整描述后重试。",
      invalid_motion_id: "这个动作不是可删除的 AI 动作。",
      invalid_revision: "动作列表版本已失效，请重新载入后再试。",
      motion_not_found: "这个动作不存在或已经被删除，动作列表将重新载入。",
      motion_delete_conflict: "无法安全确认这个动作的本地文件，因此没有删除。",
      motion_delete_unavailable: "当前模型尚未准备好，暂时不能删除动作。",
      motion_delete_failed: "动作删除失败，请稍后重试。",
      protected_model: "当前模型的角色设计不允许修改，衣橱功能已保护性关闭。",
      promptskin_unavailable: "PromptSkin 后端未连接，请先启动 PromptSkin 并检查服务端地址。",
      promptskin_request_failed: "PromptSkin 拒绝了本次请求，请检查图片服务配置。",
      promptskin_generation_failed: "PromptSkin 图片生成失败，提示词已保留，可以调整后重试。",
      promptskin_timeout: "换装生成超时，请检查 PromptSkin 任务状态后重试。",
      generated_model_changed: "生成包修改了 model3，出于绑定安全考虑已拒绝安装。",
      generated_rig_changed: "生成包修改了 moc3 绑定，已拒绝安装。",
      generated_texture_layout_changed: "生成包改变了纹理路径，已拒绝安装。",
      texture_dimensions_changed: "生成纹理改变了 UV 画布尺寸，已拒绝安装。",
      wardrobe_revision_changed: "衣橱已经发生变化，请刷新预设后重试。",
      wardrobe_model_changed: "当前模型结构已经变化，请清理对应本地衣橱后重新初始化。",
      preset_not_found: "这个衣服预设不存在或已经被移除。",
      wardrobe_switch_failed: "衣服切换失败，原纹理已经回滚。",
    };
    if (localized[code]) return localized[code];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate?.message === "string" && candidate.message.trim()) {
      return candidate.message.trim();
    }
    return fallback;
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        console.info("PromptSoul: motion API returned a non-JSON response.", error);
      }
      if (!response.ok) {
        const requestError = new Error(
          getApiErrorMessage(payload, `动作服务返回 HTTP ${response.status}`),
        );
        requestError.code = typeof payload?.error?.code === "string" ? payload.error.code : "";
        throw requestError;
      }
      return payload || {};
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("动作服务响应超时，请稍后重试");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function loadMotionCapabilities() {
    state.motionCapabilities = null;
    dom.motionWorkshopAvailability.textContent = "检查生成能力中";
    setWorkshopStatus("loading", "正在确认当前模型是否支持动作生成…");
    syncWorkshopControls();
    try {
      const payload = await fetchJsonWithTimeout(
        MOTION_CAPABILITIES_ENDPOINT,
        { cache: "no-store" },
      );
      const maxPromptLength = Number.isInteger(payload.maxPromptLength) && payload.maxPromptLength > 0
        ? payload.maxPromptLength
        : 240;
      const motions = Array.isArray(payload.motions) ? payload.motions : [];
      const group = String(payload.group || CUSTOM_GROUP_PRIORITY[0]);
      state.motionCapabilities = {
        available: Boolean(payload.available),
        mode: String(payload.mode || "unknown"),
        group,
        maxPromptLength,
        motions,
      };
      dom.motionPrompt.maxLength = maxPromptLength;
      dom.motionWorkshopGroup.textContent = `仅写入 ${group}`;
      updateMotionPromptCounter();

      if (!state.motionCapabilities.available) {
        dom.motionWorkshopAvailability.textContent = "当前不可用";
        setWorkshopStatus(
          "unavailable",
          "当前服务未启用动作生成。完成服务端配置后，可以重新检查。",
          { retry: true },
        );
      } else {
        const modeCopy = state.motionCapabilities.mode === "provider"
          ? "AI 生成已连接"
          : "生成服务已连接";
        dom.motionWorkshopAvailability.textContent = modeCopy;
        setWorkshopStatus(
          "ready",
          `${group} 动作组已就绪，当前有 ${motions.length} 个动作。`,
        );
      }
      return true;
    } catch (error) {
      dom.motionWorkshopAvailability.textContent = "连接失败";
      setWorkshopStatus(
        "error",
        error.message || "无法连接动作服务，请重新检查。",
        { retry: true },
      );
      console.error("PromptSoul: motion capabilities unavailable.", error);
      return false;
    } finally {
      syncWorkshopControls();
    }
  }

  function setWardrobeStatus(mode, message) {
    dom.wardrobeWorkshop.dataset.state = mode;
    dom.wardrobeStatus.dataset.state = mode;
    dom.wardrobeStatusCopy.textContent = message;
  }

  function updateWardrobePromptCounter() {
    const maxLength = Number(dom.wardrobePrompt.maxLength) || 1200;
    dom.wardrobePromptCounter.textContent = `${dom.wardrobePrompt.value.length} / ${maxLength}`;
  }

  function normalizeWardrobeStatus(payload, previous = null) {
    const presets = Array.isArray(payload?.presets)
      ? payload.presets.filter((preset) => (
        preset
        && typeof preset.id === "string"
        && typeof preset.name === "string"
      ))
      : [];
    const generator = payload?.generator && typeof payload.generator === "object"
      ? payload.generator
      : previous?.generator || null;
    return {
      available: Boolean(payload?.available),
      protected: Boolean(payload?.protected),
      reason: typeof payload?.reason === "string" ? payload.reason : null,
      modelName: typeof payload?.modelName === "string" ? payload.modelName : null,
      activePresetId: typeof payload?.activePresetId === "string" ? payload.activePresetId : null,
      revision: Number.isInteger(payload?.revision) ? payload.revision : 0,
      presets,
      generator,
    };
  }

  function syncWardrobeControls() {
    const wardrobe = state.wardrobe;
    const generationAvailable = Boolean(wardrobe?.available && wardrobe?.generator?.available);
    const disabled = state.wardrobeBusy || state.workshopBusy || Boolean(state.deletingMotionId);
    dom.wardrobePrompt.disabled = disabled || !generationAvailable;
    dom.wardrobeGenerateButton.disabled = disabled || !generationAvailable;
    dom.wardrobeRefresh.disabled = state.wardrobeBusy;
    dom.wardrobePromptExamples.querySelectorAll("button").forEach((button) => {
      button.disabled = disabled || !generationAvailable;
    });
    dom.wardrobePresetList.querySelectorAll("button[data-preset-id]").forEach((button) => {
      button.disabled = disabled || button.dataset.active === "true" || Boolean(wardrobe?.protected);
    });
  }

  function setWardrobeBusy(busy, label = "正在处理") {
    state.wardrobeBusy = busy;
    dom.wardrobeForm.setAttribute("aria-busy", String(busy));
    dom.wardrobeGenerateButton.classList.toggle("is-busy", busy);
    dom.wardrobeGenerateLabel.textContent = busy ? label : "生成并穿上";
    syncWardrobeControls();
    syncWorkshopControls();
  }

  function renderWardrobePresets() {
    dom.wardrobePresetList.replaceChildren();
    const presets = state.wardrobe?.presets || [];
    if (!presets.length) {
      const empty = document.createElement("div");
      empty.className = "wardrobe-empty";
      empty.textContent = "当前模型还没有可用的衣服预设。";
      dom.wardrobePresetList.appendChild(empty);
      return;
    }
    for (const preset of presets) {
      const active = preset.id === state.wardrobe.activePresetId;
      const card = document.createElement("article");
      card.className = "wardrobe-preset";
      card.dataset.active = String(active);

      const copy = document.createElement("div");
      copy.className = "wardrobe-preset-copy";
      const title = document.createElement("strong");
      title.textContent = preset.id === "original" ? "原始服装" : preset.name;
      title.title = title.textContent;
      const meta = document.createElement("small");
      meta.textContent = preset.id === "original"
        ? "模板原始纹理"
        : `${String(preset.provider || "generated").toUpperCase()} · 已保存`;
      copy.append(title, meta);

      const button = document.createElement("button");
      button.type = "button";
      button.dataset.presetId = preset.id;
      button.dataset.active = String(active);
      button.textContent = active ? "当前" : "穿上";
      button.title = typeof preset.prompt === "string" && preset.prompt
        ? preset.prompt
        : title.textContent;
      button.addEventListener("click", () => selectWardrobe(preset.id, title.textContent));
      card.append(copy, button);
      dom.wardrobePresetList.appendChild(card);
    }
    syncWardrobeControls();
  }

  async function fetchWardrobeJson(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        console.info("PromptSoul: wardrobe API returned a non-JSON response.", error);
      }
      if (!response.ok) {
        const requestError = new Error(
          getApiErrorMessage(payload, `换装服务返回 HTTP ${response.status}`),
        );
        requestError.code = typeof payload?.error?.code === "string" ? payload.error.code : "";
        throw requestError;
      }
      return payload || {};
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("换装服务响应超时，请稍后重试。");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function describeWardrobeAvailability(wardrobe) {
    if (!wardrobe.modelName) return ["未导入模型", "请先导入一个有权修改纹理的 Live2D 模型。", "unavailable"];
    if (wardrobe.protected) {
      return ["模型受保护", "当前角色设计受许可条款保护，换装功能已关闭。", "unavailable"];
    }
    if (wardrobe.generator?.available) {
      return [
        `${String(wardrobe.generator.provider || "AI").toUpperCase()} 已连接`,
        `衣橱已就绪：${wardrobe.presets.length} 套衣服，可直接切换或生成新风格。`,
        "ready",
      ];
    }
    return [
      "预设切换可用",
      `可以切换 ${wardrobe.presets.length} 套已保存衣服；生成新衣服前请启动并配置 PromptSkin。`,
      "ready",
    ];
  }

  async function loadWardrobe() {
    if (state.wardrobeBusy) return false;
    dom.wardrobeAvailability.textContent = "检查衣橱中";
    setWardrobeStatus("loading", "正在检查 PromptSkin 和当前模型…");
    try {
      const payload = await fetchWardrobeJson(WARDROBE_ENDPOINT, {}, 10000);
      state.wardrobe = normalizeWardrobeStatus(payload, state.wardrobe);
      renderWardrobePresets();
      const [availability, message, mode] = describeWardrobeAvailability(state.wardrobe);
      dom.wardrobeAvailability.textContent = availability;
      setWardrobeStatus(mode, message);
      return true;
    } catch (error) {
      dom.wardrobeAvailability.textContent = "衣橱连接失败";
      setWardrobeStatus("error", error.message || "无法读取衣橱，请刷新后重试。");
      console.error("PromptSoul: wardrobe unavailable.", error);
      return false;
    } finally {
      syncWardrobeControls();
    }
  }

  async function reloadLive2DForWardrobe(revision) {
    setModelState("loading", "正在更换服装");
    setStatus("纹理已切换 · 正在重新载入角色");
    destroyCurrentLive2D({ releaseTextures: true });
    showModelPlaceholder("正在穿上新服装");
    return initLive2D({ modelRevision: `wardrobe-${revision}-${Date.now()}` });
  }

  async function selectWardrobe(presetId, label) {
    if (state.wardrobeBusy || state.workshopBusy || !state.wardrobe || presetId === state.wardrobe.activePresetId) return;
    setWardrobeBusy(true, "正在换装");
    setWardrobeStatus("loading", `正在穿上“${label}”…`);
    try {
      const payload = await fetchWardrobeJson(
        WARDROBE_SELECT_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ presetId, revision: state.wardrobe.revision }),
        },
        30000,
      );
      state.wardrobe = normalizeWardrobeStatus(payload, state.wardrobe);
      renderWardrobePresets();
      const result = await reloadLive2DForWardrobe(state.wardrobe.revision);
      setWardrobeStatus(
        result.loaded ? "success" : "error",
        result.loaded ? `已穿上“${label}”，原有绑定和动作保持不变。` : "纹理已切换，但模型重新载入失败，请刷新页面。",
      );
    } catch (error) {
      setWardrobeStatus("error", error.message || "换装失败，请刷新衣橱后重试。");
      if (error.code === "wardrobe_revision_changed") await loadWardrobe();
      console.error("PromptSoul: wardrobe selection failed.", error);
    } finally {
      setWardrobeBusy(false);
    }
  }

  async function generateWardrobe() {
    if (state.wardrobeBusy || state.workshopBusy || !state.wardrobe?.generator?.available) return;
    const prompt = dom.wardrobePrompt.value.replace(/\s+/g, " ").trim();
    if (prompt.length < 3) {
      setWardrobeStatus("error", "请先写下希望角色穿上的服装风格。提示词不会被清空。");
      dom.wardrobePrompt.focus();
      return;
    }
    setWardrobeBusy(true, "正在生成");
    setWardrobeStatus("generating", "PromptSkin 正在重绘纹理，完成后会验证绑定并自动穿上，请不要关闭页面…");
    try {
      const payload = await fetchWardrobeJson(
        WARDROBE_GENERATE_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
        WARDROBE_GENERATION_TIMEOUT_MS,
      );
      state.wardrobe = normalizeWardrobeStatus(payload, state.wardrobe);
      renderWardrobePresets();
      const active = state.wardrobe.presets.find((preset) => preset.id === state.wardrobe.activePresetId);
      const result = await reloadLive2DForWardrobe(state.wardrobe.revision);
      if (result.loaded) {
        dom.wardrobePrompt.value = "";
        updateWardrobePromptCounter();
      }
      setWardrobeStatus(
        result.loaded ? "success" : "error",
        result.loaded
          ? `“${active?.name || "新服装"}”已保存并穿上，UV、绑定、物理和动作均已保留。`
          : "新服装已保存并切换，但模型重新载入失败，请刷新页面。",
      );
    } catch (error) {
      setWardrobeStatus("error", error.message || "换装生成失败。提示词已保留，可以调整后重试。");
      console.error("PromptSoul: wardrobe generation failed.", error);
    } finally {
      setWardrobeBusy(false);
    }
  }

  function initWardrobe() {
    dom.wardrobeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      generateWardrobe();
    });
    dom.wardrobePrompt.addEventListener("input", updateWardrobePromptCounter);
    dom.wardrobePromptExamples.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        const maxLength = Number(dom.wardrobePrompt.maxLength) || 1200;
        dom.wardrobePrompt.value = String(button.dataset.prompt || "").slice(0, maxLength);
        updateWardrobePromptCounter();
        dom.wardrobePrompt.focus();
      });
    });
    dom.wardrobeRefresh.addEventListener("click", loadWardrobe);
    updateWardrobePromptCounter();
    syncWardrobeControls();
    loadWardrobe();
  }

  function normalizeEmotion(value) {
    const normalized = String(value || "neutral").trim().toLowerCase();
    return EMOTIONS.includes(normalized) ? normalized : "neutral";
  }

  function getMotionFile(entry) {
    return String(entry?.File || "")
      .split("/")
      .pop()
      .replace(/\.motion3\.json$/i, "");
  }

  function detectMotionEmotion(entry) {
    const haystack = `${getMotionFile(entry)} ${entry?.Name || ""}`.toLowerCase();
    for (const [emotion, aliases] of Object.entries(EMOTION_ALIASES)) {
      if (aliases.some((alias) => haystack.includes(alias.toLowerCase()))) return emotion;
    }
    return null;
  }

  function getGeneratedMotionId(group, entry) {
    if (group !== CUSTOM_GROUP_PRIORITY[0]) return null;
    const motionId = getMotionFile(entry);
    return GENERATED_MOTION_ID_PATTERN.test(motionId) ? motionId : null;
  }

  function getGeneratedMotionRevision(motionId) {
    const motion = state.motionCapabilities?.motions?.find((entry) => entry?.name === motionId);
    const revision = String(motion?.revision || "");
    return MOTION_REVISION_PATTERN.test(revision) ? revision : null;
  }

  function syncMotionDeleteControls() {
    const deleting = Boolean(state.deletingMotionId);
    document.querySelectorAll(".motion-delete-button").forEach((button) => {
      const isCurrent = deleting && button.dataset.motionId === state.deletingMotionId;
      const hasRevision = Boolean(getGeneratedMotionRevision(button.dataset.motionId));
      button.disabled = deleting || state.workshopBusy || !hasRevision;
      button.setAttribute("aria-busy", String(isCurrent));
      button.closest(".motion-card")?.classList.toggle("is-deleting", isCurrent);
    });
    document.querySelectorAll(".motion-button").forEach((button) => {
      button.disabled = deleting;
    });
  }

  function setMotionDeleteBusy(motionId = null) {
    state.deletingMotionId = motionId;
    syncWorkshopControls();
  }

  function clearActiveMotion() {
    if (state.activeMotionButton) {
      state.activeMotionButton.classList.remove("is-playing");
      state.activeMotionButton = null;
    }
  }

  function stopActiveLive2DMotion() {
    try {
      state.model?.internalModel?.motionManager?.stopAllMotions?.();
    } catch {
      // A model can disappear while a replacement turn is taking ownership.
    }
    clearActiveMotion();
  }

  async function playMotion(group, index, label, button = null) {
    if (!state.modelReady || !state.model) return false;
    clearActiveMotion();
    if (button) {
      button.classList.add("is-playing");
      state.activeMotionButton = button;
    }
    setStatus(`动作播放 · ${label}`);
    try {
      const priority = window.PIXI.live2d.MotionPriority.FORCE;
      const started = await state.model.motion(group, index, priority);
      if (!started) {
        clearActiveMotion();
        setStatus(`动作未能播放 · ${label}`);
      }
      return Boolean(started);
    } catch (error) {
      clearActiveMotion();
      setStatus(`动作播放失败 · ${label}`);
      console.error(error);
      return false;
    }
  }

  async function playEmotion(emotion) {
    const normalized = normalizeEmotion(emotion);
    if (normalized === "neutral") {
      state.pendingEmotion = null;
      return false;
    }
    const target = state.emotionMotions.get(normalized);
    if (!state.modelReady || !target) {
      state.pendingEmotion = normalized;
      return false;
    }
    state.pendingEmotion = null;
    return playMotion(target.group, target.index, target.label, target.button);
  }

  async function restartEmotionForSpeech(emotion) {
    const normalized = normalizeEmotion(emotion);
    const target = state.emotionMotions.get(normalized);
    if (!state.modelReady || !state.model || !target) return false;
    try {
      state.model.internalModel.motionManager?.stopAllMotions?.();
    } catch (error) {
      console.info("PromptSoul: current motion could not be stopped before speech replay.", error);
    }
    clearActiveMotion();
    return playMotion(target.group, target.index, target.label, target.button);
  }

  function createMotionButton(group, entry, index, isCustom) {
    const file = getMotionFile(entry);
    const generatedMotionId = getGeneratedMotionId(group, entry);
    const emotion = detectMotionEmotion(entry);
    const label = entry.Name || (emotion && EMOTION_LABELS[emotion]) || file || `动作 ${index + 1}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "motion-button";
    button.dataset.group = group;
    button.dataset.index = String(index);
    if (emotion) button.dataset.emotion = emotion;

    const glyph = document.createElement("span");
    glyph.className = "motion-glyph";
    glyph.textContent = isCustom ? "✦" : "·";
    const title = document.createElement("strong");
    title.textContent = label;
    const detail = document.createElement("small");
    detail.textContent = file || `${group}:${index}`;
    button.append(glyph, title, detail);
    button.addEventListener("click", () => playMotion(group, index, label, button));

    if (!isCustom) return { element: button, button, emotion, label };

    const card = document.createElement("div");
    card.className = "motion-card";
    card.appendChild(button);
    if (generatedMotionId) {
      card.classList.add("is-generated");
      button.classList.add("has-delete");
      button.dataset.motionId = generatedMotionId;
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "motion-delete-button";
      deleteButton.dataset.motionId = generatedMotionId;
      deleteButton.title = `删除 AI 动作“${label}”`;
      deleteButton.setAttribute("aria-label", `删除 AI 动作：${label}`);
      const deleteIcon = document.createElement("span");
      deleteIcon.setAttribute("aria-hidden", "true");
      deleteIcon.textContent = "删";
      deleteButton.appendChild(deleteIcon);
      deleteButton.addEventListener("click", () => {
        deleteGeneratedMotion(generatedMotionId, label);
      });
      card.appendChild(deleteButton);
    }
    return { element: card, button, emotion, label };
  }

  function buildMotionDeck(groups) {
    state.emotionMotions.clear();
    dom.newButtons.replaceChildren();
    dom.existingButtons.replaceChildren();
    let customCount = 0;

    const preferredGroup = Object.prototype.hasOwnProperty.call(groups, CUSTOM_GROUP_PRIORITY[0])
      ? CUSTOM_GROUP_PRIORITY[0]
      : CUSTOM_GROUP_PRIORITY[1];
    const customGroups = [preferredGroup];

    for (const group of customGroups) {
      const entries = Array.isArray(groups[group]) ? groups[group] : [];
      entries.forEach((entry, index) => {
        const motion = createMotionButton(group, entry, index, true);
        dom.newButtons.appendChild(motion.element);
        customCount += 1;
        if (motion.emotion && !state.emotionMotions.has(motion.emotion)) {
          state.emotionMotions.set(motion.emotion, {
            group,
            index,
            label: motion.label,
            button: motion.button,
          });
        }
      });
    }

    if (!customCount) {
      const empty = document.createElement("div");
      empty.className = "motion-empty";
      empty.textContent = "没有找到 PromptSoul / Action 动作组";
      dom.newButtons.appendChild(empty);
    }
    dom.motionCount.textContent = String(customCount);

    for (const [group, entries] of Object.entries(groups)) {
      if (customGroups.includes(group) || !Array.isArray(entries) || !entries.length) continue;
      const details = document.createElement("details");
      details.className = "motion-group";
      const summary = document.createElement("summary");
      summary.append(document.createTextNode(`模型原有 · ${group}`));
      const count = document.createElement("span");
      count.textContent = String(entries.length);
      summary.appendChild(count);
      const body = document.createElement("div");
      body.className = "motion-group-body";
      entries.forEach((entry, index) => {
        body.appendChild(createMotionButton(group, entry, index, false).button);
      });
      details.append(summary, body);
      dom.existingButtons.appendChild(details);
    }
    syncMotionDeleteControls();
  }

  function addModelRevision(modelJson, revision) {
    if (!revision) return modelJson;
    const url = new URL(modelJson, window.location.href);
    url.searchParams.set("_promptsoul_motion", String(revision));
    return url.href;
  }

  function addAssetRevision(asset, modelJson, revision) {
    const url = new URL(asset, modelJson);
    url.searchParams.set("_promptsoul_asset", String(revision));
    return url.href;
  }

  async function revisionedModelSettings(modelJson, revision) {
    const modelUrl = addModelRevision(modelJson, revision);
    const response = await fetch(modelUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Live2D model3 返回 HTTP ${response.status}`);
    const settings = await response.json();
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Live2D model3 不是有效的 JSON 对象");
    }
    settings.url = modelUrl;
    const references = settings.FileReferences;
    if (!references || typeof references !== "object" || Array.isArray(references)) return settings;
    if (Array.isArray(references.Textures)) {
      references.Textures = references.Textures.map((texture) => (
        typeof texture === "string" ? addAssetRevision(texture, modelUrl, revision) : texture
      ));
    }
    if (references.Motions && typeof references.Motions === "object" && !Array.isArray(references.Motions)) {
      for (const motions of Object.values(references.Motions)) {
        if (!Array.isArray(motions)) continue;
        for (const motion of motions) {
          if (motion && typeof motion === "object" && typeof motion.File === "string") {
            motion.File = addAssetRevision(motion.File, modelUrl, revision);
          }
        }
      }
    }
    return settings;
  }

  async function resolveModelJson(modelRevision = null) {
    const params = new URLSearchParams(window.location.search);
    const revision = modelRevision || params.get("motionRevision");
    const override = params.get("model");
    if (override) return revision ? revisionedModelSettings(override, revision) : override;
    const response = await fetch("model.config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("请先运行 npm run setup:model -- /path/to/model 导入模型");
    const config = await response.json();
    if (!config.model3) throw new Error("model.config.json 中缺少 model3 路径");
    return revision ? revisionedModelSettings(config.model3, revision) : config.model3;
  }

  function destroyCurrentLive2D(options = {}) {
    interruptActiveChat();
    state.actionCueScheduler.dispose();
    state.actionCueScheduler = createActionCueScheduler();
    clearActiveMotion();
    uninstallLive2DFrameEffects();
    state.modelReady = false;
    dom.resetView.onclick = null;
    if (state.pixiApp) {
      try {
        state.pixiApp.destroy(true, {
          children: true,
          texture: Boolean(options.releaseTextures),
          baseTexture: Boolean(options.releaseTextures),
        });
      } catch (error) {
        console.info("PromptSoul: Live2D cleanup needed a canvas fallback.", error);
      }
    }
    dom.stage.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    state.pixiApp = null;
    state.model = null;
    state.layoutModel = null;
    state.userAdjusted = false;
  }

  function resolveMouthParameterIds(model) {
    const configured = model?.internalModel?.settings?.getLipSyncParameters?.();
    if (Array.isArray(configured)) {
      const ids = configured.filter((parameterId) => (
        typeof parameterId === "string" && parameterId.trim()
      ));
      if (ids.length) return [...new Set(ids)];
    }
    return MOUTH_PARAMETER_IDS;
  }

  function setMouthOpen(model, parameterIds, value) {
    const coreModel = model?.internalModel?.coreModel;
    if (
      !coreModel?.getParameterCount
      || !coreModel?.getParameterIndex
      || !coreModel?.setParameterValueByIndex
      || !coreModel?.getParameterValueByIndex
    ) return { value: 0, parameterIds: [] };
    const normalized = Math.min(1, Math.max(0, Number(value) || 0));
    const count = Number(coreModel.getParameterCount());
    const appliedValues = [];
    const appliedParameterIds = [];
    for (const parameterId of parameterIds) {
      try {
        const index = Number(coreModel.getParameterIndex(parameterId));
        // Cubism creates synthetic runtime slots for unknown IDs, so a setter
        // not throwing is not proof that the rig owns the parameter.
        if (!Number.isInteger(index) || index < 0 || index >= count) continue;
        coreModel.setParameterValueByIndex(index, normalized);
        const readback = Number(coreModel.getParameterValueByIndex(index));
        if (!Number.isFinite(readback)) continue;
        appliedParameterIds.push(parameterId);
        appliedValues.push(Math.min(1, Math.max(0, readback)));
      } catch {
        // Models expose different mouth parameter IDs. Unsupported aliases are
        // intentionally ignored without touching any model-owned definitions.
      }
    }
    return {
      value: appliedValues.length ? Math.max(...appliedValues) : 0,
      parameterIds: [...new Set(appliedParameterIds)],
    };
  }

  function ownedParameterIds(model, parameterIds) {
    const coreModel = model?.internalModel?.coreModel;
    if (!coreModel?.getParameterCount || !coreModel?.getParameterIndex) return [];
    const count = Number(coreModel.getParameterCount());
    return parameterIds.filter((parameterId) => {
      try {
        const index = Number(coreModel.getParameterIndex(parameterId));
        return Number.isInteger(index) && index >= 0 && index < count;
      } catch {
        return false;
      }
    });
  }

  function createLive2DParameterAccess(coreModel) {
    const indices = new Map();
    const partIndices = new Map();
    const count = Number(coreModel?.getParameterCount?.());
    const resolveIndex = (parameter) => {
      if (indices.has(parameter)) return indices.get(parameter);
      try {
        const index = Number(coreModel?.getParameterIndex?.(parameter));
        const resolved = Number.isInteger(index) && index >= 0 && index < count ? index : null;
        indices.set(parameter, resolved);
        return resolved;
      } catch {
        indices.set(parameter, null);
        return null;
      }
    };
    const resolvePartIndex = (parameter) => {
      const partId = parameter.startsWith(PART_OPACITY_ADDRESS_PREFIX)
        ? parameter.slice(PART_OPACITY_ADDRESS_PREFIX.length)
        : null;
      if (!partId) return null;
      if (partIndices.has(partId)) return partIndices.get(partId);
      try {
        const count = Number(coreModel?.getPartCount?.());
        const index = Number(coreModel?.getPartIndex?.(partId));
        const resolved = Number.isInteger(index) && index >= 0 && index < count ? index : null;
        partIndices.set(partId, resolved);
        return resolved;
      } catch {
        partIndices.set(partId, null);
        return null;
      }
    };
    return {
      read(parameter) {
        const partIndex = resolvePartIndex(parameter);
        if (partIndex !== null) {
          try {
            const value = Number(coreModel.getPartOpacityByIndex(partIndex));
            return Number.isFinite(value) ? value : undefined;
          } catch { return undefined; }
        }
        const index = resolveIndex(parameter);
        if (index === null) return undefined;
        try {
          const value = Number(coreModel.getParameterValueByIndex(index));
          return Number.isFinite(value) ? value : undefined;
        } catch {
          return undefined;
        }
      },
      write(parameter, value) {
        const partIndex = resolvePartIndex(parameter);
        if (partIndex !== null || parameter.startsWith(PART_OPACITY_ADDRESS_PREFIX)) {
          if (partIndex === null || !Number.isFinite(value)) return false;
          try {
            // Cubism pose parts are mutually exclusive drawings. A smooth
            // crossfade produces visible duplicate limbs, so realtime
            // PartOpacity writes deliberately use a hard visibility switch.
            const opacity = value > 0.5 ? 1 : 0;
            coreModel.setPartOpacityByIndex(partIndex, opacity);
            const readback = Number(coreModel.getPartOpacityByIndex(partIndex));
            return Number.isFinite(readback) && Math.abs(readback - opacity) <= 0.0001;
          } catch { return false; }
        }
        const index = resolveIndex(parameter);
        if (index === null || !Number.isFinite(value)) return false;
        try {
          coreModel.setParameterValueByIndex(index, value);
          const readback = Number(coreModel.getParameterValueByIndex(index));
          return Number.isFinite(readback)
            && Math.abs(readback - value) <= Math.max(0.0001, Math.abs(value) * 0.00001);
        } catch {
          // The active model may be changing while a frame is being finalized.
          return false;
        }
      },
    };
  }

  function getRealtimeFrameTime() {
    const clockMode = state.realtimeClockMode;
    if (clockMode === "performance") return performance.now() / 1_000;
    if (clockMode === "audio") return state.ttsManager?.getAudioContextTime?.() ?? null;
    return null;
  }

  function installLive2DFrameEffects(model) {
    uninstallLive2DFrameEffects();
    const internalModel = model?.internalModel;
    if (!internalModel?.on) return;
    const mouthParameterIds = ownedParameterIds(model, resolveMouthParameterIds(model));
    state.lipSyncAvailable = mouthParameterIds.length > 0;
    dom.stage.dataset.lipSync = state.lipSyncAvailable ? "available" : "unavailable";
    const parameterAccess = createLive2DParameterAccess(internalModel.coreModel);
    state.lipSyncParameterIds = [];
    state.lipSyncParameterReadbackVerified = false;
    const updateFrameEffects = () => {
      const now = getRealtimeFrameTime();
      if (Number.isFinite(now)) {
        state.actionCueScheduler.applyFrame(now, parameterAccess);
      }
      if (state.lipSyncResetPending || state.lipSyncValue !== 0) {
        const readback = setMouthOpen(model, mouthParameterIds, state.lipSyncValue);
        state.lipSyncParameterIds = readback.parameterIds;
        state.lipSyncParameterReadbackVerified = readback.parameterIds.length > 0;
        state.appliedLipSyncValue = readback.value;
        state.peakAppliedLipSyncValue = Math.max(
          state.peakAppliedLipSyncValue,
          state.appliedLipSyncValue,
        );
        if (state.lipSyncValue === 0) state.lipSyncResetPending = false;
      }
    };
    internalModel.on("beforeModelUpdate", updateFrameEffects);
    state.frameEffectsBinding = { internalModel, updateFrameEffects, parameterAccess };
  }

  function uninstallLive2DFrameEffects() {
    const binding = state.frameEffectsBinding;
    if (binding?.parameterAccess) state.actionCueScheduler.restore(binding.parameterAccess);
    binding?.internalModel?.off?.("beforeModelUpdate", binding.updateFrameEffects);
    state.frameEffectsBinding = null;
    state.lipSyncParameterIds = [];
    state.lipSyncParameterReadbackVerified = false;
    state.lipSyncAvailable = false;
    delete dom.stage.dataset.lipSync;
    state.appliedLipSyncValue = 0;
  }

  function getMotionButton(group, index) {
    return [...document.querySelectorAll(".motion-button")].find((button) => (
      button.dataset.group === String(group) && button.dataset.index === String(index)
    )) || null;
  }

  function installModelControls(app, model) {
    function layout() {
      const scale = Math.min(
        app.screen.width / model.internalModel.width,
        app.screen.height / model.internalModel.height,
      ) * 0.72;
      model.anchor.set(0.5, 0.5);
      model.scale.set(scale);
      model.position.set(app.screen.width / 2, app.screen.height * 0.32);
    }

    state.layoutModel = layout;
    layout();
    app.renderer.on("resize", () => {
      if (!state.userAdjusted) layout();
    });

    model.interactive = true;
    model.buttonMode = true;
    let drag = null;
    model.on("pointerdown", (event) => {
      drag = {
        dx: event.data.global.x - model.x,
        dy: event.data.global.y - model.y,
      };
    });
    model.on("pointermove", (event) => {
      if (!drag) return;
      state.userAdjusted = true;
      model.position.set(event.data.global.x - drag.dx, event.data.global.y - drag.dy);
    });
    model.on("pointerup", () => { drag = null; });
    model.on("pointerupoutside", () => { drag = null; });

    const MIN_SCALE = 0.05;
    const MAX_SCALE = 5;
    const zoomAt = (x, y, requestedScale) => {
      const previous = model.scale.x;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, requestedScale));
      const factor = next / previous;
      if (!Number.isFinite(factor) || factor === 1) return;
      state.userAdjusted = true;
      model.scale.set(next);
      model.position.set(x + (model.x - x) * factor, y + (model.y - y) * factor);
    };

    app.view.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = app.view.getBoundingClientRect();
      zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        model.scale.x * Math.exp(-event.deltaY * 0.002),
      );
    }, { passive: false });

    const touches = new Map();
    let pinchDistance = 0;
    app.view.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size > 1) drag = null;
    });
    app.view.addEventListener("pointermove", (event) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size !== 2) return;
      event.preventDefault();
      const [a, b] = [...touches.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0) {
        const rect = app.view.getBoundingClientRect();
        const centerX = (a.x + b.x) / 2 - rect.left;
        const centerY = (a.y + b.y) / 2 - rect.top;
        zoomAt(centerX, centerY, model.scale.x * (distance / pinchDistance));
      }
      pinchDistance = distance;
    }, { passive: false });
    const releaseTouch = (event) => {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinchDistance = 0;
    };
    app.view.addEventListener("pointerup", releaseTouch);
    app.view.addEventListener("pointercancel", releaseTouch);

    dom.resetView.onclick = () => {
      state.userAdjusted = false;
      layout();
      setStatus("视图已重置 · 拖动角色或滚轮缩放");
    };
  }

  function runUiDebugHook(app, model) {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("uitest")) return;
    window.setTimeout(() => {
      const before = { x: model.x, y: model.y, s: model.scale.x };
      const rect = app.view.getBoundingClientRect();
      const cx = rect.left + before.x;
      const cy = rect.top + before.y;
      const makePointer = (type, x, y) => new PointerEvent(type, {
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 1,
        bubbles: true,
      });
      app.view.dispatchEvent(makePointer("pointerdown", cx, cy));
      document.dispatchEvent(makePointer("pointermove", cx + 120, cy + 60));
      document.dispatchEvent(makePointer("pointerup", cx + 120, cy + 60));
      const afterDrag = { x: model.x, y: model.y };
      app.view.dispatchEvent(new WheelEvent("wheel", {
        clientX: cx,
        clientY: cy,
        deltaY: -300,
        bubbles: true,
        cancelable: true,
      }));
      setStatus(
        `uitest drag:(${before.x.toFixed(0)},${before.y.toFixed(0)})->` +
        `(${afterDrag.x.toFixed(0)},${afterDrag.y.toFixed(0)}) ` +
        `zoom:${before.s.toFixed(3)}->${model.scale.x.toFixed(3)}`,
      );
    }, 400);
  }

  async function runMotionDebugHook(model) {
    const params = new URLSearchParams(window.location.search);
    const play = params.get("play");
    if (!play) return;
    const [group, rawIndex] = play.split(":");
    const index = Number(rawIndex || 0);
    const started = await model.motion(group, index, window.PIXI.live2d.MotionPriority.FORCE);
    setStatus(`自动播放 · ${play} · started=${started}`);
    const freeze = Number(params.get("freeze"));
    if (freeze > 0) {
      const manager = model.internalModel.motionManager;
      let finished = false;
      const markFinished = () => { finished = true; };
      manager?.on?.("motionFinish", markFinished);
      window.setTimeout(() => {
        const playing = Boolean(manager?.playing);
        const active = Boolean(started && playing && !finished);
        manager?.off?.("motionFinish", markFinished);
        setStatus(
          `自动播放 · ${play} · sampled@${freeze}s · ` +
          `started=${started} · playing=${playing} · active=${active}`,
        );
      }, freeze * 1000);
    }
  }

  async function initLive2D(options = {}) {
    const autoPlay = options.autoPlay || null;
    interruptActiveChat();
    state.actionCueScheduler.dispose();
    state.actionCueScheduler = createActionCueScheduler();
    state.modelEpoch += 1;
    const modelEpoch = state.modelEpoch;
    setModelState("loading", "模型连接中");
    setStatus("正在读取模型与动作参数…");
    try {
      if (!window.PIXI?.live2d?.Live2DModel) {
        throw new Error("Live2D 渲染依赖加载失败，请检查网络后刷新");
      }
      const modelJson = await resolveModelJson(options.modelRevision);
      const app = new window.PIXI.Application({
        backgroundAlpha: 0,
        preserveDrawingBuffer: true,
        resizeTo: dom.stage,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        antialias: true,
      });
      state.pixiApp = app;
      dom.stage.appendChild(app.view);

      const model = await window.PIXI.live2d.Live2DModel.from(modelJson);
      if (modelEpoch !== state.modelEpoch) {
        model.destroy?.();
        app.destroy(true, { children: true, texture: false, baseTexture: false });
        return { loaded: false, autoPlayed: false };
      }
      state.model = model;
      state.modelReady = true;
      app.stage.addChild(model);
      installModelControls(app, model);
      installLive2DFrameEffects(model);

      const groups = model.internalModel.settings.motions || {};
      buildMotionDeck(groups);
      model.internalModel.motionManager?.on?.("motionFinish", () => {
        clearActiveMotion();
        const speechEmotion = state.activeSpeechEmotion;
        const speechPlaying = state.ttsManager?.getState().state === "playing";
        if (speechEmotion && speechPlaying && !state.speechMotionRestartScheduled) {
          state.speechMotionRestartScheduled = true;
          window.setTimeout(() => {
            state.speechMotionRestartScheduled = false;
            if (
              state.activeSpeechEmotion === speechEmotion
              && state.ttsManager?.getState().state === "playing"
            ) {
              void playEmotion(speechEmotion);
            }
          }, 120);
          return;
        }
        setStatus("角色待机中 · 和她聊聊，看看会触发什么动作");
      });

      hidePlaceholder();
      setModelState("ready", "模型已连接");
      setStatus("角色已就绪 · 拖动角色或点击动作试试");
      runUiDebugHook(app, model);
      let autoPlayed = false;
      if (autoPlay) {
        const button = getMotionButton(autoPlay.group, autoPlay.index);
        autoPlayed = await playMotion(
          autoPlay.group,
          autoPlay.index,
          autoPlay.label,
          button,
        );
      } else {
        await runMotionDebugHook(model);
      }

      if (state.pendingEmotion && !autoPlay) {
        const pending = state.pendingEmotion;
        state.pendingEmotion = null;
        playEmotion(pending);
      }
      return { loaded: true, autoPlayed };
    } catch (error) {
      state.modelReady = false;
      setModelState("error", "模型未连接");
      setStatus("聊天仍可使用 · 导入模型后即可联动动作");
      setPlaceholderError(error.message || "无法读取 Live2D 模型");
      console.error("PromptSoul: Live2D initialization failed.", error);
      return { loaded: false, autoPlayed: false, error };
    }
  }

  async function reloadLive2DForGeneratedMotion(target, modelRevision) {
    setModelState("loading", "正在更新动作");
    setStatus("新动作已生成 · 正在重新载入模型");
    destroyCurrentLive2D();
    showModelPlaceholder("正在载入新动作");
    const result = await initLive2D({
      autoPlay: target,
      modelRevision: modelRevision || Date.now(),
    });
    return Boolean(result.loaded && result.autoPlayed);
  }

  async function deleteGeneratedMotion(motionId, label) {
    if (
      state.workshopBusy
      || state.deletingMotionId
      || !GENERATED_MOTION_ID_PATTERN.test(motionId)
    ) return;

    const revision = getGeneratedMotionRevision(motionId);
    if (!revision) {
      setWorkshopStatus("loading", "正在同步最新动作列表，请稍后再试…");
      await loadMotionCapabilities();
      return;
    }

    const confirmed = window.confirm(
      `确定删除 AI 动作“${label}”吗？\n删除后无法撤销，内置动作和模型原有动作不会受影响。`,
    );
    if (!confirmed) return;

    setMotionDeleteBusy(motionId);
    setWorkshopStatus("loading", `正在删除“${label}”并更新动作列表…`);
    setStatus(`正在删除动作 · ${label}`);
    try {
      const payload = await fetchJsonWithTimeout(
        MOTION_DELETE_ENDPOINT(motionId),
        {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ revision }),
        },
        MOTION_DELETE_TIMEOUT_MS,
      );

      state.generatedMotion = null;
      dom.motionWorkshopResult.hidden = true;
      setModelState("loading", "正在更新动作");
      destroyCurrentLive2D();
      showModelPlaceholder("正在载入最新动作列表");
      const modelResult = await initLive2D({
        modelRevision: payload?.modelRevision || Date.now(),
      });
      const capabilitiesLoaded = await loadMotionCapabilities();
      const message = String(payload?.message || `“${label}”已从动作库删除。`).trim();

      if (modelResult.loaded && capabilitiesLoaded) {
        setWorkshopStatus("success", message);
        setStatus(`动作已删除 · ${label}`);
      } else {
        setWorkshopStatus(
          "error",
          `“${label}”已删除，但页面未能完整刷新，请手动刷新浏览器。`,
          { retry: true },
        );
      }
    } catch (error) {
      if (["model_changed", "motion_not_found"].includes(error.code)) {
        setWorkshopStatus("loading", "动作列表已变化，正在载入最新版本…");
        destroyCurrentLive2D();
        showModelPlaceholder("正在同步最新动作列表");
        await initLive2D({ modelRevision: Date.now() });
        await loadMotionCapabilities();
      }
      setWorkshopStatus(
        "error",
        error.code === "model_changed"
          ? "当前模型或动作列表已经变化，列表已刷新，请确认后重试。"
          : error.message || `“${label}”删除失败，请稍后重试。`,
      );
      setStatus(`动作删除失败 · ${label}`);
      console.error("PromptSoul: motion deletion failed.", error);
    } finally {
      setMotionDeleteBusy(null);
    }
  }

  function reloadPageForGeneratedMotion(target, modelRevision) {
    const url = new URL(window.location.href);
    url.searchParams.set("play", `${target.group}:${target.index}`);
    url.searchParams.set("motionRevision", String(modelRevision || Date.now()));
    url.searchParams.set("generatedMotion", "1");
    url.searchParams.delete("freeze");
    window.location.assign(url.href);
  }

  function formatTime() {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  }

  function scrollChatToEnd() {
    window.requestAnimationFrame(() => {
      dom.chatHistory.scrollTo({ top: dom.chatHistory.scrollHeight, behavior: "smooth" });
    });
  }

  function addMessage(role, content, emotion = null, options = {}) {
    const message = {
      role,
      content: String(content),
      emotion: role === "assistant" ? normalizeEmotion(emotion) : null,
    };
    state.messages.push(message);

    const row = document.createElement("div");
    row.className = `message-row ${role}`;
    if (role === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "message-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = String(state.config.npc.avatar || "PS").slice(0, 2).toUpperCase();
      row.appendChild(avatar);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "message-content";
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = message.content;
    wrapper.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.append(document.createTextNode(options.streaming ? "正在回复" : (options.initial ? "刚刚" : formatTime())));
    if (role === "assistant" && message.emotion && message.emotion !== "neutral") {
      const chip = document.createElement("span");
      chip.className = "emotion-chip";
      chip.textContent = `✦ ${EMOTION_LABELS[message.emotion]}`;
      meta.appendChild(chip);
    }
    wrapper.appendChild(meta);
    row.appendChild(wrapper);
    dom.chatHistory.appendChild(row);
    Object.defineProperties(message, {
      _bubble: { value: bubble },
      _meta: { value: meta },
    });
    scrollChatToEnd();
    return message;
  }

  function updateStreamingAssistantMessage(message, content) {
    if (!message || message.role !== "assistant") return;
    message.content = String(content || "");
    if (message._bubble) message._bubble.textContent = message.content;
    scrollChatToEnd();
  }

  function finalizeStreamingAssistantMessage(message, content, emotion) {
    if (!message) return;
    updateStreamingAssistantMessage(message, content);
    message.emotion = normalizeEmotion(emotion);
    if (!message._meta) return;
    message._meta.replaceChildren(document.createTextNode(formatTime()));
    if (message.emotion !== "neutral") {
      const chip = document.createElement("span");
      chip.className = "emotion-chip";
      chip.textContent = `✦ ${EMOTION_LABELS[message.emotion]}`;
      message._meta.appendChild(chip);
    }
  }

  function setChatBusy(busy) {
    state.chatBusy = busy;
    dom.typingState.hidden = !busy;
    dom.chatHistory.setAttribute("aria-busy", String(busy));
    dom.chatForm.setAttribute("aria-busy", String(busy));
    if (busy) scrollChatToEnd();
  }

  function isCurrentChatRun(run) {
    return Boolean(run && !run.cancelled && state.activeChatRun === run);
  }

  function ensureRunMessage(run) {
    if (!run.streamingMessage) {
      run.streamingMessage = addMessage("assistant", "", "neutral", { streaming: true });
    }
    return run.streamingMessage;
  }

  function interruptActiveChat() {
    const run = state.activeChatRun;
    if (run) {
      run.cancelled = true;
      clearRealtimeRunTimers(run);
      if (run.streamingMessage?.content) {
        finalizeStreamingAssistantMessage(
          run.streamingMessage,
          run.streamingMessage.content,
          run.lastFallback || "neutral",
        );
      }
      if (run.turnId) state.actionCueScheduler.cancelTurn(run.turnId, 200);
      stopActiveLive2DMotion();
    }
    state.chatController?.abort(new DOMException("Chat turn was replaced", "AbortError"));
    state.chatController = null;
    state.activeChatRun = null;
    state.pendingEmotion = null;
    state.ttsPlaybackRevision += 1;
    state.ttsManager?.stop();
    setChatBusy(false);
  }

  function cancelActiveRealtimeCues() {
    const run = state.activeChatRun;
    if (!run?.turnId || run.cancelled) return;
    clearRealtimeRunTimers(run);
    state.actionCueScheduler.cancelTurn(run.turnId, 200);
    run.cuesCancelled = true;
  }

  function buildSuggestions() {
    dom.suggestions.replaceChildren();
    state.config.suggestions.slice(0, 6).forEach((copy) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion-chip";
      button.textContent = copy;
      button.addEventListener("click", () => sendChatMessage(copy));
      dom.suggestions.appendChild(button);
    });
  }

  function resizeComposer() {
    dom.chatInput.style.height = "auto";
    dom.chatInput.style.height = `${Math.min(dom.chatInput.scrollHeight, 110)}px`;
  }

  function deterministicDemoReply(input) {
    const text = input.toLowerCase();
    let emotion;
    let reply;

    if (/你是谁|叫什么|介绍|身份/.test(text)) {
      emotion = "nod";
      reply = `我是${state.config.npc.name}，${state.config.npc.role}。现在的我会把聊天里的情绪，变成 Live2D 动作。`;
    } else if (/会什么|哪些动作|能做什么|功能/.test(text)) {
      emotion = "happy";
      reply = "我会开心、眨眼、点头、思考、惊讶、害羞和摇头。它们都来自模型已有的参数，不会偷偷假装自己有新的绑定。";
    } else if (/惊喜|吓|意外|surprise/.test(text)) {
      emotion = "surprised";
    } else if (/害羞|可爱|喜欢你|漂亮|夸|表白/.test(text)) {
      emotion = "shy";
    } else if (/眨眼|暗号|wink/.test(text)) {
      emotion = "wink";
    } else if (/不要|拒绝|不行|讨厌|摇头|否定/.test(text)) {
      emotion = "shakehead";
    } else if (/对不对|是不是|同意|可以吗|点头|没错/.test(text)) {
      emotion = "nod";
    } else if (/为什么|怎么|想想|思考|秘密|原理/.test(text)) {
      emotion = "thinking";
    } else if (/你好|嗨|hello|开心|高兴|笑一个/.test(text)) {
      emotion = "happy";
    } else {
      const choices = ["thinking", "happy", "wink", "nod", "shy", "surprised", "shakehead"];
      const hash = [...text].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, 7);
      emotion = choices[hash % choices.length];
    }
    return {
      reply: reply || state.config.demoReplies[emotion] || state.config.demoReplies.neutral,
      emotion,
      source: "demo",
    };
  }

  function parseApiReply(data) {
    const candidate = data?.reply ?? data?.message ?? data?.content ?? data?.choices?.[0]?.message?.content;
    const reply = typeof candidate === "object" ? candidate.content : candidate;
    if (typeof reply !== "string" || !reply.trim()) {
      throw new Error("API response is missing a reply");
    }
    const apiMode = String(data?.mode || "").toLowerCase();
    return {
      reply: reply.trim(),
      emotion: normalizeEmotion(data?.emotion ?? data?.mood ?? candidate?.emotion),
      source: apiMode === "demo" ? "demo" : "api",
      mode: apiMode || "provider",
      turnId: typeof data?.turnId === "string" ? data.turnId : null,
      modelRevision: typeof data?.modelRevision === "string" ? data.modelRevision : null,
      partial: data?.partial === true,
    };
  }

  async function readStreamingChatResponse(response, callbacks = {}) {
    if (!response.body?.getReader) throw new Error("Streaming chat response has no readable body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let accumulated = "";
    let finalResult = null;
    let started = false;
    let streamKind = "legacy";
    let streamTurnId = null;
    let expectedSegmentSeq = 0;
    let lastFallback = "neutral";

    const start = (event) => {
      if (started) return;
      started = true;
      callbacks.onStart?.(event);
    };

    const requireMatchingTurn = (event) => {
      if (
        !streamTurnId
        || typeof event?.turnId !== "string"
        || event.turnId !== streamTurnId
      ) {
        throw new Error("Chat stream turn identity changed unexpectedly");
      }
    };

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        throw new Error("Chat stream returned invalid NDJSON");
      }
      if (finalResult) throw new Error("Chat stream continued after its terminal event");
      if (event?.type === "start") {
        if (started || typeof event.turnId !== "string" || !event.turnId.trim()) {
          throw new Error("Chat stream returned an invalid start event");
        }
        streamKind = "realtime";
        streamTurnId = event.turnId;
        callbacks.onActivity?.();
        start(event);
        return;
      }
      if (event?.type === "segment") {
        if (streamKind !== "realtime") {
          throw new Error("Chat stream returned a segment before start");
        }
        requireMatchingTurn(event);
        if (
          !Number.isSafeInteger(event.seq)
          || event.seq !== expectedSegmentSeq
          || typeof event.text !== "string"
          || !Array.isArray(event.cues)
        ) {
          throw new Error("Chat stream returned an invalid segment event");
        }
        expectedSegmentSeq += 1;
        accumulated += event.text;
        lastFallback = normalizeEmotion(event.fallback);
        callbacks.onActivity?.();
        callbacks.onSegment?.(event, accumulated);
        return;
      }
      if (event?.type === "delta") {
        if (streamKind === "realtime") {
          throw new Error("Chat stream mixed realtime segments with legacy deltas");
        }
        start({ type: "legacy" });
        const delta = typeof event.text === "string" ? event.text : "";
        callbacks.onActivity?.();
        if (!delta) return;
        accumulated += delta;
        callbacks.onDelta?.(delta, accumulated);
        return;
      }
      if (event?.type === "done") {
        if (streamKind === "realtime") requireMatchingTurn(event);
        else start({ type: "legacy" });
        callbacks.onActivity?.();
        finalResult = parseApiReply({
          ...event,
          reply: typeof event.reply === "string" && event.reply.trim() ? event.reply : accumulated,
        });
        callbacks.onDone?.(finalResult, accumulated);
        return;
      }
      if (event?.type === "error") {
        if (streamKind === "realtime") requireMatchingTurn(event);
        callbacks.onActivity?.();
        if (event?.partial === true && accumulated.trim()) {
          callbacks.onPartialError?.(event, accumulated);
          finalResult = parseApiReply({
            reply: accumulated,
            emotion: lastFallback,
            mode: "dsh-realtime",
            turnId: streamTurnId,
            partial: true,
          });
          return;
        }
        throw new Error(String(event?.error?.message || "Chat stream failed"));
      }
      throw new Error("Chat stream returned an unknown event type");
    };

    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() || "";
      lines.forEach(consumeLine);
      if (done) break;
    }
    if (pending.trim()) consumeLine(pending);
    if (!finalResult) throw new Error("Chat stream ended without a done event");
    return finalResult;
  }

  async function requestChatReply(message, callbacks = {}, controller = new AbortController()) {
    const idleTimeoutMs = Number(state.config.requestTimeoutMs) || 45000;
    let idleTimer = null;
    const resetIdleTimeout = () => {
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(
        () => controller.abort(new DOMException("Chat request timed out", "TimeoutError")),
        idleTimeoutMs,
      );
    };
    resetIdleTimeout();
    const priorMessages = state.messages.at(-1)?.role === "user"
      ? state.messages.slice(0, -1)
      : state.messages;
    const history = priorMessages
      .slice(-12)
      .map(({ role, content }) => ({ role, content }));
    try {
      const response = await fetch(state.config.apiEndpoint || "/api/chat", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson, application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          history,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Chat API returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() || "";
      if (contentType.includes("application/x-ndjson")) {
        return await readStreamingChatResponse(response, {
          ...callbacks,
          onActivity: resetIdleTimeout,
        });
      }
      return parseApiReply(await response.json());
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason || error;
      if (callbacks.onError?.(error) === true) throw error;
      console.info("PromptSoul: chat API unavailable, switched to deterministic demo mode.", error);
      return deterministicDemoReply(message);
    } finally {
      if (idleTimer !== null) window.clearTimeout(idleTimer);
    }
  }

  function updateTtsDiagnostics(snapshot) {
    const status = state.ttsStatus || {};
    const diagnostics = {
      ...snapshot,
      mouthOpen: state.appliedLipSyncValue,
      peakMouthOpen: state.peakAppliedLipSyncValue,
      lipSyncParameterIds: [...state.lipSyncParameterIds],
      lipSyncAvailable: state.lipSyncAvailable,
      mouthEvidence: state.lipSyncParameterReadbackVerified ? "parameter_readback" : "none",
      artMeshDeformationVerified: false,
      engineReady: Boolean(status.engineReachable),
      voiceResolved: Boolean(status.voiceResolved),
      speakerName: typeof status.speakerName === "string" ? status.speakerName : null,
      styleName: typeof status.styleName === "string" ? status.styleName : null,
      styleId: Number.isInteger(status.styleId) ? status.styleId : null,
    };
    window.__AITUBER_DIAGNOSTICS__ ||= {};
    window.__AITUBER_DIAGNOSTICS__.tts = diagnostics;
    const roots = [document.documentElement, dom.stage].filter(Boolean);
    roots.forEach((root) => {
      root.dataset.ttsState = diagnostics.state;
      root.dataset.audioPlaying = String(
        diagnostics.state === "playing"
        && diagnostics.audioContextState === "running"
        && diagnostics.currentTime > 0
      );
      root.dataset.mouthActive = String(diagnostics.mouthOpen > 0.02);
    });
    window.dispatchEvent(new CustomEvent("promptsoul:tts-state", { detail: diagnostics }));
  }

  function handleRealtimeCueSegmentEnded(event) {
    const run = state.activeChatRun;
    if (
      !isCurrentChatRun(run)
      || run.turnId !== event.turnId
      || run.modelEpoch !== event.modelEpoch
      || !run.boundCueSegments.has(event.segmentSeq)
      || event.writeCount !== 0
    ) return;
    markRealtimeSegmentFallback(run, event.segmentSeq);
    publishRealtimeDiagnostics({
      noopSegments: state.realtimeDiagnostics.noopSegments + 1,
    });
    window.setTimeout(() => {
      void playRealtimeSegmentFallback(run, event.segmentSeq);
    }, 0);
  }

  function publishRealtimeDiagnostics(update = {}) {
    Object.assign(state.realtimeDiagnostics, update);
    const snapshot = { ...state.realtimeDiagnostics };
    window.__AITUBER_DIAGNOSTICS__ ||= {};
    window.__AITUBER_DIAGNOSTICS__.realtime = snapshot;
    const roots = [document.documentElement, dom.stage].filter(Boolean);
    roots.forEach((root) => {
      root.dataset.realtimeClock = snapshot.clockMode ?? "none";
      root.dataset.realtimeSegments = String(snapshot.segmentsReceived);
      root.dataset.realtimeAccepted = String(snapshot.cueSegmentsAccepted);
      root.dataset.realtimeBound = String(snapshot.cueSegmentsBound);
      root.dataset.realtimeFallback = String(snapshot.cueSegmentsFallback);
      root.dataset.realtimeFrameWrites = String(snapshot.frameWrites);
      root.dataset.realtimeParameterWrites = String(snapshot.parameterWrites);
      root.dataset.realtimePartOpacityWrites = String(snapshot.partOpacityWrites);
      root.dataset.realtimePartOpacityIds = snapshot.partOpacityIds.join(",");
      root.dataset.realtimeNoop = String(snapshot.noopSegments);
      root.dataset.realtimeLastParameters = snapshot.lastCueParameterIds.join(",");
    });
    window.dispatchEvent(new CustomEvent("promptsoul:realtime-state", { detail: snapshot }));
  }

  function resetRealtimeDiagnostics() {
    state.realtimeDriftSamples = [];
    state.realtimeDiagnostics = {
      ttfcMs: null,
      invalidCues: 0,
      bufferUnderruns: 0,
      syncDriftMs: null,
      syncDriftP95Ms: null,
      segmentsReceived: 0,
      cueSegmentsAccepted: 0,
      cueSegmentsBound: 0,
      cueSegmentsFallback: 0,
      bindFailures: 0,
      cueApplications: 0,
      frameWrites: 0,
      parameterWrites: 0,
      partOpacityWrites: 0,
      partOpacityIds: [],
      noopSegments: 0,
      clockMode: null,
      lastCueClockMode: null,
      lastCueParameterIds: [],
    };
    publishRealtimeDiagnostics();
  }

  function recordRealtimeSyncDrift(value) {
    if (!Number.isFinite(value) || value < 0) return;
    state.realtimeDriftSamples.push(value);
    if (state.realtimeDriftSamples.length > 256) state.realtimeDriftSamples.shift();
    const ordered = [...state.realtimeDriftSamples].sort((left, right) => left - right);
    const percentileIndex = Math.max(0, Math.ceil(ordered.length * 0.95) - 1);
    publishRealtimeDiagnostics({
      syncDriftMs: value,
      syncDriftP95Ms: ordered[percentileIndex],
    });
  }

  function asRealtimeTtsTag(tag) {
    if (
      !tag
      || typeof tag.turnId !== "string"
      || !Number.isSafeInteger(tag.segmentSeq)
      || tag.segmentSeq < 0
    ) return null;
    return tag;
  }

  function activeRunForTag(rawTag) {
    const tag = asRealtimeTtsTag(rawTag);
    const run = state.activeChatRun;
    if (
      !tag
      || !run
      || run.cancelled
      || run.turnId !== tag.turnId
      || run.modelEpoch !== state.modelEpoch
    ) return null;
    return { run, tag };
  }

  function clearRealtimeRunTimers(run, keepFallbackSeq = null) {
    for (const [seq, timer] of run?.performanceFallbackTimers || []) {
      if (seq === keepFallbackSeq) continue;
      window.clearTimeout(timer);
      run.performanceFallbackTimers.delete(seq);
    }
    if (run?.performanceCancelTimer !== null) {
      window.clearTimeout(run.performanceCancelTimer);
      run.performanceCancelTimer = null;
    }
  }

  function publishRealtimeCueState(run, update = {}) {
    publishRealtimeDiagnostics({
      clockMode: run?.clockMode ?? null,
      segmentsReceived: run?.resolvedSegments?.size ?? 0,
      cueSegmentsAccepted: run?.acceptedCueSegments?.size ?? 0,
      cueSegmentsBound: run?.boundCueSegments?.size ?? 0,
      cueSegmentsFallback: run?.fallbackSegments?.size ?? 0,
      ...update,
    });
  }

  function markRealtimeSegmentFallback(run, segmentSeq, bindFailure = false) {
    run.acceptedCueSegments.delete(segmentSeq);
    run.boundCueSegments.delete(segmentSeq);
    run.fallbackSegments.add(segmentSeq);
    publishRealtimeCueState(run, bindFailure ? {
      bindFailures: state.realtimeDiagnostics.bindFailures + 1,
    } : {});
  }

  function canPlayRealtimeSegmentFallback(run, segmentSeq) {
    return Boolean(
      isCurrentChatRun(run)
      && run.modelEpoch === state.modelEpoch
      && !run.cuesCancelled
      && !run.fallbackPlayed.has(segmentSeq)
      && run.fallbackSegments.has(segmentSeq)
      && run.segmentFallbacks.has(segmentSeq)
    );
  }

  function playRealtimeSegmentFallback(run, segmentSeq) {
    if (
      !canPlayRealtimeSegmentFallback(run, segmentSeq)
      || run.fallbackInFlight.has(segmentSeq)
    ) return Promise.resolve(false);
    const emotion = run.segmentFallbacks.get(segmentSeq);
    if (!emotion) return Promise.resolve(false);
    return playFallbackWithRetry(
      segmentSeq,
      {
        inFlight: run.fallbackInFlight,
        played: run.fallbackPlayed,
      },
      {
        canAttempt: () => canPlayRealtimeSegmentFallback(run, segmentSeq),
        play: () => playEmotion(emotion),
      },
    );
  }

  function schedulePerformanceFallback(run, segmentSeq, startAt) {
    const existing = run.performanceFallbackTimers.get(segmentSeq);
    if (existing !== undefined) window.clearTimeout(existing);
    run.performanceFallbackTimers.delete(segmentSeq);
    if (
      !run.fallbackSegments.has(segmentSeq)
      || run.fallbackPlayed.has(segmentSeq)
    ) return;
    const delayMs = Math.max(0, (startAt - (performance.now() / 1_000)) * 1_000);
    const timer = window.setTimeout(() => {
      run.performanceFallbackTimers.delete(segmentSeq);
      void playRealtimeSegmentFallback(run, segmentSeq);
    }, delayMs);
    run.performanceFallbackTimers.set(segmentSeq, timer);
  }

  function handleRealtimeSegmentScheduled(event) {
    const active = activeRunForTag(event.tag);
    if (!active || active.run.clockMode !== "audio") return;
    const { run, tag } = active;
    if (run.acceptedCueSegments.has(tag.segmentSeq)) {
      const bound = state.actionCueScheduler.bindAudio(
        tag.segmentSeq,
        event.startAt,
        event.duration,
        tag.turnId,
      );
      if (!bound) markRealtimeSegmentFallback(run, tag.segmentSeq, true);
      else run.boundCueSegments.add(tag.segmentSeq);
    }
    publishRealtimeCueState(run);
    if (
      Number.isFinite(run.lastScheduledAudioEnd)
      && event.startAt - run.lastScheduledAudioEnd > 0.1
    ) {
      publishRealtimeDiagnostics({
        bufferUnderruns: state.realtimeDiagnostics.bufferUnderruns + 1,
      });
    }
    run.lastScheduledAudioEnd = event.startAt + event.duration;
    run.scheduledSegments.add(tag.segmentSeq);
    run.currentScheduledAudioSeq = tag.segmentSeq;
  }

  function handleRealtimeSegmentStarted(event) {
    const active = activeRunForTag(event.tag);
    if (!active || active.run.clockMode !== "audio") return;
    const { run, tag } = active;
    run.startedSegments.add(tag.segmentSeq);
    run.currentAudioSeq = tag.segmentSeq;
    void playRealtimeSegmentFallback(run, tag.segmentSeq);
  }

  function handleRealtimeSegmentEnded(event) {
    const active = activeRunForTag(event.tag);
    if (!active) return;
    const { run, tag } = active;
    run.audioPending.delete(tag.segmentSeq);
    if (run.currentAudioSeq === tag.segmentSeq) run.currentAudioSeq = null;
    if (run.currentScheduledAudioSeq === tag.segmentSeq) {
      run.currentScheduledAudioSeq = null;
    }
    if (run.cancelAfterCurrent && !run.audioPending.size) {
      run.cancelAfterCurrent = false;
      run.performanceSwitchPending = false;
      state.actionCueScheduler.cancelTurn(run.turnId, 200);
      return;
    }
    if (run.performanceSwitchPending && !run.audioPending.size) {
      run.performanceSwitchPending = false;
      switchRealtimeRunToPerformance(run);
    }
  }

  function handleRealtimeSegmentCancelled(event) {
    const active = activeRunForTag(event.tag);
    if (!active) return;
    const { run, tag } = active;
    run.audioPending.delete(tag.segmentSeq);
    if (run.currentAudioSeq === tag.segmentSeq) run.currentAudioSeq = null;
    if (run.currentScheduledAudioSeq === tag.segmentSeq) {
      run.currentScheduledAudioSeq = null;
    }
    if (!run.partial) {
      publishRealtimeDiagnostics({
        bufferUnderruns: state.realtimeDiagnostics.bufferUnderruns + 1,
      });
    }
    if (
      !run.partial
      && !run.cuesCancelled
      && run.streamTtsEnabled
      && run.clockMode === "audio"
    ) {
      requestRealtimePerformanceSwitch(run);
    }
    if (run.cancelAfterCurrent && !run.audioPending.size) {
      run.cancelAfterCurrent = false;
      run.performanceSwitchPending = false;
      state.actionCueScheduler.cancelTurn(run.turnId, 200);
      return;
    }
    if (run.performanceSwitchPending && !run.audioPending.size) {
      run.performanceSwitchPending = false;
      switchRealtimeRunToPerformance(run);
    }
  }

  function bindRealtimeSegmentWithoutTts(run, segment) {
    if (run.clockMode !== "performance") return false;
    const existing = run.performanceAnchors.get(segment.seq);
    if (existing) return existing.bound;
    const now = performance.now() / 1_000;
    if (
      Number.isFinite(run.fallbackNextStartAt)
      && run.fallbackNextStartAt > 0
      && now > run.fallbackNextStartAt + 0.1
    ) {
      publishRealtimeDiagnostics({
        bufferUnderruns: state.realtimeDiagnostics.bufferUnderruns + 1,
      });
    }
    const startAt = Math.max(now, run.fallbackNextStartAt || now);
    run.fallbackNextStartAt = startAt + REALTIME_FALLBACK_SEGMENT_SECONDS;
    const shouldBind = run.acceptedCueSegments.has(segment.seq);
    const bound = shouldBind && state.actionCueScheduler.bindAudio(
      segment.seq,
      startAt,
      REALTIME_FALLBACK_SEGMENT_SECONDS,
      run.turnId,
    );
    run.performanceAnchors.set(segment.seq, {
      startAt,
      duration: REALTIME_FALLBACK_SEGMENT_SECONDS,
      bound,
    });
    if (bound) {
      run.boundCueSegments.add(segment.seq);
      publishRealtimeCueState(run);
    } else if (shouldBind) {
      markRealtimeSegmentFallback(run, segment.seq, true);
    }
    schedulePerformanceFallback(run, segment.seq, startAt);
    return bound;
  }

  function switchRealtimeRunToPerformance(run) {
    if (
      !isCurrentChatRun(run)
      || !run.turnId
      || run.cuesCancelled
      || run.clockMode === "performance"
    ) return;
    run.performanceSwitchPending = false;
    run.streamTtsEnabled = false;
    run.clockMode = "performance";
    state.realtimeClockMode = "performance";
    run.fallbackNextStartAt = null;
    clearRealtimeRunTimers(run);
    run.performanceAnchors.clear();
    run.acceptedCueSegments.clear();
    run.boundCueSegments.clear();
    const pendingSegments = [...run.resolvedSegments.values()]
      .filter((segment) => !run.startedSegments.has(segment.seq))
      .sort((left, right) => left.seq - right.seq);
    state.actionCueScheduler.beginTurn(run.turnId, run.modelEpoch, "performance");
    for (const segment of pendingSegments) {
      const accepted = segment.cues.length > 0
        && state.actionCueScheduler.enqueueSegment(segment);
      if (accepted) run.acceptedCueSegments.add(segment.seq);
      else markRealtimeSegmentFallback(run, segment.seq);
      bindRealtimeSegmentWithoutTts(run, segment);
    }
    state.ttsManager?.cancelPending();
  }

  function requestRealtimePerformanceSwitch(run) {
    if (
      !isCurrentChatRun(run)
      || !run.turnId
      || run.cuesCancelled
      || run.clockMode === "performance"
    ) return;
    run.streamTtsEnabled = false;
    if (!run.performanceSwitchPending) {
      run.performanceSwitchPending = true;
      state.ttsManager?.cancelPending();
    }
    if (run.audioPending.size) return;
    run.performanceSwitchPending = false;
    switchRealtimeRunToPerformance(run);
  }

  function preserveCurrentPerformanceSegment(run) {
    const now = performance.now() / 1_000;
    const current = [...run.performanceAnchors.entries()]
      .sort((left, right) => left[1].startAt - right[1].startAt)
      .find(([, anchor]) => (
        anchor.startAt <= now && now < anchor.startAt + anchor.duration
      ));
    const currentSeq = current?.[0] ?? null;
    clearRealtimeRunTimers(run, currentSeq);
    for (const seq of [...run.performanceAnchors.keys()]) {
      if (seq !== currentSeq) run.performanceAnchors.delete(seq);
    }
    state.actionCueScheduler.beginTurn(run.turnId, run.modelEpoch, "performance");
    run.acceptedCueSegments.clear();
    run.boundCueSegments.clear();
    if (!current) {
      run.cuesCancelled = true;
      state.actionCueScheduler.cancelTurn(run.turnId, 200);
      return;
    }

    const [segmentSeq, anchor] = current;
    const segment = run.resolvedSegments.get(segmentSeq);
    if (segment) {
      const accepted = segment.cues.length > 0
        && state.actionCueScheduler.enqueueSegment(segment);
      if (accepted) {
        run.acceptedCueSegments.add(segmentSeq);
        const bound = state.actionCueScheduler.bindAudio(
          segmentSeq,
          anchor.startAt,
          anchor.duration,
          run.turnId,
        );
        if (bound) run.boundCueSegments.add(segmentSeq);
        else markRealtimeSegmentFallback(run, segmentSeq, true);
      } else {
        markRealtimeSegmentFallback(run, segmentSeq);
      }
      publishRealtimeCueState(run);
      schedulePerformanceFallback(run, segmentSeq, anchor.startAt);
    }
    const remainingMs = Math.max(0, ((anchor.startAt + anchor.duration) - now) * 1_000);
    run.performanceCancelTimer = window.setTimeout(() => {
      run.performanceCancelTimer = null;
      if (!isCurrentChatRun(run)) return;
      run.cuesCancelled = true;
      state.actionCueScheduler.cancelTurn(run.turnId, 200);
    }, remainingMs);
  }

  function setTtsMouthOpen(value) {
    state.lipSyncValue = Math.min(1, Math.max(0, Number(value) || 0));
    state.lipSyncResetPending = state.lipSyncValue > 0 || state.lipSyncResetPending;
  }

  function resetTtsMouthState() {
    state.lipSyncValue = 0;
    state.lipSyncResetPending = false;
    state.peakAppliedLipSyncValue = 0;
    if (state.model) {
      const readback = setMouthOpen(
        state.model,
        resolveMouthParameterIds(state.model),
        0,
      );
      state.lipSyncParameterIds = readback.parameterIds;
      state.lipSyncParameterReadbackVerified = readback.parameterIds.length > 0;
      state.appliedLipSyncValue = readback.value;
    } else {
      state.appliedLipSyncValue = 0;
      state.lipSyncParameterIds = [];
      state.lipSyncParameterReadbackVerified = false;
    }
  }

  function setTtsSpeaking(speaking) {
    dom.stage.dataset.speaking = String(Boolean(speaking));
    if (speaking) {
      state.peakAppliedLipSyncValue = 0;
      setStatus(
        state.lipSyncAvailable
          ? "角色正在说话 · 语音实时驱动口型"
          : "角色正在说话 · 当前模型没有可驱动口型，动作继续播放",
      );
      const pendingEmotion = state.pendingSpeechEmotion || state.activeSpeechEmotion;
      state.pendingSpeechEmotion = null;
      if (pendingEmotion) void restartEmotionForSpeech(pendingEmotion);
    } else if (state.modelReady) {
      state.pendingSpeechEmotion = null;
      state.activeSpeechEmotion = null;
      state.speechMotionRestartScheduled = false;
      setStatus("角色待机中 · 和她聊聊，看看会触发什么动作");
    }
  }

  function playReplyEmotionWithSpeech(emotion) {
    const normalized = normalizeEmotion(emotion);
    const speechEmotion = normalized !== "neutral" && state.emotionMotions.has(normalized)
      ? normalized
      : ["nod", "happy", "wink"].find((candidate) => state.emotionMotions.has(candidate)) || normalized;
    const speechAlreadyPlaying = createTtsManager().getState().state === "playing";
    state.activeSpeechEmotion = speechEmotion === "neutral" ? null : speechEmotion;
    state.pendingSpeechEmotion = state.ttsEnabled && !speechAlreadyPlaying ? speechEmotion : null;
    return playEmotion(speechEmotion);
  }

  function createTtsManager() {
    if (state.ttsManager) return state.ttsManager;
    state.ttsManager = new TtsPlaybackManager({
      endpoint: TTS_SYNTHESIS_ENDPOINT,
      onSnapshot: updateTtsDiagnostics,
      onMouthOpen: setTtsMouthOpen,
      onSpeakingChange: setTtsSpeaking,
      onSegmentScheduled: handleRealtimeSegmentScheduled,
      onSegmentStarted: handleRealtimeSegmentStarted,
      onSegmentEnded: handleRealtimeSegmentEnded,
      onSegmentCancelled: handleRealtimeSegmentCancelled,
    });
    return state.ttsManager;
  }

  function handleTtsUnavailable() {
    state.ttsPlaybackRevision += 1;
    const run = state.activeChatRun;
    if (
      isCurrentChatRun(run)
      && run.realtime
      && !run.cuesCancelled
      && run.clockMode === "audio"
    ) {
      requestRealtimePerformanceSwitch(run);
    }
    state.ttsManager?.stop();
  }

  async function refreshTtsStatus() {
    const revision = ++state.ttsStatusRevision;
    try {
      const response = await fetch(TTS_STATUS_ENDPOINT, { cache: "no-store" });
      if (!response.ok) throw new Error(`TTS status returned HTTP ${response.status}`);
      const status = await response.json();
      if (revision !== state.ttsStatusRevision) return state.ttsStatus || status;
      state.ttsStatus = status;
      state.ttsEnabled = status?.provider === "aivis" && status?.ready === true;
      if (!state.ttsEnabled) handleTtsUnavailable();
      updateTtsDiagnostics(createTtsManager().getState());
      return status;
    } catch (error) {
      if (revision !== state.ttsStatusRevision) return state.ttsStatus;
      state.ttsEnabled = false;
      state.ttsStatus = {
        provider: "aivis",
        ready: false,
        engineReachable: false,
        voiceResolved: false,
      };
      handleTtsUnavailable();
      updateTtsDiagnostics(createTtsManager().getState());
      console.info("PromptSoul: local AivisSpeech is unavailable; text chat remains active.", error);
      return state.ttsStatus;
    }
  }

  function speakCompletedReply(text, expectedRevision = null) {
    if (
      !state.ttsEnabled
      || (expectedRevision !== null && expectedRevision !== state.ttsPlaybackRevision)
    ) return [];
    const manager = createTtsManager();
    manager.clearStreamingText();
    manager.appendStreamingText(text);
    return manager.flushStreamingText();
  }

  function initTts() {
    const manager = createTtsManager();
    window.PromptSoulTTS = Object.freeze({
      enqueue: (text, options, tag) => manager.enqueue(text, options, tag),
      appendStreamingText: (chunk, options) => manager.appendStreamingText(chunk, options),
      flushStreamingText: (options) => manager.flushStreamingText(options),
      clearStreamingText: () => manager.clearStreamingText(),
      play: (text, options) => {
        state.ttsPlaybackRevision += 1;
        cancelActiveRealtimeCues();
        manager.stop();
        manager.appendStreamingText(text, options);
        return manager.flushStreamingText(options);
      },
      stop: () => {
        state.ttsPlaybackRevision += 1;
        cancelActiveRealtimeCues();
        manager.stop();
      },
      clear: () => {
        state.ttsPlaybackRevision += 1;
        cancelActiveRealtimeCues();
        manager.clear();
      },
      pause: () => manager.pause(),
      resume: () => manager.resume(),
      unlock: () => manager.unlock(),
      getState: () => manager.getState(),
      getAudioContextTime: () => manager.getAudioContextTime(),
      cancelPending: () => manager.cancelPending(),
      refreshStatus: () => refreshTtsStatus(),
      startAudioCapture: () => manager.startAudioCapture(),
      stopAudioCapture: () => manager.stopAudioCapture(),
    });
    const handleVoiceChanged = (event) => {
      const enabled = Boolean(event?.detail?.enabled);
      if (!enabled) {
        state.ttsPlaybackRevision += 1;
        cancelActiveRealtimeCues();
        manager.stop();
      }
      refreshTtsStatus();
    };
    const handleStatusRefresh = () => { void refreshTtsStatus(); };
    const handlePreview = async (event) => {
      const text = String(event?.detail?.text || "").trim();
      if (!text) return;
      const revision = ++state.ttsPlaybackRevision;
      cancelActiveRealtimeCues();
      manager.stop();
      const requestOptions = {
        ...(event?.detail?.voice ? { voice: event.detail.voice } : {}),
        ...(event?.detail?.options ? { options: event.detail.options } : {}),
      };
      const unlocked = await manager.unlock();
      if (!unlocked || revision !== state.ttsPlaybackRevision) return;
      manager.appendStreamingText(text, requestOptions);
      manager.flushStreamingText(requestOptions);
    };
    const handleStop = () => {
      state.ttsPlaybackRevision += 1;
      cancelActiveRealtimeCues();
      manager.stop();
    };
    const removeTtsListeners = () => {
      window.removeEventListener("promptsoul:voice-changed", handleVoiceChanged);
      window.removeEventListener("promptsoul:tts-status-refresh", handleStatusRefresh);
      window.removeEventListener("promptsoul:tts-preview", handlePreview);
      window.removeEventListener("promptsoul:tts-stop", handleStop);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
    };
    const handlePageHide = (event) => {
      interruptActiveChat();
      manager.stop();
      resetTtsMouthState();
      updateTtsDiagnostics(manager.getState());
      if (event?.persisted) return;
      state.actionCueScheduler.dispose();
      removeTtsListeners();
      if (state.ttsManager === manager) state.ttsManager = null;
      if (window.PromptSoulTTS) delete window.PromptSoulTTS;
      void manager.destroy().catch((error) => {
        console.info("PromptSoul: TTS cleanup could not close every audio resource.", error);
      });
    };
    const handlePageShow = (event) => {
      if (event?.persisted) void refreshTtsStatus();
    };
    window.addEventListener("promptsoul:voice-changed", handleVoiceChanged);
    window.addEventListener("promptsoul:tts-status-refresh", handleStatusRefresh);
    window.addEventListener("promptsoul:tts-preview", handlePreview);
    window.addEventListener("promptsoul:tts-stop", handleStop);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    refreshTtsStatus();
  }

  async function sendChatMessage(rawMessage) {
    const message = String(rawMessage || "").trim();
    if (!message) return;

    interruptActiveChat();
    addMessage("user", message);
    dom.chatInput.value = "";
    resizeComposer();
    setChatBusy(true);

    const tts = createTtsManager();
    const chatTtsRevision = ++state.ttsPlaybackRevision;
    state.pendingSpeechEmotion = null;
    state.activeSpeechEmotion = null;
    state.speechMotionRestartScheduled = false;
    tts.stop();
    const streamTtsEnabled = state.ttsEnabled
      && document.body.dataset.recordingSmoothTts !== "true";
    if (streamTtsEnabled) void tts.unlock();

    const controller = new AbortController();
    const run = {
      revision: ++state.chatRevision,
      controller,
      requestStartedAt: performance.now(),
      modelEpoch: state.modelEpoch,
      turnId: null,
      realtime: false,
      clockMode: streamTtsEnabled ? "audio" : "performance",
      streamTtsEnabled,
      streamingMessage: null,
      accumulated: "",
      lastFallback: "neutral",
      cancelled: false,
      completed: false,
      partial: false,
      cuesCancelled: false,
      cancelAfterCurrent: false,
      currentAudioSeq: null,
      currentScheduledAudioSeq: null,
      performanceSwitchPending: false,
      fallbackNextStartAt: null,
      lastScheduledAudioEnd: null,
      scheduledSegments: new Set(),
      startedSegments: new Set(),
      audioPending: new Set(),
      resolvedSegments: new Map(),
      acceptedCueSegments: new Set(),
      boundCueSegments: new Set(),
      segmentFallbacks: new Map(),
      fallbackSegments: new Set(),
      fallbackInFlight: new Set(),
      fallbackPlayed: new Set(),
      performanceAnchors: new Map(),
      performanceFallbackTimers: new Map(),
      performanceCancelTimer: null,
    };
    state.chatController = controller;
    state.activeChatRun = run;
    resetRealtimeDiagnostics();

    const minimumTyping = new Promise((resolve) => window.setTimeout(resolve, 680));
    let streamedToTts = false;
    let streamedTtsText = "";
    let streamCompleted = false;

    const preservePartialRealtimeReply = (event, accumulated) => {
      if (!isCurrentChatRun(run)) return;
      if (event?.partial === true || accumulated) {
        run.partial = true;
        run.accumulated = accumulated || run.accumulated;
        tts.cancelPending();
        if (run.clockMode === "performance") {
          preserveCurrentPerformanceSegment(run);
        } else if (run.audioPending.size) run.cancelAfterCurrent = true;
        else if (run.turnId) state.actionCueScheduler.cancelTurn(run.turnId, 200);
      }
    };

    try {
      const [result] = await Promise.all([
        requestChatReply(message, {
          onStart: (event) => {
            if (!isCurrentChatRun(run) || event?.type !== "start") return;
            run.realtime = true;
            run.turnId = event.turnId;
            run.modelEpoch = state.modelEpoch;
            if (
              !state.ttsEnabled
              || chatTtsRevision !== state.ttsPlaybackRevision
            ) {
              run.streamTtsEnabled = false;
              run.clockMode = "performance";
            }
            if (!state.actionCueScheduler.beginTurn(
              run.turnId,
              run.modelEpoch,
              run.clockMode,
            )) {
              throw new Error("Realtime action turn could not be started");
            }
            state.realtimeClockMode = run.clockMode;
            publishRealtimeCueState(run);
          },
          onDelta: (delta, accumulated) => {
            if (!isCurrentChatRun(run)) return;
            run.accumulated = accumulated;
            updateStreamingAssistantMessage(ensureRunMessage(run), accumulated);
            dom.typingState.hidden = true;
            if (
              streamTtsEnabled
              && state.ttsEnabled
              && chatTtsRevision === state.ttsPlaybackRevision
            ) {
              tts.appendStreamingText(delta);
              streamedToTts = true;
              streamedTtsText += delta;
            }
          },
          onSegment: (segment, accumulated) => {
            if (
              !isCurrentChatRun(run)
              || !run.realtime
              || segment.turnId !== run.turnId
            ) return;
            run.accumulated = accumulated;
            run.lastFallback = normalizeEmotion(segment.fallback);
            updateStreamingAssistantMessage(ensureRunMessage(run), accumulated);
            dom.typingState.hidden = true;
            if (state.realtimeDiagnostics.ttfcMs === null) {
              publishRealtimeDiagnostics({
                ttfcMs: Math.max(0, performance.now() - run.requestStartedAt),
              });
            }

            const resolved = {
              turnId: run.turnId,
              modelEpoch: run.modelEpoch,
              seq: segment.seq,
              cues: segment.cues,
            };
            run.resolvedSegments.set(segment.seq, resolved);
            run.segmentFallbacks.set(segment.seq, run.lastFallback);
            const trustedMatch = segment.cues.length === 1
              ? segment.cues[0]?.id?.match(/^trusted_reference:([A-Za-z0-9@_-]{1,64}):(\d{1,3})$/u)
              : null;
            const trustedGroup = trustedMatch?.[1] ?? null;
            const trustedIndex = trustedMatch ? Number(trustedMatch[2]) : -1;
            const trustedEntries = trustedGroup
              ? state.model?.internalModel?.settings?.motions?.[trustedGroup]
              : null;
            const trustedReference = Boolean(
              trustedGroup
              && Number.isSafeInteger(trustedIndex)
              && trustedIndex >= 0
              && Array.isArray(trustedEntries)
              && trustedIndex < trustedEntries.length
            );
            const cuesAccepted = !run.cuesCancelled
              && segment.cuesRejected !== true
              && segment.cues.length > 0
              && (trustedReference || state.actionCueScheduler.enqueueSegment(resolved));
            if (cuesAccepted) {
              run.acceptedCueSegments.add(segment.seq);
              if (trustedReference) {
                run.boundCueSegments.add(segment.seq);
                void playMotion(
                  trustedGroup,
                  trustedIndex,
                  `模型原有 · ${trustedGroup} ${trustedIndex + 1}`,
                ).then((started) => {
                  if (started || !isCurrentChatRun(run)) return;
                  markRealtimeSegmentFallback(run, segment.seq, true);
                  void playRealtimeSegmentFallback(run, segment.seq);
                });
              }
            }
            const needsFallback = !run.cuesCancelled && (
              segment.cuesRejected === true
              || segment.cues.length === 0
              || !cuesAccepted
            );
            if (needsFallback) run.fallbackSegments.add(segment.seq);
            publishRealtimeCueState(run);
            if (
              !run.cuesCancelled
              && (segment.cuesRejected === true || (segment.cues.length && !cuesAccepted))
            ) {
              publishRealtimeDiagnostics({
                invalidCues: state.realtimeDiagnostics.invalidCues + 1,
              });
            }

            if (
              run.streamTtsEnabled
              && state.ttsEnabled
              && chatTtsRevision === state.ttsPlaybackRevision
            ) {
              const tag = { turnId: run.turnId, segmentSeq: segment.seq };
              const itemId = tts.enqueue(segment.text, {}, tag);
              if (itemId !== null) run.audioPending.add(segment.seq);
              else {
                publishRealtimeDiagnostics({
                  bufferUnderruns: state.realtimeDiagnostics.bufferUnderruns + 1,
                });
                requestRealtimePerformanceSwitch(run);
              }
            } else if (
              !trustedReference
              && !run.cuesCancelled
              && !run.performanceSwitchPending
            ) {
              run.clockMode = "performance";
              state.realtimeClockMode = "performance";
              bindRealtimeSegmentWithoutTts(run, segment);
            }
          },
          onDone: (streamResult) => {
            if (!isCurrentChatRun(run)) return;
            streamCompleted = true;
            if (run.realtime) return;
            if (
              !state.ttsEnabled
              || chatTtsRevision !== state.ttsPlaybackRevision
            ) return;
            if (!streamTtsEnabled) {
              speakCompletedReply(streamResult.reply, chatTtsRevision);
            } else {
              if (!streamedToTts && streamResult.reply) {
                tts.appendStreamingText(streamResult.reply);
              } else {
                const tail = getUnstreamedReplyTail(streamedTtsText, streamResult.reply);
                if (tail) tts.appendStreamingText(tail);
              }
              tts.flushStreamingText();
            }
          },
          onPartialError: (event, accumulated) => {
            preservePartialRealtimeReply(event, accumulated);
          },
          onError: () => {
            if (!isCurrentChatRun(run)) return true;
            if (run.realtime && run.accumulated) {
              preservePartialRealtimeReply({ partial: true }, run.accumulated);
              return true;
            }
            if (run.realtime && run.resolvedSegments.size === 0) {
              clearRealtimeRunTimers(run);
              if (run.turnId) state.actionCueScheduler.cancelTurn(run.turnId, 200);
              run.realtime = false;
              run.turnId = null;
              run.cuesCancelled = true;
              state.realtimeClockMode = null;
            }
            if (run.streamingMessage || streamedToTts) tts.stop();
            if (run.turnId) state.actionCueScheduler.cancelTurn(run.turnId, 200);
            return false;
          },
        }, controller),
        minimumTyping,
      ]);
      if (!isCurrentChatRun(run)) return;
      setChatBusy(false);
      const reply = run.partial && run.accumulated ? run.accumulated : result.reply;
      const emotion = run.partial ? run.lastFallback : result.emotion;
      if (run.streamingMessage) {
        finalizeStreamingAssistantMessage(run.streamingMessage, reply, emotion);
        if (!run.realtime && !streamCompleted) speakCompletedReply(reply, chatTtsRevision);
      } else {
        addMessage("assistant", reply, emotion);
        if (!run.realtime) speakCompletedReply(reply, chatTtsRevision);
      }
      if (!run.realtime) playReplyEmotionWithSpeech(emotion);
      if (result.source === "api") {
        dom.chatMode.dataset.mode = "live";
        dom.chatMode.textContent = result.mode === "dsh-realtime" ? "DSH" : "API";
        dom.replySource.textContent = result.partial ? "DSH 部分实时回复" : "实时 API 回复";
      } else {
        dom.chatMode.dataset.mode = "demo";
        dom.chatMode.textContent = "DEMO";
        dom.replySource.textContent = run.realtime ? "服务端演示回复" : "浏览器演示回复";
      }
      run.completed = true;
      if (state.chatController === controller) state.chatController = null;
    } catch (error) {
      if (!isCurrentChatRun(run)) return;
      setChatBusy(false);
      if (run.accumulated) {
        preservePartialRealtimeReply({ partial: true }, run.accumulated);
        finalizeStreamingAssistantMessage(
          ensureRunMessage(run),
          run.accumulated,
          run.lastFallback,
        );
        dom.chatMode.dataset.mode = "live";
        dom.chatMode.textContent = "DSH";
        dom.replySource.textContent = "DSH 部分实时回复";
      } else {
        const fallback = deterministicDemoReply(message);
        if (run.streamingMessage) {
          finalizeStreamingAssistantMessage(run.streamingMessage, fallback.reply, fallback.emotion);
        } else {
          addMessage("assistant", fallback.reply, fallback.emotion);
        }
        playReplyEmotionWithSpeech(fallback.emotion);
        speakCompletedReply(fallback.reply, chatTtsRevision);
        dom.chatMode.dataset.mode = "demo";
        dom.chatMode.textContent = "DEMO";
        dom.replySource.textContent = "浏览器演示回复";
      }
      if (state.chatController === controller) state.chatController = null;
      console.error(error);
    } finally {
      if (isCurrentChatRun(run)) dom.chatInput.focus({ preventScroll: true });
    }
  }

  function initChat(restoredMessages = null) {
    dom.chatHistory.replaceChildren();
    state.messages = [];
    buildSuggestions();
    const safeRestored = Array.isArray(restoredMessages)
      ? restoredMessages.slice(-24).filter((message) => (
        message
        && ["user", "assistant"].includes(message.role)
        && typeof message.content === "string"
        && message.content.trim()
        && message.content.length <= 4000
      ))
      : [];
    if (safeRestored.length) {
      safeRestored.forEach((message) => {
        addMessage(message.role, message.content, message.emotion);
      });
    } else {
      addMessage("assistant", state.config.npc.greeting, "happy", { initial: true });
    }

    dom.chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      sendChatMessage(dom.chatInput.value);
    });
    dom.chatInput.addEventListener("input", resizeComposer);
    dom.chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendChatMessage(dom.chatInput.value);
      }
    });
    resizeComposer();
  }

  function normalizeGeneratedMotion(payload) {
    const motion = payload?.motion;
    const group = String(motion?.group || "").trim();
    const index = Number(motion?.index);
    if (!group || !Number.isInteger(index) || index < 0) {
      throw new Error("动作已生成，但服务端没有返回可播放的位置");
    }
    const name = String(motion?.name || "").trim();
    const label = String(motion?.label || name || `动作 ${index + 1}`).trim();
    const duration = Number(motion?.duration);
    return {
      group,
      index,
      name,
      label,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      modelRevision: payload?.modelRevision || Date.now(),
    };
  }

  function showGeneratedMotionResult(target) {
    dom.motionWorkshopResult.hidden = false;
    dom.motionWorkshopResultTitle.textContent = `${target.label}已加入动作库`;
    dom.motionWorkshopResultMeta.textContent = target.duration
      ? `${target.group} / ${target.duration.toFixed(1)} 秒`
      : `${target.group} / 动作 ${target.index + 1}`;
  }

  function saveGeneratedMotionNotice(target, message) {
    try {
      window.sessionStorage.setItem(
        "promptsoul.generatedMotion",
        JSON.stringify({
          target,
          message,
          messages: state.messages.slice(-24).map(({ role, content, emotion }) => ({
            role,
            content,
            emotion,
          })),
        }),
      );
    } catch (error) {
      console.info("PromptSoul: could not persist the motion reload notice.", error);
    }
  }

  function consumeGeneratedMotionNotice() {
    try {
      const raw = window.sessionStorage.getItem("promptsoul.generatedMotion");
      window.sessionStorage.removeItem("promptsoul.generatedMotion");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.info("PromptSoul: could not restore the motion reload notice.", error);
      return null;
    }
  }

  async function generateMotionFromPrompt() {
    if (state.workshopBusy || !state.motionCapabilities?.available) return;
    const prompt = dom.motionPrompt.value.trim();
    if (!prompt) {
      setWorkshopStatus("error", "请先写下希望角色完成的动作。提示词不会被清空。", { retry: false });
      dom.motionPrompt.focus();
      return;
    }

    setWorkshopBusy(true);
    dom.motionWorkshopResult.hidden = true;
    setWorkshopStatus("generating", "正在分析模型参数并生成安全动作，请不要关闭页面…");
    try {
      const payload = await fetchJsonWithTimeout(
        MOTION_GENERATE_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
        MOTION_REQUEST_TIMEOUT_MS,
      );
      const target = normalizeGeneratedMotion(payload);
      state.generatedMotion = target;
      setWorkshopStatus("loading", "动作已生成，正在载入最新模型并准备播放…");

      const played = await reloadLive2DForGeneratedMotion(target, target.modelRevision);
      if (!played) {
        const message = String(payload?.message || `${target.label}已生成`).trim();
        saveGeneratedMotionNotice(target, message);
        reloadPageForGeneratedMotion(target, target.modelRevision);
        return;
      }

      dom.motionPrompt.value = "";
      updateMotionPromptCounter();
      showGeneratedMotionResult(target);
      const capabilitiesLoaded = await loadMotionCapabilities();
      setWorkshopStatus(
        capabilitiesLoaded ? "success" : "error",
        capabilitiesLoaded
          ? String(payload?.message || `${target.label}已生成并开始播放`).trim()
          : `${target.label}已生成，但动作清单未能同步，请重新检查。`,
      );
    } catch (error) {
      setWorkshopStatus(
        "error",
        error.message || "动作生成失败。描述已保留，可以调整后重试。",
      );
      console.error("PromptSoul: motion generation failed.", error);
    } finally {
      setWorkshopBusy(false);
    }
  }

  function initMotionWorkshop(reloadNotice = null) {
    dom.motionWorkshopForm.addEventListener("submit", (event) => {
      event.preventDefault();
      generateMotionFromPrompt();
    });
    dom.motionPrompt.addEventListener("input", updateMotionPromptCounter);
    dom.motionPromptExamples.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        const maxLength = Number(dom.motionPrompt.maxLength) || 240;
        dom.motionPrompt.value = String(button.dataset.prompt || "").slice(0, maxLength);
        updateMotionPromptCounter();
        dom.motionPrompt.focus();
      });
    });
    dom.motionWorkshopRefresh.addEventListener("click", loadMotionCapabilities);
    dom.motionReplayButton.addEventListener("click", async () => {
      const target = state.generatedMotion;
      if (!target) return;
      const button = getMotionButton(target.group, target.index);
      const played = await playMotion(target.group, target.index, target.label, button);
      if (!played) {
        setWorkshopStatus("loading", "正在重新载入模型并准备播放动作…");
        await reloadLive2DForGeneratedMotion(target, target.modelRevision);
      }
    });
    window.addEventListener("promptsoul:provider-changed", () => {
      dom.chatMode.dataset.mode = "auto";
      dom.chatMode.textContent = "AUTO";
      dom.replySource.textContent = "AI Provider 已更新";
      loadMotionCapabilities();
    });
    updateMotionPromptCounter();
    syncWorkshopControls();
    loadMotionCapabilities().then(() => {
      if (!reloadNotice?.target) return;
      state.generatedMotion = reloadNotice.target;
      showGeneratedMotionResult(reloadNotice.target);
      if (state.motionCapabilities?.available) {
        setWorkshopStatus(
          "success",
          String(
            reloadNotice.message
            || `${reloadNotice.target.label}已加入动作库；如未自动播放，请点击“再播放一次”。`
          ),
        );
      }
    });
  }

  async function init() {
    const reloadNotice = consumeGeneratedMotionNotice();
    await loadNpcConfig();
    applyNpcConfig();
    initChat(reloadNotice?.messages);
    initTts();
    initWardrobe();
    initMotionWorkshop(reloadNotice);
    await initLive2D();
  }

  init().catch((error) => {
    console.error("PromptSoul initialization failed.", error);
    setModelState("error", "初始化失败");
    setStatus("页面初始化失败，请刷新后重试");
  });
})();
