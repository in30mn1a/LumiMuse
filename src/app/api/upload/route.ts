import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';

// 只允许安全的光栅图片格式，明确拒绝 svg（可含脚本）
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const ALLOWED_MIME_PREFIXES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export async function POST(req: NextRequest) {
  const formData = await req.formData();
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

  const maxSize = purpose === 'attachment' ? 10 * 1024 * 1024 : 2 * 1024 * 1024;
  if (file.size > maxSize) {
    return NextResponse.json({ error: `文件过大（最大 ${purpose === 'attachment' ? '10MB' : '2MB'}）` }, { status: 400 });
  }

  const filename = `${uuid()}.${rawExt}`;
  const targetDir = purpose === 'attachment' ? 'attachments' : 'avatars';
  const avatarsDir = path.join(process.cwd(), 'public', targetDir);
  const attachmentsDir = avatarsDir;
  const filepath = path.join(attachmentsDir, filename);

  // 确保目录存在（Volume 挂载后目录可能为空）
  await mkdir(attachmentsDir, { recursive: true });

  const bytes = await file.arrayBuffer();
  await writeFile(filepath, Buffer.from(bytes));

  return NextResponse.json({ url: `/api/files/${targetDir}/${filename}` });
}
