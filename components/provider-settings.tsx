"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type PublicProviderSettings = {
  mode: "demo" | "provider";
  source: "demo" | "environment" | "runtime";
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
  if (settings.source === "runtime") return "临时 Key 已连接";
  if (settings.source === "environment") return "服务端 Key";
  return "本地演示";
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

export function ProviderSettings() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<PublicProviderSettings | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Key 仅保存在当前 Node 服务的内存中。");
  const [noticeState, setNoticeState] = useState<"neutral" | "success" | "error">("neutral");

  async function refreshSettings() {
    try {
      const response = await fetch("/api/provider", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(payload, "无法读取 Provider 配置"));
      setSettings(payload as unknown as PublicProviderSettings);
    } catch (error) {
      setSettings(FALLBACK_SETTINGS);
      setNotice(error instanceof Error ? error.message : "无法读取 Provider 配置");
      setNoticeState("error");
    }
  }

  useEffect(() => {
    void refreshSettings();
  }, []);

  function openDialog() {
    setNotice("Key 仅保存在当前 Node 服务的内存中，服务重启后自动清除。");
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
    const apiKey = String(form.get("apiKey") || "").trim();
    const apiBase = String(form.get("apiBase") || "").trim();
    const model = String(form.get("model") || "").trim();
    if (!apiKey) {
      setNotice("请输入 API Key。它不会写入浏览器存储或项目文件。");
      setNoticeState("error");
      keyRef.current?.focus();
      return;
    }

    setBusy(true);
    setNotice("正在把临时配置交给本地 Node 服务…");
    setNoticeState("neutral");
    try {
      const request = fetch("/api/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, apiBase, model }),
      });
      if (keyRef.current) keyRef.current.value = "";
      const response = await request;
      const payload = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(payload, "Provider 配置保存失败"));
      setSettings(payload as unknown as PublicProviderSettings);
      setNotice("已连接。后续聊天和动作生成将由后端调用 Provider。");
      setNoticeState("success");
      window.dispatchEvent(new CustomEvent("promptsoul:provider-changed"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Provider 配置保存失败");
      setNoticeState("error");
    } finally {
      setBusy(false);
    }
  }

  async function clearRuntimeKey() {
    if (busy) return;
    setBusy(true);
    setNotice("正在清除当前进程中的临时 Key…");
    setNoticeState("neutral");
    try {
      const response = await fetch("/api/provider", { method: "DELETE" });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(errorMessage(payload, "临时 Key 清除失败"));
      setSettings(payload as unknown as PublicProviderSettings);
      if (keyRef.current) keyRef.current.value = "";
      setNotice("临时 Key 已清除，当前配置已恢复为服务端环境变量或演示模式。");
      setNoticeState("success");
      window.dispatchEvent(new CustomEvent("promptsoul:provider-changed"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "临时 Key 清除失败");
      setNoticeState("error");
    } finally {
      setBusy(false);
    }
  }

  const current = settings || FALLBACK_SETTINGS;

  return (
    <>
      <button className="provider-trigger" type="button" onClick={openDialog} aria-label="打开 AI Provider 设置">
        <span className="provider-trigger-dot" data-active={current.hasApiKey} aria-hidden="true" />
        <span>{sourceLabel(settings)}</span>
      </button>

      <dialog className="provider-dialog" ref={dialogRef} onCancel={closeDialog}>
        <form className="provider-form" onSubmit={save}>
          <div className="provider-dialog-head">
            <div>
              <p className="eyebrow">AI PROVIDER</p>
              <h2>连接你的 AI 服务</h2>
            </div>
            <button className="provider-close" type="button" onClick={closeDialog} aria-label="关闭 AI 设置">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>

          <p className="provider-intro">
            浏览器只负责提交一次配置；Key 随后仅存在于本机 Node 进程内存，页面无法再次读取。
          </p>

          <div className="provider-current" data-active={current.hasApiKey}>
            <span aria-hidden="true" />
            <div>
              <strong>{sourceLabel(settings)}</strong>
              <small>{current.model}</small>
            </div>
          </div>

          <label className="provider-field">
            <span>API 地址</span>
            <input key={`base-${current.source}-${current.apiBase}`} name="apiBase" type="url" required defaultValue={current.apiBase} autoCapitalize="none" spellCheck={false} />
            <small>填写 OpenAI 兼容服务的 `/v1` 根地址；非本机地址必须使用 HTTPS。</small>
          </label>

          <label className="provider-field">
            <span>模型</span>
            <input key={`model-${current.source}-${current.model}`} name="model" required maxLength={200} defaultValue={current.model} autoCapitalize="none" spellCheck={false} />
          </label>

          <label className="provider-field">
            <span>API Key</span>
            <span className="provider-secret-field">
              <input
                ref={keyRef}
                name="apiKey"
                type={showKey ? "text" : "password"}
                required
                maxLength={4096}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="粘贴后仅发送给本地后端"
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
              onClick={clearRuntimeKey}
              disabled={busy || current.source !== "runtime"}
            >
              清除临时 Key
            </button>
            <button className="provider-save" type="submit" disabled={busy}>
              {busy ? "正在连接…" : "保存并连接"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
