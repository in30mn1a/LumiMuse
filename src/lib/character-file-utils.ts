import { copyFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

const LOCAL_ASSET_DIRS = ['avatars', 'generated', 'attachments'] as const;
type LocalAssetDir = typeof LOCAL_ASSET_DIRS[number];

const GENERATED_CHARACTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface CopyLocalAssetOptions {
  generatedCharacterId?: string;
}

type MessageRow = {
  metadata: string | Record<string, unknown>;
};

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return (value as Record<string, unknown>) || {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getPublicRoot(): string {
  return path.resolve(process.cwd(), 'public');
}

export function resolveLocalAssetUrl(url: unknown): { dir: LocalAssetDir; filename: string; filePath: string } | null {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;

  for (const dir of LOCAL_ASSET_DIRS) {
    const prefixes = [`/${dir}/`, `/api/files/${dir}/`];
    const matchedPrefix = prefixes.find(prefix => url.startsWith(prefix));
    if (!matchedPrefix) continue;

    const rawRelativePath = url.slice(matchedPrefix.length).split(/[?#]/)[0];
    if (
      !rawRelativePath
      || rawRelativePath.includes('\\')
      || rawRelativePath.includes('\0')
      || /%(?:2f|5c|00)/i.test(rawRelativePath)
    ) return null;

    const segments = rawRelativePath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
    if (dir === 'generated') {
      if (segments.length > 2) return null;
      if (segments.length === 2 && !GENERATED_CHARACTER_ID_PATTERN.test(segments[0])) return null;
    } else if (segments.length !== 1) {
      return null;
    }

    const filename = segments.join('/');

    const allowedBase = path.resolve(getPublicRoot(), dir);
    const filePath = path.resolve(allowedBase, filename);
    const allowedPrefix = allowedBase.endsWith(path.sep) ? allowedBase : `${allowedBase}${path.sep}`;
    if (filePath !== allowedBase && !filePath.startsWith(allowedPrefix)) return null;

    return { dir, filename, filePath };
  }

  return null;
}

function toAssetUrl(dir: LocalAssetDir, filename: string): string {
  return `/api/files/${dir}/${filename}`;
}

function getLocalAssetIdentity(url: unknown): string | null {
  const asset = resolveLocalAssetUrl(url);
  return asset ? `${asset.dir}/${asset.filename}` : null;
}

export async function copyLocalAssetUrl(
  url: unknown,
  copiedUrls: Map<string, string>,
  options: CopyLocalAssetOptions = {},
): Promise<unknown> {
  if (typeof url !== 'string') return url;
  if (copiedUrls.has(url)) return copiedUrls.get(url) as string;

  const asset = resolveLocalAssetUrl(url);
  if (!asset) return url;

  const ext = path.extname(asset.filename);
  const newFilename = `${randomUUID().slice(0, 12)}${ext}`;
  const targetDir = path.resolve(getPublicRoot(), asset.dir);
  const targetRelativePath = asset.dir === 'generated' && options.generatedCharacterId
    ? `${options.generatedCharacterId}/${newFilename}`
    : newFilename;
  if (
    asset.dir === 'generated'
    && options.generatedCharacterId
    && !GENERATED_CHARACTER_ID_PATTERN.test(options.generatedCharacterId)
  ) {
    throw new Error('Invalid generated character directory');
  }
  const targetPath = path.resolve(targetDir, ...targetRelativePath.split('/'));
  const allowedPrefix = targetDir.endsWith(path.sep) ? targetDir : `${targetDir}${path.sep}`;
  if (targetPath !== targetDir && !targetPath.startsWith(allowedPrefix)) return url;

  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(asset.filePath, targetPath);

  const newUrl = toAssetUrl(asset.dir, targetRelativePath);
  copiedUrls.set(url, newUrl);
  return newUrl;
}

async function duplicateValueFiles(
  value: unknown,
  copiedUrls: Map<string, string>,
  options: CopyLocalAssetOptions,
): Promise<unknown> {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      items.push(await duplicateValueFiles(item, copiedUrls, options));
    }
    return items;
  }

  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = key === 'url' || key === 'data'
      ? await copyLocalAssetUrl(item, copiedUrls, options)
      : await duplicateValueFiles(item, copiedUrls, options);
  }
  return result;
}

export async function duplicateCharacterFilesInMetadata(
  metadata: unknown,
  copiedUrls: Map<string, string>,
  options: CopyLocalAssetOptions = {},
): Promise<string> {
  const parsed = parseMetadata(metadata);
  return JSON.stringify(await duplicateValueFiles(parsed, copiedUrls, options));
}

function collectValueUrls(value: unknown, urls: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectValueUrls(item, urls);
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'url' || key === 'data') && typeof item === 'string' && resolveLocalAssetUrl(item)) {
      urls.add(item);
      continue;
    }
    collectValueUrls(item, urls);
  }
}

export function collectLocalAssetUrlsFromMetadata(metadata: unknown): Set<string> {
  const urls = new Set<string>();
  const parsed = parseMetadata(metadata);
  collectValueUrls(parsed.generatedImages, urls);
  collectValueUrls(parsed.attachments, urls);
  return urls;
}

/**
 * 从消息内容中提取本地资源 URL（处理嵌入在文本中的图片等）
 */
