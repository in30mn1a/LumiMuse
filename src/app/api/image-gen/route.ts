import { NextRequest, NextResponse } from 'next/server';
import { loadSettings } from '@/lib/settings';
import { ImageGenSettings, DEFAULT_IMAGE_GEN_SETTINGS } from '@/types';
import { safeFetch } from '@/lib/ssrf-guard';
import { writeFile, mkdir } from 'fs/promises';
import { inflateRawSync } from 'zlib';
import path from 'path';
import { v4 as uuid } from 'uuid';

/**
 * 生图 API — 支持 SD WebUI / NovelAI / ComfyUI / 自定义（DALL-E 兼容）
 * POST body: { prompt: string; negative_prompt?: string; override?: Partial<ImageGenSettings> }
 * 返回: { url: string } 或 { error: string }
 */

// 确保生图输出目录存在
async function ensureOutputDir(): Promise<string> {
  const dir = path.join(process.cwd(), 'public', 'generated');
  await mkdir(dir, { recursive: true });
  return dir;
}

// 保存 base64 图片到本地
async function saveBase64Image(base64: string): Promise<string> {
  const dir = await ensureOutputDir();
  const filename = `${uuid()}.png`;
  const filepath = path.join(dir, filename);
  const buffer = Buffer.from(base64, 'base64');
  await writeFile(filepath, buffer);
  return `/api/files/generated/${filename}`;
}

