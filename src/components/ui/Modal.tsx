'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Tailwind max-width 类，例如 "max-w-md"、"max-w-lg"，默认 "max-w-lg" */
  maxWidth?: string;
  /** 点击 backdrop 是否关闭，默认 true */
  closeOnBackdrop?: boolean;
}

/**
 * 通用模态框组件
 *
 * 可访问性 (A11y) 设计：
 * - role="dialog" + aria-modal="true"：通知屏幕阅读器这是模态对话框
 * - aria-labelledby：把 title 作为对话框名字关联给辅助技术
 * - ESC 键关闭：符合 WAI-ARIA Authoring Practices
 * - 焦点陷阱 (Focus Trap)：Tab/Shift+Tab 仅在 modal 内循环，避免焦点泄漏到背景
 * - 焦点恢复：关闭后把焦点还给打开 modal 之前的活跃元素，保持键盘用户的操作连续性
 * - React Portal：渲染到 document.body，避免父级 overflow/transform 影响层叠和定位
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 'max-w-lg',
  closeOnBackdrop = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // 保存打开 modal 之前的焦点元素，用于关闭后恢复
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // SSR 安全：用 lazy 初始化判断是否在浏览器环境
  // 注：纯客户端组件（'use client'）首次渲染就在浏览器，typeof document 直接为真；
  // 即便走 SSR 兜底，挂载后 useEffect 触发的状态同步交由 React 自身完成，无需手动 setState
  const [mounted] = useState(() => typeof document !== 'undefined');
  // 用 React 18+ 的 useId 生成稳定 id，替代渲染期间调用 Math.random（impure）
  const titleAutoId = useId();

  // 打开 modal 时：记录原焦点 → 把焦点移入第一个可聚焦元素
  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = (document.activeElement as HTMLElement) || null;

    // 等 DOM 渲染完成再聚焦
    const raf = requestAnimationFrame(() => {
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        // 没有可聚焦子元素时，让 dialog 本身可聚焦，确保焦点不会留在背景
        dialogRef.current?.focus();
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      // 关闭后恢复焦点
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  // ESC 关闭 + Tab 焦点陷阱
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      // 焦点陷阱：当焦点到达边界时循环回另一端
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        // Shift+Tab：从首个跳到末尾
        if (active === first || !dialogRef.current?.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        // Tab：从末尾跳到首个
        if (active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || !mounted) {
    // 未挂载或未打开时不渲染 Portal
    return null;
  }

  const titleId = title ? titleAutoId : undefined;

  const modalNode = (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      onClick={() => {
        if (closeOnBackdrop) onClose();
      }}
      aria-hidden="false"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${maxWidth} rounded-2xl bg-white shadow-xl outline-none dark:bg-zinc-900`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="border-b border-black/10 px-5 py-3 dark:border-white/10">
            <h2 id={titleId} className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {title}
            </h2>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );

  return createPortal(modalNode, document.body);
}

/**
 * 收集容器内所有可聚焦元素，跳过 disabled / 隐藏 / tabindex=-1 的元素
 */
function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
  return nodes.filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1 && isVisible(el));
}

function isVisible(el: HTMLElement): boolean {
  // offsetParent 为 null 表示元素被 display:none 或脱离布局
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}
