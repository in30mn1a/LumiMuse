'use client';

import { useTranslation } from '@/lib/i18n-context';
import Modal from '@/components/ui/Modal';

export type DuplicateMode = 'linked' | 'full';

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (mode: DuplicateMode) => void | Promise<void>;
}

/**
 * 复制对话的方式选择弹窗。
 * 视觉外壳复用通用 <Modal>（焦点陷阱 / ESC / Portal），与 DeleteConvModal 保持一致。
 */
export default function DuplicateConvModal({ open, onClose, onConfirm }: Props) {
  const { t } = useTranslation();

  const options: { mode: DuplicateMode; title: string; desc: string }[] = [
    {
      mode: 'linked',
      title: t('chat.duplicateModeLinked'),
      desc: t('chat.duplicateModeLinkedDesc'),
    },
    {
      mode: 'full',
      title: t('chat.duplicateModeFull'),
      desc: t('chat.duplicateModeFullDesc'),
    },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={t('chat.duplicateModalTitle')}
      padded={false}
      closeOnBackdrop={false}
      dialogClassName="surface-panel w-full max-w-md p-5"
    >
      <h3 className="section-title text-xl">{t('chat.duplicateModalTitle')}</h3>

      <div className="mt-4 flex flex-col gap-2">
        {options.map(option => (
          <button
            key={option.mode}
            onClick={() => void onConfirm(option.mode)}
            /* soft-button 默认 white-space: nowrap，是为单行短标签设计的；
               这里是多行选项卡，必须放开换行，否则说明文字会顶出弹窗 */
            className="soft-button soft-button-secondary w-full flex-col items-start gap-1 whitespace-normal px-4 py-3 text-left"
          >
            <span className="w-full font-medium">{option.title}</span>
            <span className="section-copy w-full text-xs leading-relaxed opacity-80">{option.desc}</span>
          </button>
        ))}
      </div>

      <p className="mt-3 section-copy text-xs opacity-70">{t('chat.duplicateLinkedNote')}</p>

      <div className="mt-4 flex justify-end">
        <button onClick={onClose} className="soft-button soft-button-secondary">
          {t('chat.cancel')}
        </button>
      </div>
    </Modal>
  );
}
