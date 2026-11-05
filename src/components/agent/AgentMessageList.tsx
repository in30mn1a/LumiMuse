'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEventPayload, AgentMessageView } from '@/lib/agent/messages';
import type { LiveSegment, LiveTurn } from '@/hooks/agent/useAgentChat';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { CheckIcon, ChevronDownIcon, CopyIcon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/Toast';
import ProposalCard from './ProposalCard';
import AgentMemoryNote, { type AgentMemoryNoteData } from './AgentMemoryNote';
import { formatTokenCount } from './AgentContextMeter';

type DisplayItem =
  | { kind: 'user'; key: string; content: string }
  | { kind: 'assistant'; key: string; content: string }
  | { kind: 'tool'; key: string; callId: string; name: string; arguments: string; result: string | null; ok: boolean | null }
  | { kind: 'event'; key: string; event: AgentEventPayload }
  | { kind: 'memory'; key: string; note: AgentMemoryNoteData; undone: boolean }
  | { kind: 'proposal'; key: string; proposalId: number };

type ToolState = 'running' | 'ok' | 'error' | 'unknown';

interface ToolCallView {
  callId: string;
  name: string;
  arguments: string;
  result: string | null;
  state: ToolState;
  error?: string;
}

/** 连续的工具调用合成一组折叠显示 */
type ToolGroupBlock = { kind: 'tools'; key: string; calls: ToolCallView[] };
export type DisplayBlock = { kind: 'item'; item: Exclude<DisplayItem, { kind: 'tool' }> } | ToolGroupBlock;
type LiveBlock =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'compaction'; key: string; running: boolean; summary: string; tokensBefore: number }
  | ToolGroupBlock;

function rememberedNote(name: string, result: string | null): AgentMemoryNoteData | null {
  if (name !== 'remember' || result === null) return null;
  try {
    const value = JSON.parse(result.split('\n', 1)[0]) as Record<string, unknown>;
    if (value.ok === true && typeof value.version_id === 'number' && typeof value.content === 'string' && typeof value.session_id === 'string') {
      return { versionId: value.version_id, content: value.content, sessionId: value.session_id };
    }
  } catch {
    // 工具失败或不认识的历史格式只显示原工具行。
  }
  return null;
}

/** 提案工具成功时返回 proposal_id；卡片紧跟在这次工具调用后面。 */
function createdProposalId(name: string, result: string | null): number | null {
  if (name !== 'create_memory_proposal' || result === null) return null;
  try {
    const parsed = JSON.parse(result.split('\n', 1)[0]) as { ok?: unknown; proposal_id?: unknown };
    return parsed.ok === true && typeof parsed.proposal_id === 'number' ? parsed.proposal_id : null;
  } catch {
    return null;
  }
}

/** 把存储的消息排成显示顺序：每轮先是回复正文，再是这轮的工具调用（与结果配对）。 */
export function buildAgentDisplayItems(messages: AgentMessageView[]): DisplayItem[] {
  const undoneVersions = new Set(messages.flatMap(message => message.event?.kind === 'memory_undo' ? [message.event.version_id] : []));
  const items: DisplayItem[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'user') {
      items.push({ kind: 'user', key: `m${message.id}`, content: message.content });
    } else if (message.role === 'assistant') {
      // 调用 ID 只在本回合内唯一；结果是紧随 assistant 入库的连续工具行。
      const results = new Map<string, AgentMessageView>();
      for (let next = index + 1; next < messages.length && messages[next].role === 'tool'; next += 1) {
        const result = messages[next];
        if (result.tool_call_id) results.set(result.tool_call_id, result);
      }
      if (message.content.trim()) items.push({ kind: 'assistant', key: `m${message.id}`, content: message.content });
      for (const call of message.tool_calls ?? []) {
        const result = results.get(call.id);
        items.push({
          kind: 'tool',
          key: `m${message.id}-${call.id}`,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
          result: result ? result.content : null,
          ok: result ? result.tool_ok : null,
        });
        const proposalId = createdProposalId(call.name, result ? result.content : null);
        if (proposalId !== null) items.push({ kind: 'proposal', key: `proposal-${proposalId}`, proposalId });
        const note = rememberedNote(call.name, result ? result.content : null);
        if (note) items.push({ kind: 'memory', key: `memory-${note.versionId}`, note, undone: undoneVersions.has(note.versionId) });
      }
    } else if (message.role === 'event' && message.event && message.event.kind !== 'task_plan') {
      items.push({ kind: 'event', key: `m${message.id}`, event: message.event });
    }
  }
  return items;
}