const CONTENT_URL_TOKEN_REGEX = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s<>"']+|\/(?:api\/files\/)?(?:avatars|attachments)\/[a-z0-9._-]+|\/(?:api\/files\/)?generated\/(?:[a-z0-9_-]+\/)?[a-z0-9._-]+/gi;

export function collectLocalAssetUrlsFromContent(content: string | null): Set<string> {
  const urls = new Set<string>();
  if (!content) return urls;
  let match: RegExpExecArray | null;
  while ((match = CONTENT_URL_TOKEN_REGEX.exec(content)) !== null) {
    const token = match[0];
    // 先吞掉完整的绝对/协议相对 URL，避免从其 path、query 或 hash 中截出伪本地路径。
    if (!token.startsWith('/') || token.startsWith('//')) continue;
    if (resolveLocalAssetUrl(token)) urls.add(token);
  }
  return urls;
}

export function collectCharacterLocalAssetUrls(db: Database, characterId: string): Set<string> {
  const urls = new Set<string>();
  const character = db.prepare('SELECT avatar_url FROM characters WHERE id = ?').get(characterId) as { avatar_url: string | null } | undefined;
  if (character?.avatar_url && resolveLocalAssetUrl(character.avatar_url)) urls.add(character.avatar_url);

  const rows = db.prepare(`
    SELECT messages.metadata, messages.content
    FROM messages
    INNER JOIN conversations ON conversations.id = messages.conversation_id
    WHERE conversations.character_id = ?
  `).all(characterId) as (MessageRow & { content: string | null })[];

  for (const row of rows) {
    for (const url of collectLocalAssetUrlsFromMetadata(row.metadata)) {
      urls.add(url);
    }
    for (const url of collectLocalAssetUrlsFromContent(row.content)) {
      urls.add(url);
    }
  }

  return urls;
}

export function collectConversationLocalAssetUrls(db: Database, conversationId: string): Set<string> {
  const urls = new Set<string>();
  const rows = db.prepare('SELECT metadata, content FROM messages WHERE conversation_id = ?').all(conversationId) as (MessageRow & { content: string | null })[];

  for (const row of rows) {
    for (const url of collectLocalAssetUrlsFromMetadata(row.metadata)) {
      urls.add(url);
    }
    for (const url of collectLocalAssetUrlsFromContent(row.content)) {
      urls.add(url);
    }
  }

  return urls;
}

/**
 * 判断候选 URL 是否仍被任意行引用，返回"已无引用"的资源子集。
 * 所有候选以资源身份去重，剩余表各迭代一次，避免候选数量放大全表扫描次数。
 */
export function filterUnreferencedLocalAssetUrls(db: Database, candidates: Iterable<string>): string[] {
  const remaining = new Map<string, string>();
  for (const url of candidates) {
    const identity = getLocalAssetIdentity(url);
    if (identity && !remaining.has(identity)) remaining.set(identity, url);
  }
  if (remaining.size === 0) return [];

  const markReferenced = (url: unknown): void => {
    const identity = getLocalAssetIdentity(url);
    if (identity) remaining.delete(identity);
  };

  const characters = db.prepare('SELECT avatar_url FROM characters')
    .iterate() as Iterable<{ avatar_url: string | null }>;
  for (const character of characters) {
    markReferenced(character.avatar_url);
    if (remaining.size === 0) return [];
  }

  const messages = db.prepare('SELECT metadata, content FROM messages')
    .iterate() as Iterable<MessageRow & { content: string | null }>;
  for (const message of messages) {
    for (const url of collectLocalAssetUrlsFromMetadata(message.metadata)) {
      markReferenced(url);
      if (remaining.size === 0) return [];
    }
    const metadataText = typeof message.metadata === 'string'
      ? message.metadata
      : JSON.stringify(message.metadata);
    for (const url of collectLocalAssetUrlsFromContent(metadataText || null)) {
      markReferenced(url);
      if (remaining.size === 0) return [];
    }
    for (const url of collectLocalAssetUrlsFromContent(message.content)) {
      markReferenced(url);
      if (remaining.size === 0) return [];
    }
  }

  return [...remaining.values()];
}

export function collectAllLocalAssetUrls(db: Database): Set<string> {
  const urls = new Set<string>();
  const characters = db.prepare('SELECT avatar_url FROM characters').all() as Array<{ avatar_url: string | null }>;
  for (const character of characters) {
    if (character.avatar_url && resolveLocalAssetUrl(character.avatar_url)) urls.add(character.avatar_url);
  }

  const messages = db.prepare('SELECT metadata, content FROM messages').all() as (MessageRow & { content: string | null })[];
  for (const message of messages) {
    for (const url of collectLocalAssetUrlsFromMetadata(message.metadata)) {
      urls.add(url);
    }
    for (const url of collectLocalAssetUrlsFromContent(message.content)) {
      urls.add(url);
    }
  }

  return urls;
}

export async function deleteLocalAssetUrls(urls: Iterable<string>): Promise<void> {
  for (const url of urls) {
    const asset = resolveLocalAssetUrl(url);
    if (!asset) continue;
    try {
      await unlink(asset.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`删除本地文件失败：${asset.filePath}`, err);
      }
    }
  }
}

export function remapJsonStringIds(value: string, idMap: Map<string, string>): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return value;
    return JSON.stringify(parsed.map(item => typeof item === 'string' ? (idMap.get(item) || item) : item));
  } catch {
    return value;
  }
}