// 保存远程图片 URL 到本地（远端 URL 必须经过 SSRF 校验，避免恶意 ComfyUI/custom 输出指向内网）
async function saveRemoteImage(imageUrl: string): Promise<string> {
  const dir = await ensureOutputDir();
  const filename = `${uuid()}.png`;
  const filepath = path.join(dir, filename);
  const response = await safeFetch(imageUrl);
  if (!response.ok) throw new Error(`下载图片失败: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filepath, buffer);
  return `/api/files/generated/${filename}`;
}

// ========== SD WebUI ==========
async function generateSD(prompt: string, negativePrompt: string, cfg: ImageGenSettings): Promise<string> {
  const fullPrompt = cfg.quality_tags ? `${cfg.quality_tags}, ${prompt}` : prompt;
  const fullNeg = negativePrompt || cfg.sd_negative_prompt;

  const body = {
    prompt: fullPrompt,
    negative_prompt: fullNeg,
    steps: cfg.sd_steps,
    cfg_scale: cfg.sd_cfg_scale,
    width: cfg.sd_width,
    height: cfg.sd_height,
    sampler_name: cfg.sd_sampler,
    batch_size: 1,
    n_iter: 1,
  };

  const url = `${cfg.sd_url.replace(/\/$/, '')}/sdapi/v1/txt2img`;
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SD WebUI 错误 ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const base64 = data.images?.[0];
  if (!base64) throw new Error('SD WebUI 未返回图片');

  return saveBase64Image(base64);
}

// ========== NovelAI ==========
async function generateNAI(prompt: string, negativePrompt: string, cfg: ImageGenSettings): Promise<string> {
  // 画师串放在最前面
  let fullPrompt = '';
  if (cfg.nai_artist_tags) {
    fullPrompt += cfg.nai_artist_tags + ', ';
  }
  if (cfg.quality_tags) {
    fullPrompt += cfg.quality_tags + ', ';
  }
  fullPrompt += prompt;

  const fullNeg = negativePrompt || cfg.nai_negative_prompt;
  const model = cfg.nai_model;
  const isV4 = model.includes('4');

  // 构建请求体
  const parameters: Record<string, unknown> = {
    width: cfg.nai_width,
    height: cfg.nai_height,
    scale: cfg.nai_scale,
    cfg_rescale: cfg.nai_cfg_rescale,
    sampler: cfg.nai_sampler,
    noise_schedule: cfg.nai_noise_schedule,
    steps: cfg.nai_steps,
    n_samples: 1,
    ucPreset: 0,
    negative_prompt: fullNeg,
    seed: Math.floor(Math.random() * 2 ** 32),
    extra_noise_seed: Math.floor(Math.random() * 2 ** 32),
  };

  // V4/V4.5 模型需要额外参数
  if (isV4) {
    parameters.params_version = 3;
    parameters.legacy = false;
    parameters.prefer_brownian = true;
    parameters.quality_toggle = true;
    parameters.autoSmea = true;
    parameters.dynamic_thresholding = false;
    parameters.v4_prompt = {
      caption: {
        base_caption: fullPrompt,
        char_captions: [],
      },
      use_coords: false,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: {
        base_caption: fullNeg,
        char_captions: [],
      },
      use_coords: false,
      use_order: false,
    };
    // V4.5 特有参数
    if (model.includes('4-5')) {
      parameters.skip_cfg_above_sigma = null;
    }
  }

  const body = {
    input: fullPrompt,
    model: model,
    action: 'generate',
    parameters,
  };

  const response = await fetch('https://image.novelai.net/ai/generate-image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.nai_api_key}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NovelAI 错误 ${response.status}: ${text.slice(0, 300)}`);
  }

  // NAI 返回 zip 格式，里面有一张 png
  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = JSON.parse(new TextDecoder().decode(arrayBuffer));
    if (data.output?.[0]) {
      return saveBase64Image(data.output[0]);
    }
  }

  const uint8 = new Uint8Array(arrayBuffer);

  // 检查是否是 zip 格式（PK 签名: 50 4B 03 04）
  const isZip = uint8[0] === 0x50 && uint8[1] === 0x4B && uint8[2] === 0x03 && uint8[3] === 0x04;

  if (isZip) {
    // 解析 zip Local File Header
    // offset 8: compression method (2 bytes LE) — 0=stored, 8=deflate
    const compressionMethod = uint8[8] | (uint8[9] << 8);
    // offset 18: compressed size (4 bytes LE)
    const compressedSize = uint8[18] | (uint8[19] << 8) | (uint8[20] << 16) | (uint8[21] << 24);
    // offset 26: filename length (2 bytes LE)
    const filenameLen = uint8[26] | (uint8[27] << 8);
    // offset 28: extra field length (2 bytes LE)
    const extraLen = uint8[28] | (uint8[29] << 8);
    // 文件数据起始位置
    const dataStart = 30 + filenameLen + extraLen;
    const dataEnd = compressedSize > 0 ? dataStart + compressedSize : uint8.length;
    const compressedData = uint8.slice(dataStart, dataEnd);

    let fileData: Buffer;
    if (compressionMethod === 0) {
      // stored（未压缩），直接使用
      fileData = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      // deflate 压缩，用 inflateRawSync 解压
      fileData = inflateRawSync(Buffer.from(compressedData));
    } else {
      throw new Error(`NovelAI zip 使用了不支持的压缩方式: ${compressionMethod}`);
    }

    const dir = await ensureOutputDir();
    const filename = `${uuid()}.png`;
    const filepath = path.join(dir, filename);
    await writeFile(filepath, fileData);
    console.log('[image-gen/nai] 从 zip 解压成功, 压缩方式:', compressionMethod, '解压后大小:', fileData.length);
    return `/api/files/generated/${filename}`;
  }

  // 不是 zip，检查是否直接是 PNG
  if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) {
    const dir = await ensureOutputDir();
    const filename = `${uuid()}.png`;
    const filepath = path.join(dir, filename);
    await writeFile(filepath, Buffer.from(arrayBuffer));
    return `/api/files/generated/${filename}`;
  }

  // 兜底
  if (arrayBuffer.byteLength > 1000) {
    const dir = await ensureOutputDir();
    const filename = `${uuid()}.png`;
    const filepath = path.join(dir, filename);
    await writeFile(filepath, Buffer.from(arrayBuffer));
    return `/api/files/generated/${filename}`;
  }

  throw new Error(`NovelAI 返回格式无法解析 (content-type: ${contentType}, size: ${arrayBuffer.byteLength})`);
}

