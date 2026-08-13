import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  deleteLocalAssetUrls,
  filterUnreferencedLocalAssetUrls,
  resolveLocalAssetUrl,
} from '@/lib/character-file-utils';
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

    const asset = resolveLocalAssetUrl(url);
    if (!asset || asset.dir !== 'generated') {
      return NextResponse.json({ error: '非法文件名' }, { status: 400 });
    }

    // 保留调用方实际使用的 URL 形式，确保返回后能精确失效对应的缓存 key。
    const orphanUrls = filterUnreferencedLocalAssetUrls(getDb(), [url]);
    const deletedUrls = await deleteLocalAssetUrls(orphanUrls);

    return NextResponse.json({ ok: true, deletedUrls });
  } catch (err) {
    // 文件不存在也视为成功（幂等）
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: true, deletedUrls: [] });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