/**
 * 组的 key：首个调用 id 加同 id 的出现序号，供应商跨轮复用调用 id 时也不重复。
 * 历史与实时内容按同一顺序编号，一轮结束换成入库历史时同一组的 key 不变，展开状态和 DOM 都保留。
 */
function nextGroupKey(firstCallId: string, counts: Map<string, number>): string {
  const seen = counts.get(firstCallId) ?? 0;
  counts.set(firstCallId, seen + 1);
  return `tools:${firstCallId}:${seen}`;
}

/**
 * 连续的工具调用合成一组（正文为空的回合不打断）。组内产生的提案卡片和笔记移到组后面，折叠时也看得见。
 * @param counts 组 key 的出现计数；实时内容接着这里继续编号
 */
export function groupAgentDisplayItems(items: DisplayItem[], counts = new Map<string, number>()): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  let calls: ToolCallView[] = [];
  let held: DisplayBlock[] = [];
  const flush = () => {
    if (calls.length > 0) blocks.push({ kind: 'tools', key: nextGroupKey(calls[0].callId, counts), calls });
    blocks.push(...held);
    calls = [];
    held = [];
  };
  for (const item of items) {
    if (item.kind === 'tool') {
      calls.push({
        callId: item.callId,
        name: item.name,
        arguments: item.arguments,
        result: item.result,
        state: item.ok === null ? 'unknown' : item.ok ? 'ok' : 'error',
      });
    } else if (calls.length > 0 && (item.kind === 'proposal' || item.kind === 'memory')) {
      held.push({ kind: 'item', item });
    } else {
      flush();
      blocks.push({ kind: 'item', item });
    }
  }
  flush();
  return blocks;
}

/** 实时内容按同样的规则分块；只有空白的文本段不打断分组，与历史里跳过空正文一致。 */
function groupLiveSegments(segments: LiveSegment[], counts: Map<string, number>): LiveBlock[] {
  const blocks: LiveBlock[] = [];
  let calls: ToolCallView[] = [];
  const flush = () => {
    if (calls.length > 0) blocks.push({ kind: 'tools', key: nextGroupKey(calls[0].callId, counts), calls });
    calls = [];
  };
  segments.forEach((segment, index) => {
    if (segment.kind === 'tool') {
      calls.push({ callId: segment.id, name: segment.name, arguments: segment.arguments, result: null, state: segment.state, error: segment.error });
      return;
    }
    if (segment.kind === 'text' && !segment.text.trim()) return;
    flush();
    // 段只会追加，下标可以当 key；压缩完成时原地替换，key 不变
    if (segment.kind === 'compaction') {
      blocks.push({
        kind: 'compaction',
        key: `live-compaction-${index}`,
        running: segment.state === 'running',
        summary: segment.summary ?? '',
        tokensBefore: segment.tokensBefore ?? 0,
      });
      return;
    }
    blocks.push(segment.kind === 'text'
      ? { kind: 'text', key: `live-text-${index}`, text: segment.text }
      : { kind: 'note', key: `live-note-${index}`, text: segment.text });
  });
  flush();
  return blocks;
}

const TOOL_DOT: Record<ToolState, string> = {
  running: 'bg-accent motion-safe:animate-pulse',
  ok: 'bg-emerald-500',
  error: 'bg-danger',
  unknown: 'bg-text-muted',
};

