'use client';

import { useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';

interface Props {
  open: boolean;
  initialValue: string;
  onClose: () => void;
  onConfirm: (newTitle: string) => void | Promise<void>;
}

/**
 * 重命名对话弹窗
 * 从 ChatView 抽出：保持原有视觉/交互不变。
 * 外层根据 open 决定挂载内部组件，内部组件用 initialValue 直接初始化输入值。
 */
export default function RenameConvModal({ open, initialValue, onClose, onConfirm }: Props) {
  if (!open) return null;
  return <RenameConvModalInner initialValue={initialValue} onClose={onClose} onConfirm={onConfirm} />;
}

interface InnerProps {
  initialValue: string;
  onClose: () => void;
  onConfirm: (newTitle: string) => void | Promise<void>;
}

function RenameConvModalInner({ initialValue, onClose, onConfirm }: InnerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);

  const handleConfirm = () => {
    if (!value.trim()) return;
    void onConfirm(value.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
      <div className="surface-panel w-full max-w-md p-5">
        <h3 className="section-title text-xl">{t('chat.renameTitle')}</h3>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={t('chat.renamePlaceholder')}
          className="input-rich mt-4"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="soft-button soft-button-secondary">
            {t('chat.cancel')}
          </button>
          <button onClick={handleConfirm} className="soft-button soft-button-primary">
            {t('chat.renameConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
