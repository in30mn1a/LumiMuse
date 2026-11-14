import { useSyncExternalStore } from 'react';

// 输入框「联网」开关。只是这台设备上的偏好，存 localStorage；
// 存储不可用（隐私模式等）时退回内存值，开关在本次会话内仍然可用。
const STORAGE_KEY = 'lumimuse_web_search';
const listeners = new Set<() => void>();
let memoryValue = false;

export function isWebSearchEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return memoryValue;
  }
}

export function setWebSearchEnabled(enabled: boolean): void {
  memoryValue = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // 写不进去就只保留内存值
  }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWebSearchToggle(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, isWebSearchEnabled, () => false);
  return [enabled, setWebSearchEnabled];
}
