import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getDb } from '@/lib/db';
import { deleteLocalAssetUrls, filterUnreferencedLocalAssetUrls } from '@/lib/character-file-utils';
import { readJsonObject } from '@/lib/request-json';

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    if (!body.ok) return body.response;

    const url = body.data.url;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: '缺少 url' }, { status: 400 });
    }

    // 安全校验：只允许删除 /generated/ 目录下的文件
    // 兼容新旧两种 URL 格式
    if (!url.startsWith('/generated/') && !url.startsWith('/api/files/generated/')) {
      return NextResponse.json({ error: '不允许删除该路径' }, { status: 403 });
    }

    // 提取文件名，防止路径穿越
    const filename = path.basename(url);
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return NextResponse.json({ error: '非法文件名' }, { status: 400 });
    }

    const normalizedUrl = url.startsWith('/generated/')
      ? `/api/files/generated/${filename}`
      : `/api/files/generated/${filename}`;
    const orphanUrls = filterUnreferencedLocalAssetUrls(getDb(), [normalizedUrl]);
    await deleteLocalAssetUrls(orphanUrls);

    return NextResponse.json({ ok: true });
  } catch (err) {
    // 文件不存在也视为成功（幂等）
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
