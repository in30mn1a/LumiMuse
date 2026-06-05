import { NextRequest, NextResponse } from 'next/server';
import { loadSettings } from '@/lib/settings';
import { ImageGenSettings, DEFAULT_IMAGE_GEN_SETTINGS } from '@/types';
import { safeFetch } from '@/lib/ssrf-guard';
import { formatZodFieldErrors, imageGenBodySchema } from '@/lib/schemas';
import { writeFile, mkdir } from 'fs/promises';
import JSZip from 'jszip';
import path from 'path';
import { v4 as uuid } from 'uuid';

/**
 * 生图 API — 支持 SD WebUI / NovelAI / ComfyUI / 自定义（DALL-E 兼容）
 * POST body: { prompt: string; negative_prompt?: string; override?: Partial<ImageGenSettings> }
 * 返回: { url: string } 或 { error: string }
 */

// ===== 安全限制常量 =====
/** 单张图片最大字节数（含解码后的 base64 与远程下载），超过则拒绝以避免 OOM */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
/** ComfyUI 自定义工作流 JSON 字符串的最大字节数（UTF-8 编码后） */
const MAX_COMFYUI_WORKFLOW_SIZE = 64 * 1024; // 64KB

type ImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * 校验图片 magic bytes，识别 PNG / JPEG / WEBP。
 * 失败时返回 null，调用方应据此拒绝写入。
 */
function detectImageFormat(buffer: Buffer | Uint8Array): ImageFormat | null {
  if (buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  // WEBP: 'RIFF' .. .. .. .. 'WEBP'
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

/** 根据 magic bytes 返回对应的文件扩展名 */
function extForFormat(fmt: ImageFormat): string {
  return fmt === 'jpeg' ? 'jpg' : fmt;
}

// 确保生图输出目录存在
async function ensureOutputDir(): Promise<string> {
  const dir = path.join(process.cwd(), 'public', 'generated');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 抓取远端图片，统一执行：
 *   1. Content-Length 预检（若上游返回该头，>maxSize 直接拒绝，避免下载大体积响应）
 *   2. 读 arrayBuffer 后再校验实际字节数（防止上游不返回 Content-Length 或伪报）
 *
 * 不做 magic bytes 校验——交给调用方决定是否需要（部分场景可能是 zip 等非图片二进制）。
 */
async function safeFetchImage(
  url: string,
  maxSize: number,
  init?: Parameters<typeof safeFetch>[1],
): Promise<{ buffer: Buffer; contentType: string; response: Response }> {
  const response = await safeFetch(url, init);
  if (!response.ok) {
    throw new Error(`下载图片失败: ${response.status}`);
  }
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxSize) {
      throw new Error(`响应体过大: ${declared} 字节超过上限 ${maxSize}`);
    }
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxSize) {
    throw new Error(`响应体过大: ${arrayBuffer.byteLength} 字节超过上限 ${maxSize}`);
  }
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') || '',
    response,
  };
}

/**
 * 将一段已经在内存里的 buffer 落地为生图文件：校验大小 + magic bytes，
 * 通过则按真实格式写入，并返回可访问 URL。
 */
async function persistImageBuffer(buffer: Buffer | Uint8Array): Promise<string> {
  if (buffer.length === 0) {
    throw new Error('图片数据为空');
  }
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error(`图片过大: ${buffer.length} 字节超过上限 ${MAX_IMAGE_SIZE}`);
  }
  const fmt = detectImageFormat(buffer);
  if (!fmt) {
    throw new Error('未识别的图片格式（仅支持 PNG / JPEG / WEBP）');
  }
  const dir = await ensureOutputDir();
  const filename = `${uuid()}.${extForFormat(fmt)}`;
  const filepath = path.join(dir, filename);
  await writeFile(filepath, buffer);
  return `/api/files/generated/${filename}`;
}

// 保存 base64 图片到本地（自动按 magic bytes 选择扩展名 + 大小限制）
async function saveBase64Image(base64: string): Promise<string> {
  // 提前估算解码后大小，避免对超大 base64 字符串先解码再丢弃
  // base64 每 4 字符约对应 3 字节
  const approxDecodedSize = Math.floor((base64.length * 3) / 4);
  if (approxDecodedSize > MAX_IMAGE_SIZE) {
    throw new Error(`图片过大: 约 ${approxDecodedSize} 字节超过上限 ${MAX_IMAGE_SIZE}`);
  }
  const buffer = Buffer.from(base64, 'base64');
  return persistImageBuffer(buffer);
}

