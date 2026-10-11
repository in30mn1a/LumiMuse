'use client';

import { useTranslation } from '@/lib/i18n-context';

interface CharacterAiGeneratorPanelProps {
  aiRequirement: string;
  aiGenerating: boolean;
  aiError: string;
  onChangeRequirement: (value: string) => void;
  onGenerate: () => void;
}

export function CharacterAiGeneratorPanel({
  aiRequirement,
  aiGenerating,
  aiError,
  onChangeRequirement,
  onGenerate,
}: CharacterAiGeneratorPanelProps) {
  const { t } = useTranslation();

  return (
    <div
      data-role="aiGeneratorPanel"
      className="mt-4 flex w-full flex-col gap-2 rounded-2xl border border-border-light bg-white/70 p-3 shadow-sm lg:ml-auto lg:max-w-[38rem] lg:self-end"
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={aiRequirement}
          onChange={e => onChangeRequirement(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onGenerate();
            }
          }}
          disabled={aiGenerating}
          className="input-rich min-w-0 flex-1"
          placeholder={t('editor.aiRequirementPlaceholder')}
        />
        <button
          type="button"
          onClick={onGenerate}
          disabled={aiGenerating || !aiRequirement.trim()}
          className="soft-button soft-button-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {aiGenerating ? t('editor.aiGenerating') : t('editor.aiApplyHint')}
        </button>
      </div>
      {aiError && <p className="text-xs text-danger">{aiError}</p>}
    </div>
  );
}
