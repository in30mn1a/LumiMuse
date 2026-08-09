import type Database from 'better-sqlite3';
import { constants, createReadStream, lstatSync, unlinkSync } from 'fs';
import { copyFile, lstat, mkdir, readdir, rename, unlink } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { structuredLog } from '@/lib/structured-log';

export const GENERATED_IMAGE_FOLDER_MIGRATION_KEY = 'migration_generated_images_by_character_v1';
export const GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE = 'generated_image_folder_migration_sources';

const DEFAULT_PAGE_SIZE = 250;
const CHARACTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FLAT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/;
const FLAT_GENERATED_URL_SOURCE = String.raw`(?<![A-Za-z0-9_.:\/?&=#%\-])\/(?:api\/files\/)?generated\/([A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+)(?![A-Za-z0-9._\/-])`;

type MessageRow = {
  rowid: number;
  id: string;
  character_id: string;
  content: string;
  metadata: string;
};

type CurrentMessageRow = {
  character_id: string;
  content: string;
  metadata: string;
};

type CopyOutcome =
  | { status: 'copied' | 'reused'; url: string }
  | { status: 'missing' | 'conflict' | 'failed' };

export type GeneratedImageFolderMigrationResult = {
  skipped: boolean;
  pending: boolean;
  scannedMessages: number;
  updatedMessages: number;
  copiedFiles: number;
  reusedFiles: number;
  deletedSources: number;
  missingSources: number;
  conflicts: number;
  copyFailures: number;
  cleanupFailures: number;
};

export type GeneratedImageFolderMigrationOptions = {
  db?: Database.Database;
  generatedRoot?: string;
  pageSize?: number;
  beforeFinalization?: () => void;
};

const activeMigrationPromises = new WeakMap<Database.Database, Promise<GeneratedImageFolderMigrationResult>>();

type MigrationTrackingState = {
  enabled: boolean;
  scheduled: boolean;
  requestedRevision: number;
  options: Pick<GeneratedImageFolderMigrationOptions, 'generatedRoot' | 'pageSize'>;
};

const migrationTrackingStates = new WeakMap<Database.Database, MigrationTrackingState>();

function emptyResult(): GeneratedImageFolderMigrationResult {
  return {
    skipped: false,
    pending: false,
    scannedMessages: 0,
    updatedMessages: 0,
    copiedFiles: 0,
    reusedFiles: 0,
    deletedSources: 0,
    missingSources: 0,
    conflicts: 0,
    copyFailures: 0,
    cleanupFailures: 0,
  };
}

function flatGeneratedUrlRegex(): RegExp {
  return new RegExp(FLAT_GENERATED_URL_SOURCE, 'gi');
}

function collectFlatFilenames(text: unknown, filenames: Set<string>): void {
  if (typeof text !== 'string' || text.length === 0) return;
  const pattern = flatGeneratedUrlRegex();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const filename = match[1];
    if (FLAT_FILENAME_PATTERN.test(filename)) filenames.add(filename);
  }
}

export function containsFlatGeneratedImageUrl(...values: unknown[]): boolean {
  const filenames = new Set<string>();
  for (const value of values) collectFlatFilenames(value, filenames);
  return filenames.size > 0;
}

function rewriteText(text: string, replacements: ReadonlyMap<string, string>): { value: string; changed: boolean } {
  let changed = false;
  const value = text.replace(flatGeneratedUrlRegex(), (matched, filename: string) => {
    const replacement = replacements.get(filename);
    if (!replacement) return matched;
    changed = true;
    return replacement;
  });
  return { value, changed };
}