// 保存远程图片 URL 到本地（远端 URL 必须经过 SSRF 校验，避免恶意 ComfyUI/custom 输出指向内网）
async function saveRemoteImage(imageUrl: string, init?: Parameters<typeof safeFetch>[1]): Promise<string> {
  const { buffer } = await safeFetchImage(imageUrl, MAX_IMAGE_SIZE, init);
  return persistImageBuffer(buffer);
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

  const response = await safeFetch('https://image.novelai.net/ai/generate-image', {
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

  // 大小预检：NAI 可能返回 zip（多张图）或单张 png，zip 体积通常 < 10MB，
  // 这里仍然按 MAX_IMAGE_SIZE 限制响应体本身，避免恶意/异常上游打爆内存
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_IMAGE_SIZE) {
      throw new Error(`NovelAI 响应过大: ${declared} 字节超过上限 ${MAX_IMAGE_SIZE}`);
    }
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
    throw new Error(`NovelAI 响应过大: ${arrayBuffer.byteLength} 字节超过上限 ${MAX_IMAGE_SIZE}`);
  }
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
    // 用 jszip 解析（替代手写 Local File Header 解析）：自动处理多文件、ZIP64、不同压缩方式等边界情况
    const zip = await JSZip.loadAsync(arrayBuffer);
    // NAI 返回的 zip 通常只含一张 png；取第一个非目录条目
    const firstEntry = Object.values(zip.files).find(f => !f.dir);
    if (!firstEntry) {
      throw new Error('NovelAI zip 中未找到图片文件');
    }
    const fileData = await firstEntry.async('nodebuffer');
    console.log('[image-gen/nai] 从 zip 解压成功, 文件名:', firstEntry.name, '解压后大小:', fileData.length);
    // persistImageBuffer 会做 magic bytes + 大小校验
    return persistImageBuffer(fileData);
  }

  // 非 zip：直接当作图片二进制处理，由 persistImageBuffer 识别 PNG / JPEG / WEBP
  // 无法识别时抛出明确错误，不再静默兜底写入未知二进制（防止把错误页/HTML 当图片落地）
  return persistImageBuffer(Buffer.from(arrayBuffer));
}

// ========== ComfyUI ==========
async function generateComfyUI(
  prompt: string,
  negativePrompt: string,
  cfg: ImageGenSettings,
  signal?: AbortSignal,
): Promise<string> {
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
    // 客户端断连时立即中止轮询，避免继续 hammer ComfyUI
    if (signal?.aborted) {
      throw new Error('ComfyUI 轮询被客户端中止');
    }
    await new Promise(r => setTimeout(r, 2000));
    if (signal?.aborted) {
      throw new Error('ComfyUI 轮询被客户端中止');
    }
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

  // 下载第一张图片（saveRemoteImage 已内置大小 + magic bytes 校验）
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
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = imageGenBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 }
    );
  }

  const { prompt = '', negative_prompt, override } = parsed.data as {
    prompt?: string;
    negative_prompt?: string;
    override?: Partial<ImageGenSettings>;
  };

  try {
    if (!prompt) {
      return NextResponse.json({ error: '缺少 prompt' }, { status: 400 });
    }

    const settings = loadSettings();
    const imgCfg: ImageGenSettings = { ...DEFAULT_IMAGE_GEN_SETTINGS, ...settings.image_gen, ...override };

    if (!imgCfg.enabled) {
      return NextResponse.json({ error: '生图功能未启用，请先在设置中开启' }, { status: 400 });
    }

    // L5: ComfyUI 工作流大小限制——避免恶意/异常 override 传入数 MB 的 JSON
    // 仅对实际会用到的引擎做校验，其他引擎即便误带超长 workflow 也无影响
    if (imgCfg.engine === 'comfyui' && imgCfg.comfyui_workflow) {
      const workflowBytes = Buffer.byteLength(imgCfg.comfyui_workflow, 'utf8');
      if (workflowBytes > MAX_COMFYUI_WORKFLOW_SIZE) {
        return NextResponse.json(
          {
            error: `ComfyUI 工作流过大: ${workflowBytes} 字节超过上限 ${MAX_COMFYUI_WORKFLOW_SIZE}`,
          },
          { status: 400 },
        );
      }
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
        url = await generateComfyUI(prompt, negative_prompt || '', imgCfg, request.signal);
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