const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-medium first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ children, className }) => (className?.startsWith('language-')
    ? <code className="block font-mono text-xs leading-relaxed">{children}</code>
    : <code className="rounded bg-[var(--code-inline-bg)] px-1 py-0.5 font-mono text-[0.8em]">{children}</code>),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-xl border border-accent/20 bg-[var(--code-block-bg)] px-3 py-2.5 last:mb-0">{children}</pre>
  ),
  blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 border-border-light pl-3 text-text-muted last:mb-0">{children}</blockquote>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-dark underline decoration-accent/40">{children}</a>
  ),
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border-light">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border-light last:border-0">{children}</tr>,
  th: ({ children }) => <th className="px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1">{children}</td>,
};

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function UserBubble({ content, appear = false }: { content: string; appear?: boolean }) {
  return (
    <div className={`flex justify-end ${appear ? 'message-appear' : ''}`}>
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--bubble-user-bg)] px-4 py-2.5 text-sm leading-relaxed text-white [overflow-wrap:anywhere]">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({ content, copyable, appear = false }: { content: string; copyable: boolean; appear?: boolean }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      showToast(t('agent.copyFailed'), 'error');
    }
  };

  return (
    <div className={`flex flex-col items-start gap-1 ${appear ? 'message-appear' : ''}`}>
      <div className="w-full min-w-0 rounded-2xl rounded-bl-md border border-border-light bg-surface px-4 py-2.5 text-sm text-text-primary [overflow-wrap:anywhere]">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</ReactMarkdown>
      </div>
      {copyable && (
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
          {copied ? t('agent.copied') : t('agent.copy')}
        </button>
      )}
    </div>
  );
}

