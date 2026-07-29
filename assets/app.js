import {
  TtsPlaybackManager,
  getUnstreamedReplyTail,
} from "../lib/shared/browser-tts";

(() => {
  "use strict";

  const CUSTOM_GROUP_PRIORITY = ["PromptSoul", "Action"];
  const MOTION_CAPABILITIES_ENDPOINT = "/api/motions/capabilities";
  const MOTION_GENERATE_ENDPOINT = "/api/motions/generate";
  const MOTION_DELETE_ENDPOINT = (motionId) => `/api/motions/${encodeURIComponent(motionId)}`;
  const MOTION_REQUEST_TIMEOUT_MS = 120000;
  const MOTION_DELETE_TIMEOUT_MS = 30000;
  const TTS_STATUS_ENDPOINT = "/api/tts/status";
  const TTS_SYNTHESIS_ENDPOINT = "/api/tts";
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

  const state = {
    config: DEFAULT_CONFIG,
    pixiApp: null,
    model: null,
    modelReady: false,
    userAdjusted: false,
    layoutModel: null,
    messages: [],
    chatBusy: false,
    emotionMotions: new Map(),
    activeMotionButton: null,
    pendingEmotion: null,
    motionCapabilities: null,
    workshopBusy: false,
    deletingMotionId: null,
    generatedMotion: null,
    ttsEnabled: false,
    ttsStatus: null,
    ttsStatusRevision: 0,
    ttsPlaybackRevision: 0,
    ttsManager: null,
    lipSyncValue: 0,
    appliedLipSyncValue: 0,
    peakAppliedLipSyncValue: 0,
    lipSyncParameterIds: [],
    lipSyncParameterReadbackVerified: false,
    lipSyncResetPending: false,
    lipSyncBinding: null,
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
    const disabled = state.workshopBusy || Boolean(state.deletingMotionId) || !available;
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

  async function resolveModelJson(modelRevision = null) {
    const params = new URLSearchParams(window.location.search);
    const revision = modelRevision || params.get("motionRevision");
    const override = params.get("model");
    if (override) return addModelRevision(override, revision);
    const response = await fetch("model.config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("请先运行 npm run setup:model -- /path/to/model 导入模型");
    const config = await response.json();
    if (!config.model3) throw new Error("model.config.json 中缺少 model3 路径");
    return addModelRevision(config.model3, revision);
  }

  function destroyCurrentLive2D() {
    clearActiveMotion();
    uninstallLive2DLipSync();
    state.modelReady = false;
    dom.resetView.onclick = null;
    if (state.pixiApp) {
      try {
        state.pixiApp.destroy(true, {
          children: true,
          texture: false,
          baseTexture: false,
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

  function installLive2DLipSync(model) {
    uninstallLive2DLipSync();
    const internalModel = model?.internalModel;
    if (!internalModel?.on) return;
    const mouthParameterIds = resolveMouthParameterIds(model);
    state.lipSyncParameterIds = [];
    state.lipSyncParameterReadbackVerified = false;
    const updateMouth = () => {
      if (!state.lipSyncResetPending && state.lipSyncValue === 0) return;
      const readback = setMouthOpen(model, mouthParameterIds, state.lipSyncValue);
      state.lipSyncParameterIds = readback.parameterIds;
      state.lipSyncParameterReadbackVerified = readback.parameterIds.length > 0;
      state.appliedLipSyncValue = readback.value;
      state.peakAppliedLipSyncValue = Math.max(
        state.peakAppliedLipSyncValue,
        state.appliedLipSyncValue,
      );
      if (state.lipSyncValue === 0) state.lipSyncResetPending = false;
    };
    internalModel.on("beforeModelUpdate", updateMouth);
    state.lipSyncBinding = { internalModel, updateMouth };
  }

  function uninstallLive2DLipSync() {
    const binding = state.lipSyncBinding;
    binding?.internalModel?.off?.("beforeModelUpdate", binding.updateMouth);
    state.lipSyncBinding = null;
    state.lipSyncParameterIds = [];
    state.lipSyncParameterReadbackVerified = false;
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
      ) * 1.08;
      model.anchor.set(0.5, 0.5);
      model.scale.set(scale);
      model.position.set(app.screen.width / 2, app.screen.height / 2 + app.screen.height * 0.055);
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
        if (active) manager.update = () => true;
        setStatus(
          `自动播放 · ${play} · frozen@${freeze}s · ` +
          `started=${started} · playing=${playing} · active=${active}`,
        );
      }, freeze * 1000);
    }
  }

  async function initLive2D(options = {}) {
    const autoPlay = options.autoPlay || null;
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
      state.model = model;
      state.modelReady = true;
      app.stage.addChild(model);
      installModelControls(app, model);
      installLive2DLipSync(model);

      const groups = model.internalModel.settings.motions || {};
      buildMotionDeck(groups);
      model.internalModel.motionManager?.on?.("motionFinish", () => {
        clearActiveMotion();
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
    dom.sendButton.disabled = busy;
    dom.chatInput.disabled = busy;
    dom.suggestions.querySelectorAll("button").forEach((button) => {
      button.disabled = busy;
    });
    if (busy) scrollChatToEnd();
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
    };
  }

  async function readStreamingChatResponse(response, callbacks = {}) {
    if (!response.body?.getReader) throw new Error("Streaming chat response has no readable body");
    callbacks.onStart?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let accumulated = "";
    let finalResult = null;

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        throw new Error("Chat stream returned invalid NDJSON");
      }
      if (event?.type === "delta") {
        const delta = typeof event.text === "string" ? event.text : "";
        if (!delta) return;
        accumulated += delta;
        callbacks.onDelta?.(delta, accumulated);
        return;
      }
      if (event?.type === "done") {
        finalResult = parseApiReply({
          ...event,
          reply: typeof event.reply === "string" && event.reply.trim() ? event.reply : accumulated,
        });
        callbacks.onDone?.(finalResult, accumulated);
        return;
      }
      if (event?.type === "error") {
        throw new Error(String(event?.error?.message || "Chat stream failed"));
      }
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

  async function requestChatReply(message, callbacks = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => controller.abort(),
      Number(state.config.requestTimeoutMs) || 45000,
    );
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
        return await readStreamingChatResponse(response, callbacks);
      }
      return parseApiReply(await response.json());
    } catch (error) {
      callbacks.onError?.(error);
      console.info("PromptSoul: chat API unavailable, switched to deterministic demo mode.", error);
      return deterministicDemoReply(message);
    } finally {
      window.clearTimeout(timer);
    }
  }

  function updateTtsDiagnostics(snapshot) {
    const status = state.ttsStatus || {};
    const diagnostics = {
      ...snapshot,
      mouthOpen: state.appliedLipSyncValue,
      peakMouthOpen: state.peakAppliedLipSyncValue,
      lipSyncParameterIds: [...state.lipSyncParameterIds],
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
      setStatus("角色正在说话 · 语音实时驱动口型");
    } else if (state.modelReady) {
      setStatus("角色待机中 · 和她聊聊，看看会触发什么动作");
    }
  }

  function createTtsManager() {
    if (state.ttsManager) return state.ttsManager;
    state.ttsManager = new TtsPlaybackManager({
      endpoint: TTS_SYNTHESIS_ENDPOINT,
      onSnapshot: updateTtsDiagnostics,
      onMouthOpen: setTtsMouthOpen,
      onSpeakingChange: setTtsSpeaking,
    });
    return state.ttsManager;
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
      if (!state.ttsEnabled) {
        state.ttsPlaybackRevision += 1;
        state.ttsManager?.stop();
      }
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
      state.ttsPlaybackRevision += 1;
      state.ttsManager?.stop();
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
      enqueue: (text, options) => manager.enqueue(text, options),
      appendStreamingText: (chunk, options) => manager.appendStreamingText(chunk, options),
      flushStreamingText: (options) => manager.flushStreamingText(options),
      clearStreamingText: () => manager.clearStreamingText(),
      play: (text, options) => {
        state.ttsPlaybackRevision += 1;
        manager.stop();
        manager.appendStreamingText(text, options);
        return manager.flushStreamingText(options);
      },
      stop: () => {
        state.ttsPlaybackRevision += 1;
        manager.stop();
      },
      clear: () => {
        state.ttsPlaybackRevision += 1;
        manager.clear();
      },
      pause: () => manager.pause(),
      resume: () => manager.resume(),
      unlock: () => manager.unlock(),
      getState: () => manager.getState(),
      refreshStatus: () => refreshTtsStatus(),
      startAudioCapture: () => manager.startAudioCapture(),
      stopAudioCapture: () => manager.stopAudioCapture(),
    });
    const handleVoiceChanged = (event) => {
      const enabled = Boolean(event?.detail?.enabled);
      if (!enabled) {
        state.ttsPlaybackRevision += 1;
        manager.stop();
      }
      refreshTtsStatus();
    };
    const handleStatusRefresh = () => { void refreshTtsStatus(); };
    const handlePreview = async (event) => {
      const text = String(event?.detail?.text || "").trim();
      if (!text) return;
      const revision = ++state.ttsPlaybackRevision;
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
      state.ttsPlaybackRevision += 1;
      manager.stop();
      resetTtsMouthState();
      updateTtsDiagnostics(manager.getState());
      if (event?.persisted) return;
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
    if (!message || state.chatBusy) return;

    addMessage("user", message);
    dom.chatInput.value = "";
    resizeComposer();
    setChatBusy(true);
    const tts = createTtsManager();
    const chatTtsRevision = ++state.ttsPlaybackRevision;
    tts.stop();
    const streamTtsEnabled = state.ttsEnabled;
    if (streamTtsEnabled) void tts.unlock();
    playEmotion("thinking");

    const minimumTyping = new Promise((resolve) => window.setTimeout(resolve, 680));
    let streamingMessage = null;
    let streamedToTts = false;
    let streamedTtsText = "";
    let streamCompleted = false;
    try {
      const [result] = await Promise.all([
        requestChatReply(message, {
          onStart: () => {
            streamingMessage = addMessage("assistant", "", "neutral", { streaming: true });
          },
          onDelta: (delta, accumulated) => {
            updateStreamingAssistantMessage(streamingMessage, accumulated);
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
          onDone: (streamResult) => {
            streamCompleted = true;
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
          onError: () => {
            if (streamingMessage || streamedToTts) tts.stop();
          },
        }),
        minimumTyping,
      ]);
      setChatBusy(false);
      if (streamingMessage) {
        finalizeStreamingAssistantMessage(streamingMessage, result.reply, result.emotion);
        if (!streamCompleted) speakCompletedReply(result.reply, chatTtsRevision);
      } else {
        addMessage("assistant", result.reply, result.emotion);
        speakCompletedReply(result.reply, chatTtsRevision);
      }
      playEmotion(result.emotion);
      if (result.source === "api") {
        dom.chatMode.dataset.mode = "live";
        dom.chatMode.textContent = "API";
        dom.replySource.textContent = "实时 API 回复";
      } else {
        dom.chatMode.dataset.mode = "demo";
        dom.chatMode.textContent = "DEMO";
        dom.replySource.textContent = "浏览器演示回复";
      }
    } catch (error) {
      setChatBusy(false);
      const fallback = deterministicDemoReply(message);
      if (streamingMessage) {
        finalizeStreamingAssistantMessage(streamingMessage, fallback.reply, fallback.emotion);
      } else {
        addMessage("assistant", fallback.reply, fallback.emotion);
      }
      playEmotion(fallback.emotion);
      speakCompletedReply(fallback.reply, chatTtsRevision);
      dom.chatMode.dataset.mode = "demo";
      dom.chatMode.textContent = "DEMO";
      dom.replySource.textContent = "浏览器演示回复";
      console.error(error);
    } finally {
      dom.chatInput.focus({ preventScroll: true });
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
    initMotionWorkshop(reloadNotice);
    initLive2D();
  }

  init().catch((error) => {
    console.error("PromptSoul initialization failed.", error);
    setModelState("error", "初始化失败");
    setStatus("页面初始化失败，请刷新后重试");
  });
})();
