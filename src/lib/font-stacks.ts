import { FontSize, FontStyle } from '@/types';

/** 字体栈映射：通过修改 CSS 变量 --font-sans 来切换全局字体 */
export const FONT_STACKS: Record<FontStyle, string> = {
  wenkai: "'LXGW WenKai Screen', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', system-ui, -apple-system, sans-serif",
  system: "ui-sans-serif, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans SC', system-ui, -apple-system, sans-serif",
  serif: "'Noto Serif SC', 'Source Han Serif SC', 'SimSun', Georgia, serif",
};

/** 字体大小档位：通过修改 html 根 font-size 缩放 rem 体系（Tailwind text-* 等会跟随） */
export const FONT_SIZES: Record<FontSize, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
};

/** 应用字体风格到页面 */
export function applyFontStyle(style: FontStyle) {
  const stack = FONT_STACKS[style] || FONT_STACKS.wenkai;
  document.documentElement.style.setProperty('--font-sans', stack);
}

/** 应用字体大小到页面 */
export function applyFontSize(size: FontSize) {
  const value = FONT_SIZES[size] || FONT_SIZES.medium;
  document.documentElement.style.fontSize = value;
}