function ToolRow({ call, appear }: { call: ToolCallView; appear: boolean }) {
  const { t } = useTranslation();
  const { name, arguments: args, result, state, error } = call;
  const stateLabel = state === 'running'
    ? t('agent.toolRunning')
    : state === 'ok' ? t('agent.toolOk') : state === 'error' ? t('agent.toolFailed') : t('agent.toolNoResult');
  return (
    <details
      className={`group min-w-0 rounded-lg border border-border-light bg-surface text-xs ${appear ? 'animate-fadeIn' : ''}`}
      data-agent-tool={name}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TOOL_DOT[state]}`} aria-hidden="true" />
        <span className="shrink-0 font-mono text-text-secondary">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-muted">{args}</span>
        <span className="shrink-0 text-text-muted">{stateLabel}</span>
      </summary>
      <div className="space-y-2 border-t border-border-light px-3 py-2">
        <div>
          <p className="mb-1 text-text-muted">{t('agent.toolArguments')}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2/40 px-2 py-1.5 font-mono [overflow-wrap:anywhere]">{prettyJson(args) || '{}'}</pre>
        </div>
        <div>
          <p className="mb-1 text-text-muted">{t('agent.toolResult')}</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2/40 px-2 py-1.5 font-mono [overflow-wrap:anywhere]">
            {result !== null ? prettyJson(result) : error || stateLabel}
          </pre>
        </div>
      </div>
    </details>
  );
}

/** 一组工具调用：默认折叠，标题显示数量、失败数和正在运行的工具；展开收起有过渡。 */
function ToolGroup({ calls, open, onToggle, appear }: {
  calls: ToolCallView[];
  open: boolean;
  onToggle: () => void;
  /** 实时内容：出现时有入场动画 */
  appear: boolean;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const running = calls.filter(call => call.state === 'running');
  const failed = calls.filter(call => call.state === 'error').length;
  const state: ToolState = running.length > 0
    ? 'running'
    : failed > 0 ? 'error' : calls.some(call => call.state === 'unknown') ? 'unknown' : 'ok';
  return (
    <div className={`min-w-0 rounded-xl border border-border-light bg-surface-2/40 text-xs ${appear ? 'message-appear' : ''}`} data-agent-tool-group="">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-3 py-1.5 text-left md:min-h-9"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${TOOL_DOT[state]}`} aria-hidden="true" />
        <span className="shrink-0 font-medium text-text-secondary">{formatTemplate(t('agent.toolGroup'), { count: calls.length })}</span>
        {failed > 0 && <span className="shrink-0 text-danger">{formatTemplate(t('agent.toolGroupFailed'), { count: failed })}</span>}
        {running.length > 0 ? (
          // 读工具依次执行、结果在回合末一起返回，最后开始的就是正在执行的
          <span className="min-w-0 flex-1 truncate text-text-muted">
            {formatTemplate(t('agent.toolGroupRunning'), { name: running[running.length - 1].name })}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-text-muted">{[...new Set(calls.map(call => call.name))].join(' · ')}</span>
        )}
        <ChevronDownIcon className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* 0fr 与 1fr 之间过渡，高度平滑展开收起；收起时 inert，键盘和读屏跳过里面的行 */}
      <div
        id={bodyId}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-1.5 px-2 pb-2">
            {/* 组内只会追加，下标 key 让实时行在换成入库历史时原地保留 */}
            {calls.map((call, index) => <ToolRow key={index} call={call} appear={appear} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 压缩分隔线：说明从这里起较早的对话以摘要发给模型，展开可看摘要全文。 */
function CompactionDivider({ summary, tokensBefore, appear = false }: { summary: string; tokensBefore: number; appear?: boolean }) {
  const { t } = useTranslation();
  return (
    <details className={`group mx-auto w-full max-w-full text-xs text-text-muted ${appear ? 'message-appear' : ''}`}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-1 hover:text-text-secondary [&::-webkit-details-marker]:hidden">
        <span className="h-px flex-1 bg-border-light" aria-hidden="true" />
        <span className="shrink-0">
          {tokensBefore > 0
            ? formatTemplate(t('agent.event.compaction'), { tokens: formatTokenCount(tokensBefore) })
            : t('agent.event.compactionShort')}
        </span>
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        <span className="h-px flex-1 bg-border-light" aria-hidden="true" />
      </summary>
      <div className="mt-2 rounded-xl border border-border-light bg-surface-2 px-3 py-2 text-left">
        <p className="mb-1 font-medium text-text-secondary">{t('agent.event.compactionSummary')}</p>
        <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{summary}</p>
      </div>
    </details>
  );
}

function EventNote({ event }: { event: Exclude<AgentEventPayload, { kind: 'compaction' | 'task_plan' }> }) {
  const { t } = useTranslation();
  const text = event.kind === 'interrupted'
    ? t('agent.event.interrupted')
    : event.kind === 'memory_undo'
      ? t('agent.memory.undoEvent')
    : event.kind === 'round_limit'
      ? formatTemplate(t('agent.event.roundLimit'), { rounds: event.rounds })
      : event.kind === 'proposal_decision'
        ? formatTemplate(t('agent.event.proposalDecision'), {
          applied: event.items.filter(item => item.state === 'applied').length,
          rejected: event.items.filter(item => item.state === 'rejected').length,
          skipped: event.items.filter(item => item.state === 'stale' || item.state === 'failed').length,
        })
        : formatTemplate(t('agent.event.error'), { message: event.message });
  return (
    <p
      className={`mx-auto max-w-full rounded-xl border px-3 py-2 text-center text-xs [overflow-wrap:anywhere] ${
        event.kind === 'error' ? 'border-danger/30 text-danger' : 'border-border-light text-text-muted'
      }`}
      role={event.kind === 'error' ? 'alert' : undefined}
    >
      {text}
    </p>
  );
}

interface Props {
  messages: AgentMessageView[];
  live: LiveTurn | null;
  emptyState: React.ReactNode;
  /** 会话正在运行，提案暂时不能批准 */
  proposalBusy?: boolean;
  onProposalDecided?: (continueNext: boolean) => void;
}

/** 消息流。贴近底部时新内容自动滚到底；主人往上翻时不打扰。 */
export default function AgentMessageList({ messages, live, emptyState, proposalBusy = false, onProposalDecided }: Props) {
  const { t } = useTranslation();
  const history = useMemo(() => {
    const counts = new Map<string, number>();
    return { blocks: groupAgentDisplayItems(buildAgentDisplayItems(messages), counts), counts };
  }, [messages]);
  const liveBlocks = useMemo(
    () => (live ? groupLiveSegments(live.segments, new Map(history.counts)) : []),
    [live, history],
  );
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const hadLiveRef = useRef(false);

  useEffect(() => {
    const element = scrollRef.current;
    // 刚发出一条消息时总是回到底部，哪怕之前往上翻过
    if (live && !hadLiveRef.current) stickToBottomRef.current = true;
    hadLiveRef.current = live !== null;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [history, live]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const toggleGroup = (key: string) => setOpenGroups(prev => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const renderGroup = (block: ToolGroupBlock, appear: boolean) => (
    <ToolGroup key={block.key} calls={block.calls} open={openGroups.has(block.key)} onToggle={() => toggleGroup(block.key)} appear={appear} />
  );
  const renderItem = (item: Exclude<DisplayItem, { kind: 'tool' }>) => {
    if (item.kind === 'user') return <UserBubble key={item.key} content={item.content} />;
    if (item.kind === 'assistant') return <AssistantBubble key={item.key} content={item.content} copyable />;
    if (item.kind === 'event') {
      if (item.event.kind === 'task_plan') return null;
      return item.event.kind === 'compaction'
        ? <CompactionDivider key={item.key} summary={item.event.summary} tokensBefore={item.event.tokens_before} />
        : <EventNote key={item.key} event={item.event} />;
    }
    if (item.kind === 'memory') return <AgentMemoryNote key={item.key} note={item.note} undone={item.undone} disabled={proposalBusy} />;
    return <ProposalCard key={item.key} proposalId={item.proposalId} busy={proposalBusy} onDecided={onProposalDecided} />;
  };

  // 历史与实时内容放在同一个数组里：一轮结束换成入库历史时，同 key 的工具组原地保留，不闪也不收起
  const rows = history.blocks.map(block => (block.kind === 'tools' ? renderGroup(block, false) : renderItem(block.item)));
  if (live) {
    rows.push(<UserBubble key="live-user" content={live.userContent} appear />);
    for (const block of liveBlocks) {
      if (block.kind === 'tools') rows.push(renderGroup(block, true));
      else if (block.kind === 'text') rows.push(<AssistantBubble key={block.key} content={block.text} copyable={false} appear />);
      else if (block.kind === 'compaction') {
        rows.push(block.running
          ? (
            <p key={block.key} className="message-appear text-center text-xs text-text-muted" role="status">
              <span className="motion-safe:animate-pulse">{t('agent.event.compacting')}</span>
            </p>
          )
          : <CompactionDivider key={block.key} summary={block.summary} tokensBefore={block.tokensBefore} appear />);
      } else rows.push(<p key={block.key} className="message-appear text-center text-xs text-text-muted">{block.text}</p>);
    }
    const last = liveBlocks[liveBlocks.length - 1];
    // 回合之间模型还在想、没有任何输出时也要有反馈；正文在流式输出或工具在跑时不需要
    const thinking = !live.error && (
      !last || last.kind === 'note' || (last.kind === 'compaction' && !last.running)
      || (last.kind === 'tools' && last.calls.every(call => call.state !== 'running'))
    );
    if (thinking) {
      rows.push(
        <p key="live-thinking" className="animate-fadeIn text-xs text-text-muted" role="status">
          <span className="motion-safe:animate-pulse">{t('agent.thinking')}</span>
        </p>,
      );
    }
    if (live.error) {
      rows.push(
        <p key="live-error" className="message-appear rounded-xl border border-danger/30 px-3 py-2 text-xs text-danger [overflow-wrap:anywhere]" role="alert">
          {live.error}
        </p>,
      );
    }
  }

  const isEmpty = history.blocks.length === 0 && !live;

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {isEmpty ? emptyState : (
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4 lg:px-6" aria-live="polite">
          {rows}
        </div>
      )}
    </div>
  );
}
