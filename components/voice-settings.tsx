"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type PublicVoiceSettings = {
  mode: "disabled" | "voice";
  source: "environment" | "runtime";
  engine: "openaiCompatible";
  apiUrl: string;
  model: string;
  speaker: string;
  speed: number;
  hasApiKey: boolean;
};

const FALLBACK_SETTINGS: PublicVoiceSettings = {
  mode: "disabled",
  source: "environment",
  engine: "openaiCompatible",
  apiUrl: "https://api.openai.com/v1/audio/speech",
  model: "gpt-4o-mini-tts",
  speaker: "alloy",
  speed: 1,
  hasApiKey: false,
};

function sourceLabel(settings: PublicVoiceSettings | null): string {
  if (!settings || settings.mode === "disabled") return "语音已关闭";
  return settings.source === "runtime" ? "临时语音已连接" : "服务端语音";
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorMessage(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

function publishSettings(settings: PublicVoiceSettings) {
  window.dispatchEvent(new CustomEvent("promptsoul:voice-changed", {
    detail: { enabled: settings.mode === "voice" },
  }));
}

export function VoiceSettings() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<PublicVoiceSettings | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("语音 Key 与聊天 Key 完全独立，仅保存在当前 Node 进程内存。");
  const [noticeState, setNoticeState] = useState<"neutral" | "success" | "error">("neutral");

  async function refreshSettings() {
    try {
      const response = await fetch("/api/voice/settings", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(payload, "无法读取语音配置"));
      const next = payload as unknown as PublicVoiceSettings;
      setSettings(next);
      publishSettings(next);
    } catch (error) {
      setSettings(FALLBACK_SETTINGS);
      setNotice(error instanceof Error ? error.message : "无法读取语音配置");
      setNoticeState("error");
    }
  }

  useEffect(() => {
    void refreshSettings();
  }, []);

  function openDialog() {
    setNotice("可连接 OpenAI Speech API、Kokoro 等 OpenAI-compatible TTS；本机服务允许 HTTP。");
    setNoticeState("neutral");
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    if (keyRef.current) keyRef.current.value = "";
    setShowKey(false);
    dialogRef.current?.close();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const enabled = form.get("enabled") === "on";
    const apiKey = String(form.get("apiKey") || "").trim();
    const apiUrl = String(form.get("apiUrl") || "").trim();
    const model = String(form.get("model") || "").trim();
    const speaker = String(form.get("speaker") || "").trim();
    const speed = Number(form.get("speed") || 1);

    setBusy(true);
    setNotice("正在把语音配置交给本地 Node 服务…");
    setNoticeState("neutral");
    try {
      const request = fetch("/api/voice/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, apiKey, apiUrl, model, speaker, speed }),
      });
      if (keyRef.current) keyRef.current.value = "";
      const response = await request;
      const payload = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(payload, "语音配置保存失败"));
      const next = payload as unknown as PublicVoiceSettings;
      setSettings(next);
      publishSettings(next);
      setNotice(enabled
        ? "语音已启用。角色回复会生成音频，并用音量驱动 Live2D 口型。"
        : "语音已关闭，聊天和情绪动作仍可正常使用。");
      setNoticeState("success");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "语音配置保存失败");
      setNoticeState("error");
    } finally {
      setBusy(false);
    }
  }

  async function resetRuntimeSettings() {
    if (busy) return;
    setBusy(true);
    setNotice("正在清除当前进程中的临时语音配置…");
    setNoticeState("neutral");
    try {
      const response = await fetch("/api/voice/settings", { method: "DELETE" });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(payload, "语音配置清除失败"));
      const next = payload as unknown as PublicVoiceSettings;
      setSettings(next);
      publishSettings(next);
      if (keyRef.current) keyRef.current.value = "";
      setNotice("临时语音配置已清除，当前已恢复服务端环境变量。");
      setNoticeState("success");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "语音配置清除失败");
      setNoticeState("error");
    } finally {
      setBusy(false);
    }
  }

  const current = settings || FALLBACK_SETTINGS;
  const enabled = current.mode === "voice";

  return (
    <>
      <button
        className="provider-trigger voice-trigger"
        type="button"
        onClick={openDialog}
        aria-label="打开角色语音设置"
      >
        <span className="provider-trigger-dot" data-active={enabled} aria-hidden="true" />
        <span>{sourceLabel(settings)}</span>
      </button>

      <dialog className="provider-dialog" ref={dialogRef} onCancel={closeDialog}>
        <form className="provider-form" onSubmit={save}>
          <div className="provider-dialog-head">
            <div>
              <p className="eyebrow">AITUBER VOICE</p>
              <h2>连接角色语音</h2>
            </div>
            <button className="provider-close" type="button" onClick={closeDialog} aria-label="关闭语音设置">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>

          <p className="provider-intro">
            语音由 AITuber OnAir Voice 在服务端生成。浏览器只接收音频，不会读取聊天或语音 Key。
          </p>

          <div className="provider-current" data-active={enabled}>
            <span aria-hidden="true" />
            <div>
              <strong>{sourceLabel(settings)}</strong>
              <small>{current.model} · {current.speaker || "默认音色"} · {current.speed}×</small>
            </div>
          </div>

          <label className="provider-toggle">
            <input
              key={`enabled-${current.source}-${current.mode}`}
              name="enabled"
              type="checkbox"
              defaultChecked={enabled}
            />
            <span>
              <strong>启用回复语音与口型同步</strong>
              <small>关闭后不会发起 TTS 请求，也不影响文字聊天和情绪动作。</small>
            </span>
          </label>

          <label className="provider-field">
            <span>Speech API 地址</span>
            <input
              key={`voice-url-${current.source}-${current.apiUrl}`}
              name="apiUrl"
              type="url"
              required
              defaultValue={current.apiUrl}
              autoCapitalize="none"
              spellCheck={false}
            />
            <small>填写完整的 `/v1/audio/speech` 地址；非本机地址必须使用 HTTPS。</small>
          </label>

          <div className="provider-field-row">
            <label className="provider-field">
              <span>语音模型</span>
              <input
                key={`voice-model-${current.source}-${current.model}`}
                name="model"
                required
                maxLength={200}
                defaultValue={current.model}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label className="provider-field">
              <span>音色 / Speaker</span>
              <input
                key={`voice-speaker-${current.source}-${current.speaker}`}
                name="speaker"
                maxLength={200}
                defaultValue={current.speaker}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          </div>

          <label className="provider-field">
            <span>语速（0.25–4）</span>
            <input
              key={`voice-speed-${current.source}-${current.speed}`}
              name="speed"
              type="number"
              min="0.25"
              max="4"
              step="0.05"
              required
              defaultValue={current.speed}
            />
          </label>

          <label className="provider-field">
            <span>独立语音 API Key（本机免 Key 服务可留空）</span>
            <span className="provider-secret-field">
              <input
                ref={keyRef}
                name="apiKey"
                type={showKey ? "text" : "password"}
                maxLength={4096}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={current.hasApiKey ? "已配置；重新保存时请重新输入" : "可留空"}
              />
              <button type="button" onClick={() => setShowKey((value) => !value)}>
                {showKey ? "隐藏" : "显示"}
              </button>
            </span>
          </label>

          <p className="provider-notice" data-state={noticeState} role="status" aria-live="polite">
            {notice}
          </p>

          <div className="provider-actions">
            <button
              className="provider-clear"
              type="button"
              onClick={resetRuntimeSettings}
              disabled={busy || current.source !== "runtime"}
            >
              恢复服务端配置
            </button>
            <button className="provider-save" type="submit" disabled={busy}>
              {busy ? "正在保存…" : "保存语音设置"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
