'use client';

/**
 * 全局轻量 Toast 系统
 *
 * 用法：
 *   1) 在根 layout 中包裹 <ToastProvider>
 *   2) 子组件中 const { showToast } = useToast(); showToast('已保存', 'success');
 *
 * 设计要点：
 * - 不依赖外部 UI 库；仅基于 React Context + 本地状态
 * - 支持 success / error / info 三类语义
 * - 自动在 TOAST_DURATION_MS 后消失，点击可手动关闭
 * - 多条 toast 垂直堆叠展示
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const TOAST_DURATION_MS = 4000;

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems(prev => prev.filter(item => item.id !== id));
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++idRef.current;
    setItems(prev => [...prev, { id, message, type }]);
    // 自动关闭：到时间从队列里移除
    setTimeout(() => {
      setItems(prev => prev.filter(item => item.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map(item => (
        <div
          key={item.id}
          onClick={() => onDismiss(item.id)}
          role="status"
          className={`pointer-events-auto relative flex max-w-[90vw] cursor-pointer items-center gap-2 overflow-hidden rounded-2xl border px-4 py-2.5 text-sm shadow-lg backdrop-blur-xl transition-all ${
            item.type === 'error'
              ? 'border-red-200/60 bg-red-50/90 text-red-700'
              : item.type === 'success'
                ? 'border-green-200/60 bg-green-50/90 text-green-700'
                : 'border-accent/20 bg-white/90 text-text-primary'
          }`}
        >
          <span className="break-words">{item.message}</span>
        </div>
      ))}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // 没有 Provider 时给一个降级实现，避免硬崩溃
    return {
      showToast: (message: string) => {
        if (typeof window !== 'undefined') {
          console.warn('[Toast] Provider 未挂载，降级输出：', message);
        }
      },
    };
  }
  return ctx;
}
