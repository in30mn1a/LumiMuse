'use client';

import { useState, type InputHTMLAttributes } from 'react';

type NativeProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'>;

interface Props extends NativeProps {
  /** 空串表示不显示数值（如禁用的可选参数） */
  value: number | '';
  /** 只在输入框内容是有效数字时调用 */
  onValueChange: (value: number) => void;
}

/**
 * 受控数字输入框。
 *
 * 直接把 `Number(e.target.value)` 写回受控 value 时，清空输入会立刻变成 0，
 * 用户删不掉那个 0。这里在聚焦编辑期间保留原始文本草稿：空串或不完整输入不提交，
 * 失焦后回到外部值显示。
 */
export default function NumberInput({ value, onValueChange, onFocus, onBlur, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      {...rest}
      type="number"
      value={draft ?? value}
      onFocus={e => {
        setDraft(e.target.value);
        onFocus?.(e);
      }}
      onChange={e => {
        const text = e.target.value;
        setDraft(text);
        if (text.trim() === '') return;
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onValueChange(parsed);
      }}
      onBlur={e => {
        setDraft(null);
        onBlur?.(e);
      }}
    />
  );
}
