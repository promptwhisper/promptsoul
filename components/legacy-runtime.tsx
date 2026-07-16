"use client";

import { useEffect } from "react";

const SDK_SCRIPTS = [
  {
    source: "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js",
    integrity: "sha384-MeKqhuhBpq1ZqqshjOzqDOQJ/00BuDVdnNeYgPKul9hmgROzmT17WkmUeFJ9Jlrb",
  },
  {
    source: "https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js",
    integrity: "sha384-98eYPI3XO3wKMBW5IUYk3WpffOsMLc+0WSK+ZMutD8S5R6e4E7hKIqFKcdHBLOMB",
  },
  {
    source: "https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js",
    integrity: "sha384-x73Ez+8Lf2UpkuWDPMvQ/T8scXzifx3geDffp4EdBI2/r/z+NlTxlHA5xySHOP7n",
  },
] as const;

function loadScript(source: string, integrity: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-promptsoul-sdk="${source}"]`);
  if (existing?.dataset.loaded === "true") return Promise.resolve();
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`SDK load failed: ${source}`)), {
        once: true,
      });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = false;
    script.crossOrigin = "anonymous";
    script.integrity = integrity;
    script.referrerPolicy = "no-referrer";
    script.dataset.promptsoulSdk = source;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener("error", () => reject(new Error(`SDK load failed: ${source}`)), {
      once: true,
    });
    document.head.append(script);
  });
}

export function LegacyRuntime() {
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        for (const script of SDK_SCRIPTS) await loadScript(script.source, script.integrity);
        if (active) await import("@/assets/app-runtime");
      } catch (error) {
        console.error("PromptSoul runtime failed to load.", error);
        const modelState = document.querySelector<HTMLElement>("#modelState .state-copy");
        const status = document.querySelector<HTMLElement>("#status .status-text");
        if (modelState) modelState.textContent = "模型加载失败";
        if (status) status.textContent = "Live2D SDK 加载失败，请检查网络后刷新";
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return null;
}