// ========== ComfyUI ==========
async function generateComfyUI(prompt: string, negativePrompt: string, cfg: ImageGenSettings): Promise<string> {
  const fullPrompt = cfg.quality_tags ? `${cfg.quality_tags}, ${prompt}` : prompt;

  // 使用默认的简单工作流或用户自定义工作流
  let workflow: Record<string, unknown>;
  if (cfg.comfyui_workflow) {
    try {
      workflow = JSON.parse(cfg.comfyui_workflow);
      // 替换 prompt 占位符
      const workflowStr = JSON.stringify(workflow)
        .replace(/\{\{positive_prompt\}\}/g, fullPrompt.replace(/"/g, '\\"'))
        .replace(/\{\{negative_prompt\}\}/g, (negativePrompt || cfg.sd_negative_prompt).replace(/"/g, '\\"'));
      workflow = JSON.parse(workflowStr);
    } catch {
      throw new Error('ComfyUI 工作流 JSON 格式错误');
    }
  } else {
    // 默认简单文生图工作流
    workflow = buildDefaultComfyWorkflow(fullPrompt, negativePrompt || cfg.sd_negative_prompt, cfg);
  }

  const baseUrl = cfg.comfyui_url.replace(/\/$/, '');

  // 提交任务
  const queueRes = await safeFetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!queueRes.ok) {
    const text = await queueRes.text();
    throw new Error(`ComfyUI 提交失败 ${queueRes.status}: ${text.slice(0, 200)}`);
  }

  const { prompt_id } = await queueRes.json();

  // 轮询等待完成（最多 120 秒）
  const maxWait = 120_000;
  const start = Date.now();
  let outputImages: { filename: string; subfolder: string; type: string }[] = [];

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 2000));
    const historyRes = await safeFetch(`${baseUrl}/history/${prompt_id}`);
    if (!historyRes.ok) continue;
    const history = await historyRes.json();
    const result = history[prompt_id];
    if (!result) continue;
    if (result.status?.status_str === 'error') {
      throw new Error('ComfyUI 生成失败');
    }
    // 查找输出图片
    const outputs = result.outputs || {};
    for (const nodeId of Object.keys(outputs)) {
      const nodeOutput = outputs[nodeId];
      if (nodeOutput.images && nodeOutput.images.length > 0) {
        outputImages = nodeOutput.images;
        break;
      }
    }
    if (outputImages.length > 0) break;
  }

  if (outputImages.length === 0) {
    throw new Error('ComfyUI 生成超时或无输出');
  }

  // 下载第一张图片
  const img = outputImages[0];
  const imgUrl = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
  return saveRemoteImage(imgUrl);
}

function buildDefaultComfyWorkflow(prompt: string, negPrompt: string, cfg: ImageGenSettings): Record<string, unknown> {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 32),
        steps: cfg.sd_steps,
        cfg: cfg.sd_cfg_scale,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: cfg.sd_model || 'model.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: cfg.sd_width, height: cfg.sd_height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negPrompt, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'LumiMuse', images: ['8', 0] } },
  };
}

// ========== 自定义 API（兼容 OpenAI Images API 格式）==========
async function generateCustom(prompt: string, cfg: ImageGenSettings): Promise<string> {
  const fullPrompt = cfg.quality_tags ? `${cfg.quality_tags}, ${prompt}` : prompt;
  const url = cfg.custom_url.replace(/\/$/, '');

  const body: Record<string, unknown> = {
    model: cfg.custom_model,
    prompt: fullPrompt,
    n: 1,
    size: cfg.custom_size || '1024x1024',
    response_format: 'b64_json',
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.custom_api_key) {
    headers['Authorization'] = `Bearer ${cfg.custom_api_key}`;
  }

  const response = await safeFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`自定义 API 错误 ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();

  // 兼容 OpenAI 格式
  if (data.data?.[0]?.b64_json) {
    return saveBase64Image(data.data[0].b64_json);
  }
  if (data.data?.[0]?.url) {
    return saveRemoteImage(data.data[0].url);
  }
  // 兼容直接返回 base64 的格式
  if (data.images?.[0]) {
    return saveBase64Image(data.images[0]);
  }
  if (data.image) {
    return saveBase64Image(data.image);
  }

  throw new Error('自定义 API 返回格式无法解析');
}

// ========== 主路由 ==========
export async function POST(request: NextRequest) {
  try {
    const { prompt, negative_prompt, override } = await request.json() as {
      prompt: string;
      negative_prompt?: string;
      override?: Partial<ImageGenSettings>;
    };

    if (!prompt) {
      return NextResponse.json({ error: '缺少 prompt' }, { status: 400 });
    }

    const settings = loadSettings();
    const imgCfg: ImageGenSettings = { ...DEFAULT_IMAGE_GEN_SETTINGS, ...settings.image_gen, ...override };

    if (!imgCfg.enabled) {
      return NextResponse.json({ error: '生图功能未启用，请先在设置中开启' }, { status: 400 });
    }

    let url: string;

    switch (imgCfg.engine) {
      case 'sd':
        url = await generateSD(prompt, negative_prompt || '', imgCfg);
        break;
      case 'nai':
        url = await generateNAI(prompt, negative_prompt || '', imgCfg);
        break;
      case 'comfyui':
        url = await generateComfyUI(prompt, negative_prompt || '', imgCfg);
        break;
      case 'custom':
        url = await generateCustom(prompt, imgCfg);
        break;
      default:
        return NextResponse.json({ error: `不支持的引擎: ${imgCfg.engine}` }, { status: 400 });
    }

    return NextResponse.json({ url });
  } catch (err) {
    console.error('[image-gen] 生图失败:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '生图失败' },
      { status: 500 }
    );
  }
}
