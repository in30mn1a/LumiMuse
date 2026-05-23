'use client';

import { useTranslation } from '@/lib/i18n-context';

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/**
 * 删除对话确认弹窗
 * 从 ChatView 抽出：保持原有视觉/交互不变。
 */
export default function DeleteConvModal({ open, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
      <div className="surface-panel w-full max-w-md p-5">
        <h3 className="section-title text-xl">{t('chat.deleteTitle')}</h3>
        <p className="mt-3 section-copy">{t('chat.deleteConfirm')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="soft-button soft-button-secondary">
            {t('chat.cancel')}
          </button>
          <button onClick={() => void onConfirm()} className="soft-button soft-button-danger">
            {t('chat.deleteAction')}
          </button>
        </div>
      </div>
    </div>
  );
}
