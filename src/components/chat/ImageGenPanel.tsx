'use client';

import { useState, useRef } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { ImageIcon, WandIcon, SparkIcon } from '@/components/ui/icons';

interface Props {
  conversationId: string | null;
  messageId?: string;
  onImageGenerated: (imageUrl: string, prompt: string) => void;
  onClose: () => void;
}

/**
 * 生图面板 — 支持手动输入 prompt 或 AI 自动生成
 */
export default function ImageGenPanel({ conversationId, messageId, onImageGenerated, onClose }: Props) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [userHint, setUserHint] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // AI 自动生成 prompt
  const handleAiGenerate = async () => {
    if (!conversationId) {
      setError(t('imageGen.noConversation'));
      return;
    }
    setAiGenerating(true);
    setError('');
    try {
      const res = await fetch('/api/image-gen/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, message_id: messageId || undefined, user_hint: userHint || undefined }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setPrompt(data.prompt || '');
        setNegativePrompt(data.negative_prompt || '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成 prompt 失败');
    } finally {
      setAiGenerating(false);
    }
  };

  // 执行生图
  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError(t('imageGen.emptyPrompt'));
      return;
    }
    setGenerating(true);
    setError('');
    setPreviewUrl(null);
    try {
      const res = await fetch('/api/image-gen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          negative_prompt: negativePrompt.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else if (data.url) {
        setPreviewUrl(data.url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生图失败');
    } finally {
      setGenerating(false);
    }
  };

  // 发送到聊天
  const handleSendToChat = () => {
    if (previewUrl) {
      onImageGenerated(previewUrl, prompt);
      setPreviewUrl(null);
      setPrompt('');
      setNegativePrompt('');
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-lg rounded-3xl border border-border-light bg-white/95 p-5 shadow-2xl backdrop-blur-xl dark:bg-[rgba(30,25,45,0.95)]"
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent-dark">
              <ImageIcon className="h-4.5 w-4.5" />
            </div>
            <h3 className="text-base font-semibold text-text-primary">{t('imageGen.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-text-muted transition-colors hover:bg-accent/8 hover:text-text-primary"
          >
            ✕
          </button>
        </div>

        {/* AI 提示输入 */}
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('imageGen.aiHint')}</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={userHint}
              onChange={e => setUserHint(e.target.value)}
              placeholder={t('imageGen.aiHintPlaceholder')}
              className="input-rich flex-1 text-sm"
            />
            <button
              onClick={handleAiGenerate}
              disabled={aiGenerating || !conversationId}
              className="soft-button soft-button-secondary shrink-0 gap-1.5 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <WandIcon className="h-3.5 w-3.5" />
              {aiGenerating ? t('imageGen.aiGenerating') : t('imageGen.aiGenerate')}
            </button>
          </div>
        </div>

        {/* 正面 prompt */}
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('imageGen.prompt')}</label>
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="1girl, long hair, purple eyes, school uniform, sitting, window, sunlight..."
            rows={3}
            className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm shadow-none focus:ring-1 focus:ring-accent/30 dark:bg-white/5"
          />
        </div>

        {/* 负面 prompt */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('imageGen.negativePrompt')}</label>
          <textarea
            value={negativePrompt}
            onChange={e => setNegativePrompt(e.target.value)}
            placeholder="lowres, bad anatomy, bad hands..."
            rows={2}
            className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm shadow-none focus:ring-1 focus:ring-accent/30 dark:bg-white/5"
          />
        </div>

        {/* 错误提示 */}
        {error && (
          <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">{error}</p>
        )}

        {/* 预览图 */}
        {previewUrl && (
          <div className="mb-4 overflow-hidden rounded-2xl border border-border-light">
            <img src={previewUrl} alt="Generated" className="w-full" loading="lazy" />
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-2">
          {previewUrl && (
            <button
              onClick={handleSendToChat}
              className="soft-button soft-button-primary gap-1.5 px-4 text-sm"
            >
              <SparkIcon className="h-3.5 w-3.5" />
              {t('imageGen.sendToChat')}
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
            className="soft-button soft-button-primary gap-1.5 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            {generating ? t('imageGen.generating') : t('imageGen.generate')}
          </button>
        </div>
      </div>
    </div>
  );
}
