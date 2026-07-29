"use client";

import { useEffect, useRef, useState } from "react";

type PublicProviderSettings = {
  mode: "demo" | "provider";
  source: "demo" | "environment";
  model: string;
  apiBase: string;
  hasApiKey: boolean;
};

const FALLBACK_SETTINGS: PublicProviderSettings = {
  mode: "demo",
  source: "demo",
  model: "gpt-5.6-luna",
  apiBase: "https://api.openai.com/v1",
  hasApiKey: false,
};

function sourceLabel(settings: PublicProviderSettings | null): string {
  if (!settings) return "检查 AI 配置";
  return settings.source === "environment" ? "服务端 Key" : "本地演示";
}

export function ProviderSettings() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<PublicProviderSettings | null>(null);
  const [notice, setNotice] = useState("LLM API Key 只从 Node 服务端环境变量读取。");
  const [noticeState, setNoticeState] = useState<"neutral" | "success" | "error">("neutral");

  async function refresh() {
    try {
      const response = await fetch("/api/provider", { cache: "no-store" });
      const payload = await response.json() as PublicProviderSettings | { error?: { message?: string } };
      if (!response.ok || !("mode" in payload)) {
        throw new Error("error" in payload && payload.error?.message
          ? payload.error.message
          : "无法读取 Provider 配置");
      }
      setSettings(payload);
      setNotice(payload.hasApiKey
        ? "服务端环境变量已连接。浏览器无法读取或修改 Key。"
        : "当前使用确定性的本地演示回复。配置环境变量并重启服务即可接入模型。");
      setNoticeState(payload.hasApiKey ? "success" : "neutral");
    } catch (error) {
      setSettings(FALLBACK_SETTINGS);
      setNotice(error instanceof Error ? error.message : "无法读取 Provider 配置");
      setNoticeState("error");
    }
  }

  useEffect(() => {
    // The provider status is external server state fetched when this
    // client-only diagnostic control mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, []);

  const current = settings || FALLBACK_SETTINGS;

  return (
    <>
      <button className="provider-trigger" type="button" onClick={() => dialogRef.current?.showModal()} aria-label="查看 AI Provider 状态">
        <span className="provider-trigger-dot" data-active={current.hasApiKey} aria-hidden="true" />
        <span>{sourceLabel(settings)}</span>
      </button>

      <dialog className="provider-dialog" ref={dialogRef} onCancel={() => dialogRef.current?.close()}>
        <div className="provider-form">
          <div className="provider-dialog-head">
            <div>
              <p className="eyebrow">AI PROVIDER</p>
              <h2>服务端 AI 配置</h2>
            </div>
            <button className="provider-close" type="button" onClick={() => dialogRef.current?.close()} aria-label="关闭 AI 状态">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>

          <p className="provider-intro">
            为避免 Key 进入浏览器、录制脚本或页面内存，PromptSoul 只读取启动 Node 进程时提供的环境变量。
          </p>

          <div className="provider-current" data-active={current.hasApiKey}>
            <span aria-hidden="true" />
            <div>
              <strong>{sourceLabel(settings)}</strong>
              <small>{current.model} · {current.apiBase}</small>
            </div>
          </div>

          <pre className="provider-env-example"><code>{`NPC_API_KEY=你的服务端Key
NPC_API_BASE=${current.apiBase}
NPC_MODEL=${current.model}`}</code></pre>

          <p className="provider-notice" data-state={noticeState} role="status" aria-live="polite">
            {notice}
          </p>

          <div className="provider-actions">
            <button className="provider-clear" type="button" onClick={() => void refresh()}>
              刷新状态
            </button>
            <button className="provider-save" type="button" onClick={() => dialogRef.current?.close()}>
              知道了
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
