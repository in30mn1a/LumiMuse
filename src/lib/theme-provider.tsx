"use client";

import { useEffect } from "react";
import { applyFontSize, applyFontStyle } from "@/lib/font-stacks";
import { notifySettingsBootstrapFailed } from "@/lib/settings-bootstrap-events";
import { FontSize, FontStyle } from "@/types";

const THEME_STORAGE_KEY = "lumimuse_theme";
const SETTINGS_BOOTSTRAP_MAX_ATTEMPTS = 2;

function writeThemeStorage(theme: string | undefined) {
  // 同步把主题写到 localStorage，下次刷新时 layout 里的 inline script 能立刻读到，避免 FOUC。
  // 隐私模式下 localStorage 可能抛错，需要 try/catch 包裹。
  try {
    if (theme === "dark" || theme === "light" || theme === "auto") {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // 忽略 storage 异常
  }
}

async function fetchThemeSettings(signal?: AbortSignal): Promise<{ theme?: unknown; font_style?: unknown; font_size?: unknown }> {
  const response = await fetch("/api/settings", { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json() as { theme?: unknown; font_style?: unknown; font_size?: unknown };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= SETTINGS_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
        if (cancelled) return;
        try {
          const settings = await fetchThemeSettings(controller.signal);
          if (cancelled) return;
          // 应用主题
          if (settings.theme === "dark") {
            document.documentElement.classList.add("dark");
          } else {
            document.documentElement.classList.remove("dark");
          }
          // 同步写入 localStorage，供下次刷新时 inline script 使用
          writeThemeStorage(typeof settings.theme === "string" ? settings.theme : undefined);
          // 应用字体风格与大小
          applyFontStyle((typeof settings.font_style === "string" ? settings.font_style : "wenkai") as FontStyle);
          applyFontSize((typeof settings.font_size === "string" ? settings.font_size : "medium") as FontSize);
          return;
        } catch (error) {
          if (controller.signal.aborted || cancelled) return;
          lastError = error;
          if (attempt < SETTINGS_BOOTSTRAP_MAX_ATTEMPTS) continue;
        }
      }
      console.warn("[theme] failed to load theme from /api/settings; using current defaults", lastError);
      notifySettingsBootstrapFailed("theme");
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return <>{children}</>;
}

// 导出给 settings 页面在切换主题后同步调用，保持 localStorage 与服务端设置一致。
export { writeThemeStorage };
