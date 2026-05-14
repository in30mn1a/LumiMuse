'use client';

import { useTranslation } from '@/lib/i18n-context';
import { ClockIcon, SparkIcon } from '@/components/ui/icons';

interface Props {
  tokenCount: number;
  memoryStatus: string | null;
}

export default function StatusBar({ tokenCount, memoryStatus }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between border-t border-border-light bg-[rgba(248,244,255,0.74)] px-5 py-2 text-xs text-text-muted backdrop-blur-md dark:bg-[rgba(25,20,37,0.74)]">
      <span className="chip">
        <ClockIcon className="h-3.5 w-3.5" />
        {tokenCount} {t('status.tokens')}
      </span>

      <span className={`chip ${memoryStatus ? 'chip-active' : ''}`}>
        <SparkIcon className="h-3.5 w-3.5" />
        {memoryStatus || t('status.ready')}
      </span>
    </div>
  );
}
