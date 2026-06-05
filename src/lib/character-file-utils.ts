import { copyFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

const LOCAL_ASSET_DIRS = ['avatars', 'generated', 'attachments'] as const;
type LocalAssetDir = typeof LOCAL_ASSET_DIRS[number];

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

    const rawFilename = url.slice(matchedPrefix.length).split(/[?#]/)[0];
    const filename = path.basename(rawFilename);
    if (!filename || filename !== rawFilename || filename.includes('..')) return null;

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

function getLocalAssetUrlAliases(url: string): string[] {
  const asset = resolveLocalAssetUrl(url);
  if (!asset) return [url];
  return [`/${asset.dir}/${asset.filename}`, `/api/files/${asset.dir}/${asset.filename}`];
}

export async function copyLocalAssetUrl(url: unknown, copiedUrls: Map<string, string>): Promise<unknown> {
  if (typeof url !== 'string') return url;
  if (copiedUrls.has(url)) return copiedUrls.get(url) as string;

  const asset = resolveLocalAssetUrl(url);
  if (!asset) return url;

  const ext = path.extname(asset.filename);
  const newFilename = `${randomUUID().slice(0, 12)}${ext}`;
  const targetDir = path.resolve(getPublicRoot(), asset.dir);
  const targetPath = path.resolve(targetDir, newFilename);
  const allowedPrefix = targetDir.endsWith(path.sep) ? targetDir : `${targetDir}${path.sep}`;
  if (targetPath !== targetDir && !targetPath.startsWith(allowedPrefix)) return url;

  await mkdir(targetDir, { recursive: true });
  await copyFile(asset.filePath, targetPath);

  const newUrl = toAssetUrl(asset.dir, newFilename);
  copiedUrls.set(url, newUrl);
  return newUrl;
}

async function duplicateValueFiles(value: unknown, copiedUrls: Map<string, string>): Promise<unknown> {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      items.push(await duplicateValueFiles(item, copiedUrls));
    }
    return items;
  }

  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = key === 'url' || key === 'data'
      ? await copyLocalAssetUrl(item, copiedUrls)
      : await duplicateValueFiles(item, copiedUrls);
  }
  return result;
}

export async function duplicateCharacterFilesInMetadata(metadata: unknown, copiedUrls: Map<string, string>): Promise<string> {
  const parsed = parseMetadata(metadata);
  return JSON.stringify(await duplicateValueFiles(parsed, copiedUrls));
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
const ASSET_URL_REGEX = /\/api\/files\/(avatars|generated|attachments)\/([a-f0-9-]+\.\w+)/gi;

export function collectLocalAssetUrlsFromContent(content: string | null): Set<string> {
  const urls = new Set<string>();
  if (!content) return urls;
  let match: RegExpExecArray | null;
  while ((match = ASSET_URL_REGEX.exec(content)) !== null) {
    urls.add(match[0]);
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
 * 高效判断候选 URL 是否仍被任意行引用，返回"已无引用"的 URL 子集。
 * 与 collectAllLocalAssetUrls 相比，按需逐个 LIKE 查询，避免全表 JSON 解析。
 */
export function filterUnreferencedLocalAssetUrls(db: Database, candidates: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const url of candidates) {
    if (resolveLocalAssetUrl(url)) unique.add(url);
  }
  if (unique.size === 0) return [];

  // 预编译三条查询：metadata（JSON 字符串）、content、avatar_url。
  // LIKE 模式以 URL 直接匹配，?# 等查询串后缀不会落在 metadata 持久化值里。
  const metadataStmt = db.prepare(
    "SELECT 1 FROM messages WHERE metadata LIKE '%' || ? || '%' LIMIT 1",
  );
  const contentStmt = db.prepare(
    "SELECT 1 FROM messages WHERE content LIKE '%' || ? || '%' LIMIT 1",
  );
  const avatarStmt = db.prepare(
    'SELECT 1 FROM characters WHERE avatar_url = ? LIMIT 1',
  );

  const orphans: string[] = [];
  for (const url of unique) {
    const aliases = getLocalAssetUrlAliases(url);
    const referenced =
      aliases.some(alias => metadataStmt.get(alias) !== undefined) ||
      aliases.some(alias => contentStmt.get(alias) !== undefined) ||
      aliases.some(alias => avatarStmt.get(alias) !== undefined);
    if (!referenced) orphans.push(url);
  }
  return orphans;
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
