"use client";

import { useEffect } from "react";
import { applyFontStyle } from "@/lib/font-stacks";
import { FontStyle } from "@/types";

const THEME_STORAGE_KEY = "lumimuse_theme";

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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        // 应用主题
        if (s.theme === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
        // 同步写入 localStorage，供下次刷新时 inline script 使用
        writeThemeStorage(s.theme);
        // 应用字体风格
        applyFontStyle((s.font_style || "wenkai") as FontStyle);
      })
      .catch(() => {});
  }, []);

  return <>{children}</>;
}

// 导出给 settings 页面在切换主题后同步调用，保持 localStorage 与服务端设置一致。
export { writeThemeStorage };
