"use client";

import { useEffect, useRef, useState } from "react";

type TtsStatus = {
  provider: "aivis";
  ready: boolean;
  engineReachable: boolean;
  voiceResolved: boolean;
  speakerName: string | null;
  styleName: string | null;
  styleId: number | null;
  latencyMs: number;
  error: { code: string; message: string } | null;
};

type TtsVoice = {
  speakerUuid: string;
  speakerName: string;
  styles: Array<{ id: number; name: string }>;
};

type TtsRuntimeDetail = {
  state?: string;
  queueLength?: number;
  lastError?: string | null;
};

const DEFAULT_TEST_TEXT = "おかえりなさい。今日も会えて、すごくうれしいです。";
const SECOND_TEST_TEXT = "えへへ、そんなに見つめられると、ちょっと照れちゃいます。";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function apiError(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

function statusLabel(status: TtsStatus | null): string {
  if (!status) return "检查本地语音";
  if (!status.engineReachable) return "语音引擎离线";
  if (!status.voiceResolved) return "音色未安装";
  return "本地语音就绪";
}

export function VoiceSettings() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [text, setText] = useState(DEFAULT_TEST_TEXT);
  const [runtimeState, setRuntimeState] = useState("idle");
  const [queueLength, setQueueLength] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("AivisSpeech 在本机运行，不需要云端 TTS Key。");
  const [noticeState, setNoticeState] = useState<"neutral" | "success" | "error">("neutral");

  async function refresh(includeVoices = false) {
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    setBusy(true);
    try {
      const statusResponse = await fetch("/api/tts/status", {
        cache: "no-store",
        signal: controller.signal,
      });
      const statusPayload = await readJson(statusResponse);
      if (!statusResponse.ok) throw new Error(apiError(statusPayload, "无法读取本地语音状态"));
      const nextStatus = statusPayload as unknown as TtsStatus;
      setStatus(nextStatus);

      if (includeVoices && nextStatus.engineReachable) {
        const voicesResponse = await fetch("/api/tts/voices", {
          cache: "no-store",
          signal: controller.signal,
        });
        const voicesPayload = await readJson(voicesResponse);
        if (!voicesResponse.ok) throw new Error(apiError(voicesPayload, "无法读取已安装音色"));
        setVoices(Array.isArray(voicesPayload.voices) ? voicesPayload.voices as TtsVoice[] : []);
      } else if (!nextStatus.engineReachable) {
        setVoices([]);
      }

      if (nextStatus.ready) {
        setNotice(`已连接 ${nextStatus.speakerName} / ${nextStatus.styleName}，全局 Style ID ${nextStatus.styleId}。`);
        setNoticeState("success");
      } else {
        setNotice(nextStatus.error?.message || "请启动 AivisSpeech 并安装目标音色。");
        setNoticeState("error");
      }
      window.dispatchEvent(new CustomEvent("promptsoul:tts-status", { detail: nextStatus }));
      // Keep the legacy Live2D runtime's chat-TTS gate in sync when the Engine
      // becomes available after the page initially loaded offline.
      window.dispatchEvent(new CustomEvent("promptsoul:tts-status-refresh"));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus(null);
      setNotice(error instanceof Error ? error.message : "无法读取本地语音状态");
      setNoticeState("error");
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    // AivisSpeech readiness is external process state, initialized after this
    // client-only diagnostic control mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(false);
    const onRuntimeState = (event: Event) => {
      const detail = (event as CustomEvent<TtsRuntimeDetail>).detail ?? {};
      if (typeof detail.state === "string") setRuntimeState(detail.state);
      if (typeof detail.queueLength === "number") setQueueLength(detail.queueLength);
      if (detail.lastError) {
        setNotice(detail.lastError);
        setNoticeState("error");
      }
    };
    window.addEventListener("promptsoul:tts-state", onRuntimeState);
    return () => {
      const controller = refreshControllerRef.current;
      refreshControllerRef.current = null;
      controller?.abort();
      window.removeEventListener("promptsoul:tts-state", onRuntimeState);
    };
  }, []);

  function openDialog() {
    dialogRef.current?.showModal();
    void refresh(true);
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  function preview() {
    const readable = text.trim();
    if (!readable) {
      setNotice("请输入要试听的日语文本。");
      setNoticeState("error");
      return;
    }
    if (!status?.ready) {
      setNotice("本地语音尚未就绪，请先启动 AivisSpeech 并刷新。");
      setNoticeState("error");
      return;
    }
    setNotice("正在合成并等待真实音频播放…");
    setNoticeState("neutral");
    window.dispatchEvent(new CustomEvent("promptsoul:tts-preview", { detail: { text: readable } }));
  }

  function stop() {
    window.dispatchEvent(new CustomEvent("promptsoul:tts-stop"));
    setNotice("已停止播放并清空队列。");
    setNoticeState("neutral");
  }

  return (
    <>
      <button
        className="provider-trigger voice-trigger"
        type="button"
        onClick={openDialog}
        aria-label="打开本地语音调试"
      >
        <span className="provider-trigger-dot" data-active={Boolean(status?.ready)} aria-hidden="true" />
        <span>{statusLabel(status)}</span>
      </button>

      <dialog className="provider-dialog" ref={dialogRef} onCancel={closeDialog}>
        <div className="provider-form tts-debug-panel">
          <div className="provider-dialog-head">
            <div>
              <p className="eyebrow">LOCAL TTS</p>
              <h2>AivisSpeech 语音调试</h2>
            </div>
            <button className="provider-close" type="button" onClick={closeDialog} aria-label="关闭语音调试">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>

          <p className="provider-intro">
            浏览器只访问同源 <code>/api/tts</code>。引擎地址、模型文件和声音解析都留在 Node 服务端。
          </p>

          <div className="provider-current" data-active={Boolean(status?.ready)}>
            <span aria-hidden="true" />
            <div>
              <strong>{statusLabel(status)}</strong>
              <small>
                {status?.voiceResolved
                  ? `${status.speakerName} · ${status.styleName} · Style ${status.styleId}`
                  : "默认目标：コハク · あまあま"}
              </small>
            </div>
          </div>

          <div className="tts-runtime-summary" data-tts-state={runtimeState}>
            <span>播放状态：{runtimeState}</span>
            <span>队列：{queueLength}</span>
            <span>引擎延迟：{status ? `${status.latencyMs} ms` : "—"}</span>
          </div>

          <label className="provider-field">
            <span>日语试听文本</span>
            <textarea value={text} maxLength={500} rows={3} onChange={(event) => setText(event.target.value)} />
            <small>
              <button className="tts-inline-example" type="button" onClick={() => setText(SECOND_TEST_TEXT)}>
                换一条害羞台词
              </button>
            </small>
          </label>

          {voices.length > 0 && (
            <details className="tts-voice-list">
              <summary>已安装角色与风格（{voices.length}）</summary>
              <ul>
                {voices.map((voice) => (
                  <li key={voice.speakerUuid}>
                    <strong>{voice.speakerName}</strong>
                    <span>{voice.styles.map((style) => `${style.name} (${style.id})`).join("、")}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="provider-notice" data-state={noticeState} role="status" aria-live="polite">
            {notice}
          </p>

          <div className="provider-actions">
            <button className="provider-clear" type="button" onClick={() => void refresh(true)} disabled={busy}>
              {busy ? "检查中…" : "刷新声音列表"}
            </button>
            <button className="provider-clear" type="button" onClick={stop}>
              停止
            </button>
            <button className="provider-save" type="button" onClick={preview} disabled={busy || !status?.ready}>
              试听
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
