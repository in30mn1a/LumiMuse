import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';

// 只允许访问这两个目录，防止路径穿越
const ALLOWED_DIRS = ['avatars', 'generated', 'attachments'];
const DEFAULT_FILE_CACHE_CONTROL = 'private, max-age=604800, immutable';
const LONG_LIVED_FILE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function cacheControlForDir(dir: string): string {
  return dir === 'avatars' || dir === 'generated'
    ? LONG_LIVED_FILE_CACHE_CONTROL
    : DEFAULT_FILE_CACHE_CONTROL;
}

/**
 * GET /api/files/avatars/xxx.png
 * GET /api/files/generated/xxx.png
 *
 * 在 standalone 模式下，运行时写入 public/ 的文件无法通过 Next.js 静态服务访问，
 * 通过此路由读取磁盘文件并返回。
 */
export async function GET(
  request: NextRequest,
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
    const fileStat = await stat(filePath);
    const etag = `"${fileStat.size.toString(16)}-${fileStat.mtimeMs.toString(16)}"`;
    const lastModified = new Date(fileStat.mtime).toUTCString();
    const cacheControl = cacheControlForDir(dir);

    // 如果浏览器带了 ETag 且匹配，直接返回 304 不传文件内容
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          'Cache-Control': cacheControl,
          'ETag': etag,
          'Last-Modified': lastModified,
        },
      });
    }

    const buffer = await readFile(filePath);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const contentType = MIME[ext] ?? 'application/octet-stream';

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        'ETag': etag,
        'Last-Modified': lastModified,
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
