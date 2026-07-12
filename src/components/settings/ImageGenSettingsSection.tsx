'use client';

import { useState } from 'react';
import { ArtistString, DEFAULT_IMAGE_GEN_SETTINGS, ImageGenSettings, Settings } from '@/types';
import { ImageIcon } from '@/components/ui/icons';

// ========== 生图设置子组件 ==========
export function ImageGenSettingsSection({
  settings,
  update,
  parseNumber,
  t,
}: {
  settings: Settings;
  update: <K extends 'image_gen' | 'artist_strings'>(key: K, value: Settings[K]) => void;
  parseNumber: (v: string) => number;
  t: (key: string) => string;
}) {
  const imgGen = settings.image_gen || DEFAULT_IMAGE_GEN_SETTINGS;

  const updateImg = <K extends keyof ImageGenSettings>(key: K, value: ImageGenSettings[K]) => {
    update('image_gen', { ...imgGen, [key]: value });
  };

  // 画师串预设管理
  const artistStrings: ArtistString[] = settings.artist_strings || [];
  const [selectedPresetId, setSelectedPresetId] = useState('');

  // 同步预设选中状态：当外部传入的 nai_artist_tags 变化时（例如设置异步加载完成、
  // 或别处更新了画师串），用渲染期 setState 反查匹配的预设并选中。
  // 这是 React 18+ 官方推荐的"由 props 派生 state"模式（见 react.dev/reference/react/useState
  // 中 "Storing information from previous renders" 一节），等价于在同一 render pass
  // 内重新渲染，不会触发 effect 的级联渲染告警，也不需要 useEffect/useRef 配合。
  const [lastSyncedTags, setLastSyncedTags] = useState<string | null>(null);
  if (imgGen.nai_artist_tags !== lastSyncedTags) {
    setLastSyncedTags(imgGen.nai_artist_tags);
    const trimmed = imgGen.nai_artist_tags.trim();
    if (trimmed && artistStrings.length > 0) {
      const matched = artistStrings.find(a => a.tags === imgGen.nai_artist_tags);
      // 只在找到匹配预设时同步 selectedPresetId；找不到时不清空，保留用户已有选择，
      // 由 handleArtistTagsChange 在用户手动改 tags 时显式清空。
      if (matched && matched.id !== selectedPresetId) {
        setSelectedPresetId(matched.id);
      }
    }
  }

  const [presetName, setPresetName] = useState('');

  const handleSelectPreset = (id: string) => {
    if (!id) { setSelectedPresetId(''); return; }
    const preset = artistStrings.find(a => a.id === id);
    if (preset) {
      setSelectedPresetId(id);
      updateImg('nai_artist_tags', preset.tags);
    }
  };

  const handleSaveAsPreset = () => {
    const name = presetName.trim() || window.prompt(t('settings.artistStringsNamePrompt'));
    if (!name) return;
    const newPreset: ArtistString = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      tags: imgGen.nai_artist_tags,
    };
    update('artist_strings', [...artistStrings, newPreset]);
    setSelectedPresetId(newPreset.id);
    setPresetName('');
  };

  const handleUpdatePreset = () => {
    if (!selectedPresetId) return;
    update('artist_strings', artistStrings.map(a =>
      a.id === selectedPresetId ? { ...a, tags: imgGen.nai_artist_tags } : a
    ));
  };

  const handleDeletePreset = () => {
    if (!selectedPresetId) return;
    if (!window.confirm(t('settings.artistStringsDeleteConfirm'))) return;
    update('artist_strings', artistStrings.filter(a => a.id !== selectedPresetId));
    setSelectedPresetId('');
  };

  const handleArtistTagsChange = (value: string) => {
    updateImg('nai_artist_tags', value);
    if (selectedPresetId) setSelectedPresetId('');
  };

  return (
    <section className="surface-panel p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent-dark">
          <ImageIcon className="h-4 w-4" />
        </div>
        <h2 className="section-title text-lg">{t('settings.imageGen')}</h2>
      </div>

      <div className="space-y-3">
        {/* 启用开关 */}
        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={imgGen.enabled}
            onChange={e => updateImg('enabled', e.target.checked)}
          />
          {t('settings.imageGenEnabled')}
        </label>

        {imgGen.enabled && (
          <>
            {/* 引擎选择 */}
            <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
              <label htmlFor="settings-image-engine" className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.imageGenEngine')}</label>
              <select
                id="settings-image-engine"
                value={imgGen.engine}
                onChange={e => updateImg('engine', e.target.value as ImageGenSettings['engine'])}
                className="select-rich"
              >
                <option value="sd">{t('settings.imageGenSD')}</option>
                <option value="nai">{t('settings.imageGenNAI')}</option>
                <option value="comfyui">{t('settings.imageGenComfyUI')}</option>
                <option value="custom">{t('settings.imageGenCustom')}</option>
              </select>
            </div>

            {/* SD WebUI 配置 */}
            {imgGen.engine === 'sd' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label htmlFor="settings-image-sd-url" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDUrl')}</label>
                  <input id="settings-image-sd-url" value={imgGen.sd_url} onChange={e => updateImg('sd_url', e.target.value)} className="input-rich" placeholder="http://127.0.0.1:7860" />
                </div>
                <div>
                  <label htmlFor="settings-image-sd-sampler" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDSampler')}</label>
                  <input id="settings-image-sd-sampler" value={imgGen.sd_sampler} onChange={e => updateImg('sd_sampler', e.target.value)} className="input-rich" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="settings-image-sd-steps" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDSteps')}</label>
                    <input id="settings-image-sd-steps" type="number" min="1" max="150" value={imgGen.sd_steps} onChange={e => updateImg('sd_steps', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label htmlFor="settings-image-sd-cfg" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDCfg')}</label>
                    <input id="settings-image-sd-cfg" type="number" min="1" max="30" step="0.5" value={imgGen.sd_cfg_scale} onChange={e => updateImg('sd_cfg_scale', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="settings-image-sd-width" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDWidth')}</label>
                    <input id="settings-image-sd-width" type="number" min="256" max="2048" step="64" value={imgGen.sd_width} onChange={e => updateImg('sd_width', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label htmlFor="settings-image-sd-height" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDHeight')}</label>
                    <input id="settings-image-sd-height" type="number" min="256" max="2048" step="64" value={imgGen.sd_height} onChange={e => updateImg('sd_height', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div>
                  <label htmlFor="settings-image-sd-negative" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDNeg')}</label>
                  <textarea id="settings-image-sd-negative" value={imgGen.sd_negative_prompt} onChange={e => updateImg('sd_negative_prompt', e.target.value)} rows={2} className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm" />
                </div>
              </div>
            )}

            {/* NovelAI 配置 */}
            {imgGen.engine === 'nai' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label htmlFor="settings-image-nai-key" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIKey')}</label>
                  <input id="settings-image-nai-key" type="password" value={imgGen.nai_api_key} onChange={e => updateImg('nai_api_key', e.target.value)} className="input-rich" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="settings-image-nai-model" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIModel')}</label>
                    <select id="settings-image-nai-model" value={imgGen.nai_model} onChange={e => updateImg('nai_model', e.target.value)} className="select-rich">
                      <option value="nai-diffusion-4-5-full">NAI Diffusion 4.5 Full</option>
                      <option value="nai-diffusion-4-5-curated">NAI Diffusion 4.5 Curated</option>
                      <option value="nai-diffusion-4-full">NAI Diffusion 4 Full</option>
                      <option value="nai-diffusion-4-curated-preview">NAI Diffusion 4 Curated</option>
                      <option value="nai-diffusion-3">NAI Diffusion 3 (Anime V3)</option>
                      <option value="nai-diffusion-furry-3">NAI Diffusion Furry V3</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="settings-image-nai-sampler" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAISampler')}</label>
                    <select id="settings-image-nai-sampler" value={imgGen.nai_sampler} onChange={e => updateImg('nai_sampler', e.target.value)} className="select-rich">
                      <option value="k_euler_ancestral">Euler Ancestral</option>
                      <option value="k_euler">Euler</option>
                      <option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option>
                      <option value="k_dpmpp_2m">DPM++ 2M</option>
                      <option value="k_dpmpp_sde">DPM++ SDE</option>
                      <option value="ddim_v3">DDIM</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor="settings-image-nai-noise-schedule" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAINoiseSchedule')}</label>
                  <select id="settings-image-nai-noise-schedule" value={imgGen.nai_noise_schedule} onChange={e => updateImg('nai_noise_schedule', e.target.value)} className="select-rich">
                    <option value="karras">Karras</option>
                    <option value="exponential">Exponential</option>
                    <option value="polyexponential">Polyexponential</option>
                    <option value="native">Native</option>
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="settings-image-nai-steps" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAISteps')}</label>
                    <input id="settings-image-nai-steps" type="number" min="1" max="50" value={imgGen.nai_steps} onChange={e => updateImg('nai_steps', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label htmlFor="settings-image-nai-scale" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIScale')}</label>
                    <input id="settings-image-nai-scale" type="number" min="0" max="25" step="0.1" value={imgGen.nai_scale} onChange={e => updateImg('nai_scale', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label htmlFor="settings-image-nai-cfg-rescale" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAICfgRescale')}</label>
                    <input id="settings-image-nai-cfg-rescale" type="number" min="0" max="1" step="0.01" value={imgGen.nai_cfg_rescale} onChange={e => updateImg('nai_cfg_rescale', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="settings-image-nai-width" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIWidth')}</label>
                    <input id="settings-image-nai-width" type="number" min="256" max="2048" step="64" value={imgGen.nai_width} onChange={e => updateImg('nai_width', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label htmlFor="settings-image-nai-height" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIHeight')}</label>
                    <input id="settings-image-nai-height" type="number" min="256" max="2048" step="64" value={imgGen.nai_height} onChange={e => updateImg('nai_height', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div>
                  <label htmlFor="settings-image-nai-artist-tags" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIArtist')}</label>
                  <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.imageGenNAIArtistHint')}</p>
                  {/* 画师串预设管理 */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <select
                        value={selectedPresetId}
                        onChange={e => handleSelectPreset(e.target.value)}
                        className="select-rich flex-1"
                      >
                        <option value="">{t('settings.artistStringsCustom')}</option>
                        {artistStrings.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      id="settings-image-nai-artist-tags"
                      value={imgGen.nai_artist_tags}
                      onChange={e => handleArtistTagsChange(e.target.value)}
                      rows={2}
                      className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 flex-1">
                        <input
                          value={presetName}
                          onChange={e => setPresetName(e.target.value)}
                          placeholder={t('settings.artistStringsNamePrompt')}
                          className="input-rich flex-1 text-xs"
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveAsPreset(); }}
                        />
                        <button
                          type="button"
                          onClick={handleSaveAsPreset}
                          disabled={!imgGen.nai_artist_tags.trim()}
                          className="rounded-lg bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent-dark hover:bg-accent/20 transition disabled:opacity-40"
                        >
                          {t('settings.artistStringsSaveAs')}
                        </button>
                      </div>
                      {selectedPresetId && (
                        <>
                          <button
                            type="button"
                            onClick={handleUpdatePreset}
                            className="rounded-lg bg-blue-100 px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-200 transition"
                          >
                            {t('settings.artistStringsUpdate')}
                          </button>
                          <button
                            type="button"
                            onClick={handleDeletePreset}
                            className="rounded-lg bg-red-100 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-200 transition"
                          >
                            {t('settings.artistStringsDelete')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div>
                  <label htmlFor="settings-image-nai-negative" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAINeg')}</label>
                  <textarea id="settings-image-nai-negative" value={imgGen.nai_negative_prompt} onChange={e => updateImg('nai_negative_prompt', e.target.value)} rows={2} className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm" />
                </div>
              </div>
            )}

            {/* ComfyUI 配置 */}
            {imgGen.engine === 'comfyui' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label htmlFor="settings-image-comfy-url" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenComfyUrl')}</label>
                  <input id="settings-image-comfy-url" value={imgGen.comfyui_url} onChange={e => updateImg('comfyui_url', e.target.value)} className="input-rich" placeholder="http://127.0.0.1:8188" />
                </div>
                <div>
                  <label htmlFor="settings-image-comfy-workflow" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenComfyWorkflow')}</label>
                  <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.imageGenComfyWorkflowHint')}</p>
                  <textarea id="settings-image-comfy-workflow" value={imgGen.comfyui_workflow} onChange={e => updateImg('comfyui_workflow', e.target.value)} rows={4} className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 font-mono text-xs" />
                </div>
              </div>
            )}

            {/* 自定义 API 配置 */}
            {imgGen.engine === 'custom' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label htmlFor="settings-image-custom-url" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomUrl')}</label>
                  <input id="settings-image-custom-url" value={imgGen.custom_url} onChange={e => updateImg('custom_url', e.target.value)} className="input-rich" placeholder="https://api.openai.com/v1/images/generations" />
                </div>
                <div>
                  <label htmlFor="settings-image-custom-key" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomKey')}</label>
                  <input id="settings-image-custom-key" type="password" value={imgGen.custom_api_key} onChange={e => updateImg('custom_api_key', e.target.value)} className="input-rich" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="settings-image-custom-model" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomModel')}</label>
                    <input id="settings-image-custom-model" value={imgGen.custom_model} onChange={e => updateImg('custom_model', e.target.value)} className="input-rich" placeholder="dall-e-3" />
                  </div>
                  <div>
                    <label htmlFor="settings-image-custom-size" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomSize')}</label>
                    <input id="settings-image-custom-size" value={imgGen.custom_size} onChange={e => updateImg('custom_size', e.target.value)} className="input-rich" placeholder="1024x1024" />
                  </div>
                </div>
              </div>
            )}

            {/* 通用设置 */}
            <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
              <label htmlFor="settings-image-quality" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenQuality')}</label>
              <input id="settings-image-quality" value={imgGen.quality_tags} onChange={e => updateImg('quality_tags', e.target.value)} className="input-rich" />
            </div>

            {/* 出图总时限：适用于所有引擎的提交、等待与下载阶段 */}
            <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
              <label htmlFor="settings-image-timeout" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenTimeout')}</label>
              <input
                id="settings-image-timeout"
                type="number"
                min="1000"
                step="1000"
                value={imgGen.generate_timeout_ms}
                onChange={e => updateImg('generate_timeout_ms', parseNumber(e.target.value))}
                className="input-rich"
                placeholder="120000"
              />
              <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('settings.imageGenTimeoutHint')}</p>
            </div>

            {/* 内联提示词：聊天回复附带生图提示词 */}
            <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={imgGen.inline_prompt}
                onChange={e => updateImg('inline_prompt', e.target.checked)}
              />
              {t('settings.imageGenInlinePrompt')}
            </label>
            <p className="px-4 text-xs leading-relaxed text-text-muted">{t('settings.imageGenInlinePromptHint')}</p>

            {/* 自动生图 */}
            <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={imgGen.auto_generate}
                onChange={e => updateImg('auto_generate', e.target.checked)}
              />
              {t('settings.imageGenAuto')}
            </label>
            <p className="px-4 text-xs leading-relaxed text-text-muted">{t('settings.imageGenAutoHint')}</p>

            {imgGen.auto_generate && (
              <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <label htmlFor="settings-image-auto-keywords" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenAutoKeywords')}</label>
                <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.imageGenAutoKeywordsHint')}</p>
                <input
                  id="settings-image-auto-keywords"
                  value={imgGen.auto_generate_keywords}
                  onChange={e => updateImg('auto_generate_keywords', e.target.value)}
                  className="input-rich"
                  placeholder={t('settings.imageGenAutoKeywordsPlaceholder')}
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
