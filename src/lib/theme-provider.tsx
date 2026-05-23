"use client";

import { useEffect } from "react";
import { applyFontStyle } from "@/lib/font-stacks";
import { FontStyle } from "@/types";

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
        // 应用字体风格
        applyFontStyle((s.font_style || "wenkai") as FontStyle);
      })
      .catch(() => {});
  }, []);

  return <>{children}</>;
}
