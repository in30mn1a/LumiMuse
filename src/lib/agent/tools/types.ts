import type Database from 'better-sqlite3';
import type { z } from 'zod';
import type { Settings } from '@/types';

/** 工具执行环境。工具只从这里拿数据库和设置，测试可以整体替换。 */
export interface AgentToolContext {
  db: Database.Database;
  settings: Settings;
  sessionId: string;
  signal?: AbortSignal;
}

/** 返回给模型的结果。失败用 ok:false 说明原因，工具本身不抛出。 */
export type AgentToolResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string };

interface AgentToolBase<S extends z.ZodObject> {
  name: string;
  description: string;
  /** 参数校验与发给上游的 JSON Schema 同源。 */
  schema: S;
}

/** 只读工具：可以异步。结果只放内存，回合中断时整轮丢弃也没有副作用。 */
export interface AgentReadTool<S extends z.ZodObject = z.ZodObject> extends AgentToolBase<S> {
  kind: 'read';
  execute(args: z.infer<S>, ctx: AgentToolContext): AgentToolResult | Promise<AgentToolResult>;
}

export interface AgentWriteOutcome {
  result: AgentToolResult;
  /** 结束本轮，例如已生成待批准的提案，避免模型在批准前声称已完成。 */
  terminate?: boolean;
}

/**
 * 写入工具：必须同步（返回值不能是 Promise），才能与 assistant 消息和全部工具结果
 * 在同一个事务里提交，保证回合原子性。需要异步的工具只能注册为只读。
 */
export interface AgentWriteTool<S extends z.ZodObject = z.ZodObject> extends AgentToolBase<S> {
  kind: 'write';
  execute(args: z.infer<S>, ctx: AgentToolContext): AgentWriteOutcome;
}

export type AgentTool = AgentReadTool | AgentWriteTool;

export function defineReadTool<S extends z.ZodObject>(tool: Omit<AgentReadTool<S>, 'kind'>): AgentReadTool<S> {
  return { ...tool, kind: 'read' };
}

export function defineWriteTool<S extends z.ZodObject>(tool: Omit<AgentWriteTool<S>, 'kind'>): AgentWriteTool<S> {
  return { ...tool, kind: 'write' };
}
