import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

// 只允许安全的光栅图片格式，明确拒绝 svg（可含脚本）
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const ALLOWED_MIME_PREFIXES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_AVATAR_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 通过文件头部魔术字节识别真实图片格式。
 *
 * 依据：各图片格式标准固定头部
 *   - PNG : 89 50 4E 47 0D 0A 1A 0A          (RFC 2083)
 *   - JPEG: FF D8 FF                          (SOI marker)
 *   - GIF : 47 49 46 38 ("GIF8" — 87a/89a 共有前缀)
 *   - WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
 *           (RIFF 容器 + 4 字节大小 + "WEBP" fourCC)
 *
 * 仅校验 MIME / 扩展名容易被伪造（攻击者可把 .html 改名为 .png 上传），
 * 这里通过实际字节内容做最小限度的格式断言，作为 defense in depth。
 */
function detectImageType(buffer: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  // GIF: 47 49 46 38 ("GIF8")
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'gif';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'webp';
  }

  return null;
}

export async function POST(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || '0');
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: '文件过大（最大 10MB）' }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: '无效的 multipart 表单数据' }, { status: 400 });
  }
  const file = formData.get('avatar') as File | null;
  const purpose = formData.get('purpose') === 'attachment' ? 'attachment' : 'avatar';

  if (!file) {
    return NextResponse.json({ error: '未收到文件' }, { status: 400 });
  }

  // MIME 类型白名单校验
  if (!ALLOWED_MIME_PREFIXES.some(prefix => file.type === prefix)) {
    return NextResponse.json({ error: '只支持 PNG、JPG、WEBP、GIF 格式' }, { status: 400 });
  }

  // 扩展名白名单校验（防止 MIME 伪造）
  const rawExt = (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(rawExt)) {
    return NextResponse.json({ error: '不支持的文件扩展名' }, { status: 400 });
  }

  const maxSize = purpose === 'attachment' ? MAX_UPLOAD_BYTES : MAX_AVATAR_UPLOAD_BYTES;
  if (file.size > maxSize) {
    return NextResponse.json({ error: `文件过大（最大 ${purpose === 'attachment' ? '10MB' : '2MB'}）` }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  // 魔术字节校验：MIME 和扩展名都可被客户端伪造，必须看真实字节。
  // 同时把扩展名等价类（jpg/jpeg）规范化后再核对，避免 .png 文件其实是 jpeg。
  const detected = detectImageType(buffer);
  if (!detected) {
    return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
  }
  const normalizedExt = rawExt === 'jpg' ? 'jpeg' : rawExt;
  if (detected !== normalizedExt) {
    return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
  }

  const filename = `${crypto.randomUUID()}.${rawExt}`;
  const targetDir = purpose === 'attachment' ? 'attachments' : 'avatars';
  const avatarsDir = path.join(process.cwd(), 'public', targetDir);
  const attachmentsDir = avatarsDir;
  const filepath = path.join(attachmentsDir, filename);

  // 确保目录存在（Volume 挂载后目录可能为空）
  await mkdir(attachmentsDir, { recursive: true });

  await writeFile(filepath, buffer);

  return NextResponse.json({ url: `/api/files/${targetDir}/${filename}` });
}
