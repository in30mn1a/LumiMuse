import type Database from 'better-sqlite3';
import { setStructuredLogSink, type StructuredLogRecord } from '@/lib/structured-log';

export const APP_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function textField(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : null;
}

function integerField(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * 把 warn/error 结构化日志落到 app_events，供事后诊断。
 * 只写固定列：structuredLog 已过滤字段白名单并脱敏错误，这里不接收任何正文。
 * 任何失败都吞掉且不再写日志：记录错误不得影响业务，也不得递归。
 */
export function registerAppEventSink(db: Database.Database): void {
  try {
    const insert = db.prepare(`
      INSERT INTO app_events (
        ts, level, event, character_id, conversation_id, message_id, task_id,
        provider_id, model, http_status, error_category, error_name, error_message
      ) VALUES (
        @ts, @level, @event, @characterId, @conversationId, @messageId, @taskId,
        @providerId, @model, @httpStatus, @errorCategory, @errorName, @errorMessage
      )
    `);
    const deleteOlderThan = db.prepare('DELETE FROM app_events WHERE ts < ?');

    let lastPrunedAt = 0;
    const pruneIfDue = (now: number) => {
      if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
      deleteOlderThan.run(new Date(now - APP_EVENT_RETENTION_MS).toISOString());
      lastPrunedAt = now;
    };

    pruneIfDue(Date.now());
    setStructuredLogSink((record: StructuredLogRecord) => {
      try {
        const { fields } = record;
        insert.run({
          ts: record.timestamp,
          level: record.level,
          event: record.event,
          characterId: textField(fields.characterId),
          conversationId: textField(fields.conversationId),
          messageId: textField(fields.messageId),
          taskId: textField(fields.taskId),
          providerId: textField(fields.providerId),
          model: textField(fields.model),
          httpStatus: integerField(fields.httpStatus),
          errorCategory: textField(fields.errorCategory),
          errorName: record.error?.name ?? null,
          errorMessage: record.error?.message ?? null,
        });
        pruneIfDue(Date.parse(record.timestamp));
      } catch {
        // 见函数注释
      }
    });
  } catch {
    // 见函数注释
  }
}
