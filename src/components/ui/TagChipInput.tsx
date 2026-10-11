'use client';

import { useRef, useState, type KeyboardEvent, type ClipboardEvent } from 'react';
import { XIcon } from '@/components/ui/icons';
import { useTranslation } from '@/lib/i18n-context';

interface TagChipInputProps {
  id?: string;
  value: string;
  onChange: (nextValue: string) => void;
  onDraftChange?: (value: string) => void;
  placeholder?: string;
}

function splitTags(raw: string): { tags: string[]; hasOpenGroup: boolean } {
  const tags: string[] = [];
  const closingBrackets: string[] = [];
  let naiWeight = false;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (naiWeight) {
      if (raw.startsWith('::', i)) {
        naiWeight = false;
        i++;
      }
      continue;
    }
    const weight = /[\d+.-]/.test(char) && (i === 0 || /[\s,，([{]/.test(raw[i - 1]))
      ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)::/.exec(raw.slice(i))
      : null;
    if (weight) {
      naiWeight = true;
      i += weight[0].length - 1;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      closingBrackets.push(char === '(' ? ')' : char === '[' ? ']' : '}');
    } else if (char === closingBrackets.at(-1)) {
      closingBrackets.pop();
    } else if (closingBrackets.length === 0 && /[,，\n]/.test(char)) {
      const tag = raw.slice(start, i).trim();
      if (tag) tags.push(tag);
      start = i + 1;
    }
  }
  // 未闭合的权重组保留为一个草稿片段，避免删除其它标签时拆坏语法。
  const tail = raw.slice(start).trim();
  if (tail) tags.push(tail);
  return { tags, hasOpenGroup: naiWeight || closingBrackets.length > 0 };
}

function parseTags(raw: string): string[] {
  return splitTags(raw).tags;
}

function joinTags(tags: string[]): string {
  return tags.join(', ');
}

export default function TagChipInput({
  id,
  value,
  onChange,
  onDraftChange,
  placeholder,
}: TagChipInputProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const composingRef = useRef(false);
  const tags = parseTags(value);

  const updateDraft = (nextValue: string) => {
    setInputValue(nextValue);
    onDraftChange?.(nextValue);
  };

  const addRawTags = (rawInput: string) => {
    const incoming = parseTags(rawInput);
    if (incoming.length === 0) return;
    const existingLower = new Set(tags.map(tag => tag.toLowerCase()));
    const next = [...tags];
    for (const tag of incoming) {
      if (!existingLower.has(tag.toLowerCase())) {
        existingLower.add(tag.toLowerCase());
        next.push(tag);
      }
    }
    onChange(joinTags(next));
  };

  const removeTagAt = (index: number) => {
    const next = tags.filter((_, i) => i !== index);
    onChange(joinTags(next));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      if (event.key !== 'Enter' && splitTags(inputValue).hasOpenGroup) return;
      if (inputValue.trim()) {
        event.preventDefault();
        addRawTags(inputValue);
        updateDraft('');
      } else if (event.key !== 'Enter') {
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'Backspace' && !inputValue && tags.length > 0) {
      event.preventDefault();
      removeTagAt(tags.length - 1);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (pasted && /[,，\n]/.test(pasted)) {
      event.preventDefault();
      const input = event.currentTarget;
      const start = input.selectionStart ?? inputValue.length;
      const end = input.selectionEnd ?? start;
      addRawTags(inputValue.slice(0, start) + pasted + inputValue.slice(end));
      updateDraft('');
    }
  };

  const handleBlur = () => {
    if (composingRef.current) return;
    if (inputValue.trim()) {
      addRawTags(inputValue);
      updateDraft('');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex min-h-[2.75rem] flex-wrap items-center gap-1.5 rounded-2xl border border-border-light bg-white/80 px-3 py-2 transition-colors focus-within:border-accent">
        {tags.map((tag, index) => (
          <span
            key={`${tag}-${index}`}
            className="inline-flex items-center gap-1 rounded-xl border border-accent/25 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent-dark"
          >
            <span>{tag}</span>
            <button
              type="button"
              onClick={() => removeTagAt(index)}
              aria-label={`${t('common.delete')} ${tag}`}
              className="rounded-full p-0.5 text-accent-dark/70 transition-colors hover:bg-accent/20 hover:text-accent-dark"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={inputValue}
          onChange={e => updateDraft(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
          placeholder={tags.length === 0 ? (placeholder || t('editor.tagInputPlaceholder')) : t('editor.tagInputPlaceholder')}
          className="min-w-[10rem] flex-1 bg-transparent py-0.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
        />
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="textarea-rich text-xs text-text-secondary"
      />
    </div>
  );
}
