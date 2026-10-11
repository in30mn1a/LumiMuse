'use client';

import { useState, type FormEvent } from 'react';
import Modal from '@/components/ui/Modal';
import { useTranslation } from '@/lib/i18n-context';

interface PromptModalProps {
  open: boolean;
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export default function PromptModal({
  open,
  title,
  placeholder,
  defaultValue = '',
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      maxWidth="max-w-md"
      dialogClassName="surface-panel w-full max-w-md rounded-2xl shadow-xl outline-none"
    >
      <PromptModalForm
        title={title}
        placeholder={placeholder}
        defaultValue={defaultValue}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </Modal>
  );
}

function PromptModalForm({
  title,
  placeholder,
  defaultValue = '',
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: Omit<PromptModalProps, 'open'>) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={placeholder || title}
        aria-label={title}
        className="input-rich w-full"
        autoFocus
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="soft-button soft-button-secondary px-4 py-2 text-xs"
        >
          {cancelLabel || t('common.cancel')}
        </button>
        <button
          type="submit"
          disabled={!value.trim()}
          className="soft-button soft-button-primary px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {confirmLabel || t('common.save')}
        </button>
      </div>
    </form>
  );
}
