'use client';

import Modal from '@/components/ui/Modal';
import { useTranslation } from '@/lib/i18n-context';

interface ConfirmModalProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { t } = useTranslation();

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={title}
      ariaLabel={title || message}
      maxWidth="max-w-md"
      dialogClassName="surface-panel w-full max-w-md rounded-2xl shadow-xl outline-none"
    >
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
        {message}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="soft-button soft-button-secondary px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cancelLabel || t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`soft-button px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
            danger ? 'soft-button-danger' : 'soft-button-primary'
          }`}
        >
          {busy && <span className="spinner-sm" aria-hidden="true" />}
          {confirmLabel || (danger ? t('common.delete') : t('common.confirm'))}
        </button>
      </div>
    </Modal>
  );
}
