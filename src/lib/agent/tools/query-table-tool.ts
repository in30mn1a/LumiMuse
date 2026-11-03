import { z } from 'zod';
import { QUERYABLE_TABLE_NAMES, runTableQuery } from '@/lib/agent/table-query';
import { defineReadTool } from './types';
import { pagingShape, runReadTool } from './shared';

export const queryTableTool = defineReadTool({
  name: 'query_table',
  description: '通用只读查表（不支持 SQL）：选表、列、等值条件、排序和分页。只能查白名单内的表和列；'
    + '不确定列名时省略 columns，会返回该表全部允许的列。JSON 类的列按原始文本返回。',
  schema: z.object({
    table: z.enum(QUERYABLE_TABLE_NAMES).describe('表名'),
    columns: z.array(z.string().min(1)).min(1).optional().describe('要返回的列；省略则返回全部允许的列'),
    filters: z.array(z.object({
      column: z.string().min(1),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]).describe('等于该值；null 表示为空'),
    })).optional().describe('等值条件，多个条件同时满足'),
    order_by: z.object({
      column: z.string().min(1),
      direction: z.enum(['asc', 'desc']).default('asc'),
    }).optional().describe('排序；省略则按插入顺序'),
    ...pagingShape,
  }),
  execute: (args, ctx) => runReadTool(ctx, () => runTableQuery(ctx.db, {
    table: args.table,
    columns: args.columns,
    filters: args.filters,
    orderBy: args.order_by,
    limit: args.limit,
    offset: args.offset,
  })),
});
