import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

// 只允许访问这两个目录，防止路径穿越
const ALLOWED_DIRS = ['avatars', 'generated', 'attachments'];

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * GET /api/files/avatars/xxx.png
 * GET /api/files/generated/xxx.png
 *
 * 在 standalone 模式下，运行时写入 public/ 的文件无法通过 Next.js 静态服务访问，
 * 通过此路由读取磁盘文件并返回。
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const segments = (await params).path;

  // 至少需要 [dir, filename] 两段
  if (!segments || segments.length < 2) {
    return new NextResponse('Not found', { status: 404 });
  }

  const [dir, ...rest] = segments;

  // 只允许访问白名单目录
  if (!ALLOWED_DIRS.includes(dir)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  // 拼接文件路径，并验证没有路径穿越
  const filename = rest.join('/');
  const filePath = path.resolve(process.cwd(), 'public', dir, filename);
  const allowedBase = path.resolve(process.cwd(), 'public', dir);
  const allowedPrefix = allowedBase.endsWith(path.sep) ? allowedBase : `${allowedBase}${path.sep}`;

  if (filePath !== allowedBase && !filePath.startsWith(allowedPrefix)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  try {
    const buffer = await readFile(filePath);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const contentType = MIME[ext] ?? 'application/octet-stream';

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        // 缓存 7 天，头像不会频繁变动
        'Cache-Control': 'public, max-age=604800, immutable',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