function rewriteJsonValue(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    return rewriteText(value, replacements);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const rewritten = rewriteJsonValue(item, replacements);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (!value || typeof value !== 'object') {
    return { value, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const rewritten = rewriteJsonValue(item, replacements);
    changed ||= rewritten.changed;
    next[key] = rewritten.value;
  }
  return { value: changed ? next : value, changed };
}

function rewriteMetadata(
  metadata: string,
  replacements: ReadonlyMap<string, string>,
): { value: string; changed: boolean } {
  try {
    const parsed = JSON.parse(metadata) as unknown;
    const rewritten = rewriteJsonValue(parsed, replacements);
    return rewritten.changed
      ? { value: JSON.stringify(rewritten.value), changed: true }
      : { value: metadata, changed: false };
  } catch {
    return { value: metadata, changed: false };
  }
}

function assertContained(base: string, candidate: string): void {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
  if (resolvedCandidate === resolvedBase || !resolvedCandidate.startsWith(prefix)) {
    throw new Error('Generated image migration path escaped its allowed directory');
  }
}

function pathsFor(generatedRoot: string, characterId: string, filename: string): {
  sourcePath: string;
  targetDir: string;
  targetPath: string;
  targetUrl: string;
} {
  if (!CHARACTER_ID_PATTERN.test(characterId)) {
    throw new Error('Invalid character directory for generated image migration');
  }
  if (!FLAT_FILENAME_PATTERN.test(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid legacy generated image filename');
  }

  const root = path.resolve(generatedRoot);
  const sourcePath = path.resolve(root, filename);
  const targetDir = path.resolve(root, characterId);
  const targetPath = path.resolve(targetDir, filename);
  assertContained(root, sourcePath);
  assertContained(root, targetDir);
  assertContained(targetDir, targetPath);

  return {
    sourcePath,
    targetDir,
    targetPath,
    targetUrl: `/api/files/generated/${characterId}/${filename}`,
  };
}

async function fileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function isRegularNonSymlink(filePath: string): Promise<boolean> {
  const info = await lstat(filePath);
  return info.isFile() && !info.isSymbolicLink();
}

async function ensureSafeTargetDirectory(targetDir: string): Promise<void> {
  try {
    const info = await lstat(targetDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Generated image character directory is not a regular directory');
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await mkdir(targetDir, { recursive: true });
  const info = await lstat(targetDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Generated image character directory is not a regular directory');
  }
}

async function findNestedRecoverySource(
  generatedRoot: string,
  targetCharacterId: string,
  filename: string,
): Promise<
  | { status: 'found'; filePath: string; hash: string }
  | { status: 'missing' }
  | { status: 'conflict' }
> {
  let entries;
  try {
    entries = await readdir(generatedRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw err;
  }

  let found: { filePath: string; hash: string } | null = null;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === targetCharacterId || !CHARACTER_ID_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

    const directoryPath = path.resolve(generatedRoot, entry.name);
    const candidatePath = path.resolve(directoryPath, filename);
    assertContained(generatedRoot, directoryPath);
    assertContained(directoryPath, candidatePath);
    try {
      const directoryInfo = await lstat(directoryPath);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;
      if (!await isRegularNonSymlink(candidatePath)) continue;
      const hash = await fileHash(candidatePath);
      if (found && found.hash !== hash) return { status: 'conflict' };
      found ??= { filePath: candidatePath, hash };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  return found ? { status: 'found', ...found } : { status: 'missing' };
}

async function ensureCharacterCopy(
  generatedRoot: string,
  characterId: string,
  filename: string,
  messageId: string,
): Promise<CopyOutcome> {
  let paths: ReturnType<typeof pathsFor>;
  try {
    paths = pathsFor(generatedRoot, characterId, filename);
  } catch (err) {
    structuredLog('warn', 'image.folder_migration.copy_failed', {
      characterId,
      messageId,
      operation: 'validate_legacy_generated_image_path',
      status: 'pending',
    }, err);
    return { status: 'failed' };
  }

  try {
    let sourcePath = paths.sourcePath;
    let sourceHash: string;
    try {
      if (!await isRegularNonSymlink(paths.sourcePath)) {
        structuredLog('warn', 'image.folder_migration.source_invalid', {
          characterId,
          messageId,
          operation: 'copy_legacy_generated_image',
          status: 'pending',
        });
        return { status: 'conflict' };
      }
      sourceHash = await fileHash(paths.sourcePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;

      try {
        if (await isRegularNonSymlink(paths.targetPath)) {
          return { status: 'reused', url: paths.targetUrl };
        }
        structuredLog('warn', 'image.folder_migration.target_conflict', {
          characterId,
          messageId,
          operation: 'reuse_legacy_generated_image',
          status: 'pending',
        });
        return { status: 'conflict' };
      } catch (targetErr) {
        if ((targetErr as NodeJS.ErrnoException).code !== 'ENOENT') throw targetErr;
      }

      const recovery = await findNestedRecoverySource(generatedRoot, characterId, filename);
      if (recovery.status === 'conflict') {
        structuredLog('warn', 'image.folder_migration.recovery_conflict', {
          characterId,
          messageId,
          operation: 'recover_legacy_generated_image',
          status: 'pending',
        });
        return { status: 'conflict' };
      }
      if (recovery.status === 'missing') {
        structuredLog('warn', 'image.folder_migration.source_missing', {
          characterId,
          messageId,
          operation: 'copy_legacy_generated_image',
          status: 'pending',
        });
        return { status: 'missing' };
      }
      sourcePath = recovery.filePath;
      sourceHash = recovery.hash;
    }

    await ensureSafeTargetDirectory(paths.targetDir);
    try {
      const targetIsFile = await isRegularNonSymlink(paths.targetPath);
      if (!targetIsFile || await fileHash(paths.targetPath) !== sourceHash) {
        structuredLog('warn', 'image.folder_migration.target_conflict', {
          characterId,
          messageId,
          operation: 'reuse_legacy_generated_image',
          status: 'pending',
        });
        return { status: 'conflict' };
      }
      return { status: 'reused', url: paths.targetUrl };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const tempPath = path.resolve(paths.targetDir, `.${filename}.migration-${randomUUID()}.tmp`);
    assertContained(paths.targetDir, tempPath);
    try {
      await copyFile(sourcePath, tempPath, constants.COPYFILE_EXCL);
      if (!await isRegularNonSymlink(tempPath) || await fileHash(tempPath) !== sourceHash) {
        throw new Error('Copied generated image failed hash verification');
      }
      await rename(tempPath, paths.targetPath);
    } finally {
      try {
        await unlink(tempPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          structuredLog('warn', 'image.folder_migration.temp_cleanup_failed', {
            characterId,
            messageId,
            operation: 'cleanup_migration_temp',
            status: 'failed',
          }, err);
        }
      }
    }

    return { status: 'copied', url: paths.targetUrl };
  } catch (err) {
    structuredLog('warn', 'image.folder_migration.copy_failed', {
      characterId,
      messageId,
      operation: 'copy_legacy_generated_image',
      status: 'pending',
    }, err);
    return { status: 'failed' };
  }
}

function pageSizeFrom(options: GeneratedImageFolderMigrationOptions): number {
  const value = Number(options.pageSize ?? DEFAULT_PAGE_SIZE);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_PAGE_SIZE;
}

function collectRemainingFlatFilenamesSync(db: Database.Database): Set<string> {
  const filenames = new Set<string>();
  const rows = db.prepare('SELECT content, metadata FROM messages').iterate() as Iterable<{
    content: string;
    metadata: string;
  }>;
  for (const row of rows) {
    collectFlatFilenames(row.content, filenames);
    collectFlatFilenames(row.metadata, filenames);
  }
  return filenames;
}

function ensureMigrationState(db: Database.Database): void {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run(GENERATED_IMAGE_FOLDER_MIGRATION_KEY, '0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE} (
      filename TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function scheduleTrackedMigration(db: Database.Database): void {
  const state = migrationTrackingStates.get(db);
  if (!state?.enabled || state.scheduled || !db.open) return;
  state.scheduled = true;
  setImmediate(() => {
    void (async () => {
      let handledRevision = -1;
      try {
        while (db.open && handledRevision !== state.requestedRevision) {
          handledRevision = state.requestedRevision;
          const sharedInFlight = activeMigrationPromises.get(db);
          await triggerGeneratedImageFolderMigration({ db, ...state.options });
          // 请求若撞上已经运行中的迁移，那一轮可能已越过新消息的 rowid 页面。
          // 等共享 Promise 收尾后再主动跑一轮，避免 pending marker 只能等到下次重启。
          if (sharedInFlight && db.open) {
            await triggerGeneratedImageFolderMigration({ db, ...state.options });
          }
        }
      } catch (err) {
        structuredLog('error', 'image.folder_migration.late_write_failed', {
          operation: 'migrate_late_legacy_generated_image',
          status: 'failed',
        }, err);
      } finally {
        state.scheduled = false;
        if (db.open && handledRevision !== state.requestedRevision) scheduleTrackedMigration(db);
      }
    })();
  });
}

export function installGeneratedImageFolderMigrationTracking(db: Database.Database): void {
  ensureMigrationState(db);
  // 部分迁移故障注入测试使用只代理 prepare/exec/transaction 的精简连接；
  // journal 仍需创建，但 TEMP trigger 只能安装在完整 better-sqlite3 连接上。
  if (typeof (db as Database.Database & { function?: unknown }).function !== 'function') return;
  if (!migrationTrackingStates.has(db)) {
    const state: MigrationTrackingState = {
      enabled: false,
      scheduled: false,
      requestedRevision: 0,
      options: {},
    };
    migrationTrackingStates.set(db, state);
    db.function(
      'lumimuse_has_flat_generated_image_url',
      { deterministic: true },
      (value: string | null) => containsFlatGeneratedImageUrl(value) ? 1 : 0,
    );
    db.function('lumimuse_schedule_generated_image_folder_migration', () => {
      state.requestedRevision++;
      scheduleTrackedMigration(db);
      return 0;
    });
  }

  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS lumimuse_generated_image_folder_migration_ai
    AFTER INSERT ON messages
    WHEN lumimuse_has_flat_generated_image_url(new.content) = 1
      OR lumimuse_has_flat_generated_image_url(new.metadata) = 1
    BEGIN
      INSERT INTO settings (key, value)
      VALUES ('${GENERATED_IMAGE_FOLDER_MIGRATION_KEY}', '0')
      ON CONFLICT(key) DO UPDATE SET value = '0';
      SELECT lumimuse_schedule_generated_image_folder_migration();
    END;

    CREATE TEMP TRIGGER IF NOT EXISTS lumimuse_generated_image_folder_migration_au
    AFTER UPDATE OF content, metadata ON messages
    WHEN lumimuse_has_flat_generated_image_url(new.content) = 1
      OR lumimuse_has_flat_generated_image_url(new.metadata) = 1
    BEGIN
      INSERT INTO settings (key, value)
      VALUES ('${GENERATED_IMAGE_FOLDER_MIGRATION_KEY}', '0')
      ON CONFLICT(key) DO UPDATE SET value = '0';
      SELECT lumimuse_schedule_generated_image_folder_migration();
    END;
  `);
}

export function enableGeneratedImageFolderMigrationTracking(
  db: Database.Database,
  options: Pick<GeneratedImageFolderMigrationOptions, 'generatedRoot' | 'pageSize'> = {},
): void {
  installGeneratedImageFolderMigrationTracking(db);
  const state = migrationTrackingStates.get(db);
  if (!state) throw new Error('Generated image migration tracking was not installed');
  state.options = options;
  state.enabled = true;
}

async function resolveDb(options: GeneratedImageFolderMigrationOptions): Promise<Database.Database> {
  if (options.db) return options.db;
  const { getDb } = await import('@/lib/db');
  return getDb();
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

export async function runGeneratedImageFolderMigration(
  options: GeneratedImageFolderMigrationOptions = {},
): Promise<GeneratedImageFolderMigrationResult> {
  const result = emptyResult();
  const db = await resolveDb(options);
  const generatedRoot = path.resolve(options.generatedRoot ?? path.join(process.cwd(), 'public', 'generated'));
  const pageSize = pageSizeFrom(options);

  ensureMigrationState(db);
  const marker = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(GENERATED_IMAGE_FOLDER_MIGRATION_KEY) as { value: string } | undefined;
  const journalCount = (db.prepare(`SELECT COUNT(*) AS count FROM ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE}`)
    .get() as { count: number }).count;
  if (marker?.value === '1' && journalCount === 0) {
    result.skipped = true;
    return result;
  }

  const pageStmt = db.prepare(`
    SELECT messages.rowid,
           messages.id,
           messages.content,
           messages.metadata,
           conversations.character_id
    FROM messages
    INNER JOIN conversations ON conversations.id = messages.conversation_id
    WHERE messages.rowid > ?
    ORDER BY messages.rowid
    LIMIT ?
  `);
  const currentMessageStmt = db.prepare(`
    SELECT messages.content, messages.metadata, conversations.character_id
    FROM messages
    INNER JOIN conversations ON conversations.id = messages.conversation_id
    WHERE messages.id = ?
  `);
  const updateMessageStmt = db.prepare('UPDATE messages SET content = ?, metadata = ? WHERE id = ?');
  const journalSourceStmt = db.prepare(`
    INSERT OR IGNORE INTO ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE} (filename, created_at)
    VALUES (?, ?)
  `);
  const updateCurrentMessage = db.transaction((
    messageId: string,
    expectedCharacterId: string,
    replacements: ReadonlyMap<string, string>,
  ): boolean => {
    const current = currentMessageStmt.get(messageId) as CurrentMessageRow | undefined;
    if (!current || current.character_id !== expectedCharacterId) return false;

    const content = rewriteText(current.content, replacements);
    const metadata = rewriteMetadata(current.metadata, replacements);
    if (!content.changed && !metadata.changed) return false;
    updateMessageStmt.run(content.value, metadata.value, messageId);
    return true;
  });

  const copyOutcomes = new Map<string, CopyOutcome>();
  let cursor = 0;

  try {
    while (true) {
      const rows = pageStmt.all(cursor, pageSize) as MessageRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        result.scannedMessages++;
        const filenames = new Set<string>();
        collectFlatFilenames(row.content, filenames);
        collectFlatFilenames(row.metadata, filenames);
        if (filenames.size === 0) continue;

        const replacements = new Map<string, string>();
        for (const filename of filenames) {
          journalSourceStmt.run(filename, new Date().toISOString());
          const copyKey = `${row.character_id}\0${filename}`;
          let outcome = copyOutcomes.get(copyKey);
          if (!outcome) {
            outcome = await ensureCharacterCopy(generatedRoot, row.character_id, filename, row.id);
            copyOutcomes.set(copyKey, outcome);
            if (outcome.status === 'copied') result.copiedFiles++;
            else if (outcome.status === 'reused') result.reusedFiles++;
            else if (outcome.status === 'missing') result.missingSources++;
            else if (outcome.status === 'conflict') result.conflicts++;
            else result.copyFailures++;
          }
          if (outcome.status === 'copied' || outcome.status === 'reused') {
            replacements.set(filename, outcome.url);
          }
        }

        if (replacements.size > 0 && updateCurrentMessage(row.id, row.character_id, replacements)) {
          result.updatedMessages++;
        }
      }

      cursor = rows[rows.length - 1].rowid;
      await yieldToEventLoop();
      if (rows.length < pageSize) break;
    }

    options.beforeFinalization?.();
    const finalizeMigration = db.transaction(() => {
      const remainingFlatFilenames = collectRemainingFlatFilenamesSync(db);
      const journalRows = db.prepare(`
        SELECT filename
        FROM ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE}
        ORDER BY filename
      `).all() as Array<{ filename: string }>;
      const deleteJournalSource = db.prepare(`
        DELETE FROM ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE}
        WHERE filename = ?
      `);

      for (const { filename } of journalRows) {
        if (remainingFlatFilenames.has(filename)) continue;
        if (!FLAT_FILENAME_PATTERN.test(filename) || filename.includes('/') || filename.includes('\\')) {
          result.cleanupFailures++;
          continue;
        }
        const sourcePath = path.resolve(generatedRoot, filename);
        assertContained(generatedRoot, sourcePath);
        try {
          const info = lstatSync(sourcePath);
          if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error('Legacy generated image cleanup target is not a regular file');
          }
          unlinkSync(sourcePath);
          result.deletedSources++;
          deleteJournalSource.run(filename);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            deleteJournalSource.run(filename);
            continue;
          }
          result.cleanupFailures++;
          structuredLog('warn', 'image.folder_migration.source_cleanup_failed', {
            operation: 'delete_migrated_source',
            status: 'pending',
          }, err);
        }
      }

      const pendingJournalCount = (db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${GENERATED_IMAGE_FOLDER_MIGRATION_SOURCE_TABLE}
      `).get() as { count: number }).count;
      const pending = remainingFlatFilenames.size > 0 || pendingJournalCount > 0;
      db.prepare('UPDATE settings SET value = ? WHERE key = ?')
        .run(pending ? '0' : '1', GENERATED_IMAGE_FOLDER_MIGRATION_KEY);
      return pending;
    });
    result.pending = finalizeMigration.immediate();
    structuredLog('info', 'image.folder_migration.completed', {
      operation: 'migrate_legacy_generated_images',
      status: result.pending ? 'pending' : 'complete',
    });
    return result;
  } catch (err) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('0', GENERATED_IMAGE_FOLDER_MIGRATION_KEY);
    structuredLog('error', 'image.folder_migration.failed', {
      operation: 'migrate_legacy_generated_images',
      status: 'failed',
    }, err);
    throw err;
  }
}

export function triggerGeneratedImageFolderMigration(
  options: GeneratedImageFolderMigrationOptions = {},
): Promise<GeneratedImageFolderMigrationResult> {
  if (!options.db) {
    return resolveDb(options).then(db => triggerGeneratedImageFolderMigration({ ...options, db }));
  }

  const db = options.db;
  const activeMigrationPromise = activeMigrationPromises.get(db);
  if (activeMigrationPromise) return activeMigrationPromise;

  const runPromise = runGeneratedImageFolderMigration(options);
  const sharedPromise = runPromise.finally(() => {
    if (activeMigrationPromises.get(db) === sharedPromise) activeMigrationPromises.delete(db);
  });
  activeMigrationPromises.set(db, sharedPromise);
  return sharedPromise;
}
