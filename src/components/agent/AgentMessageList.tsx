'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEventPayload, AgentMessageView } from '@/lib/agent/messages';
import type { LiveSegment, LiveTurn } from '@/hooks/agent/useAgentChat';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { CheckIcon, CopyIcon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/Toast';
import ProposalCard from './ProposalCard';

type DisplayItem =
  | { kind: 'user'; key: string; content: string }
  | { kind: 'assistant'; key: string; content: string }
  | { kind: 'tool'; key: string; name: string; arguments: string; result: string | null; ok: boolean | null }
  | { kind: 'event'; key: string; event: AgentEventPayload }
  | { kind: 'proposal'; key: string; proposalId: number };

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
  const results = new Map<string, AgentMessageView>();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) results.set(message.tool_call_id, message);
  }
  const items: DisplayItem[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      items.push({ kind: 'user', key: `m${message.id}`, content: message.content });
    } else if (message.role === 'assistant') {
      if (message.content.trim()) items.push({ kind: 'assistant', key: `m${message.id}`, content: message.content });
      for (const call of message.tool_calls ?? []) {
        const result = results.get(call.id);
        items.push({
          kind: 'tool',
          key: `m${message.id}-${call.id}`,
          name: call.name,
          arguments: call.arguments,
          result: result ? result.content : null,
          ok: result ? result.tool_ok : null,
        });
        const proposalId = createdProposalId(call.name, result ? result.content : null);
        if (proposalId !== null) items.push({ kind: 'proposal', key: `proposal-${proposalId}`, proposalId });
      }
    } else if (message.role === 'event' && message.event) {
      items.push({ kind: 'event', key: `m${message.id}`, event: message.event });
    }
  }
  return items;
}

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

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--bubble-user-bg)] px-4 py-2.5 text-sm leading-relaxed text-white [overflow-wrap:anywhere]">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({ content, copyable }: { content: string; copyable: boolean }) {
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
    <div className="flex flex-col items-start gap-1">
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

function ToolRow({ name, args, result, state, error }: {
  name: string;
  args: string;
  result: string | null;
  state: 'running' | 'ok' | 'error' | 'unknown';
  error?: string;
}) {
  const { t } = useTranslation();
  const stateLabel = state === 'running'
    ? t('agent.toolRunning')
    : state === 'ok' ? t('agent.toolOk') : state === 'error' ? t('agent.toolFailed') : t('agent.toolNoResult');
  const dot = state === 'running'
    ? 'bg-accent motion-safe:animate-pulse'
    : state === 'ok' ? 'bg-emerald-500' : state === 'error' ? 'bg-danger' : 'bg-text-muted';
  return (
    <details className="group min-w-0 rounded-xl border border-border-light bg-surface-2/40 text-xs" data-agent-tool={name}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="shrink-0 font-mono text-text-secondary">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-muted">{args}</span>
        <span className="shrink-0 text-text-muted">{stateLabel}</span>
      </summary>
      <div className="space-y-2 border-t border-border-light px-3 py-2">
        <div>
          <p className="mb-1 text-text-muted">{t('agent.toolArguments')}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-2 py-1.5 font-mono [overflow-wrap:anywhere]">{prettyJson(args) || '{}'}</pre>
        </div>
        <div>
          <p className="mb-1 text-text-muted">{t('agent.toolResult')}</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-2 py-1.5 font-mono [overflow-wrap:anywhere]">
            {result !== null ? prettyJson(result) : error || stateLabel}
          </pre>
        </div>
      </div>
    </details>
  );
}

function EventNote({ event }: { event: AgentEventPayload }) {
  const { t } = useTranslation();
  const text = event.kind === 'interrupted'
    ? t('agent.event.interrupted')
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

function LiveSegmentView({ segment }: { segment: LiveSegment }) {
  if (segment.kind === 'text') return <AssistantBubble content={segment.text} copyable={false} />;
  if (segment.kind === 'note') return <p className="text-center text-xs text-text-muted">{segment.text}</p>;
  return <ToolRow name={segment.name} args={segment.arguments} result={null} state={segment.state} error={segment.error} />;
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
  const items = useMemo(() => buildAgentDisplayItems(messages), [messages]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const hadLiveRef = useRef(false);

  useEffect(() => {
    const element = scrollRef.current;
    // 刚发出一条消息时总是回到底部，哪怕之前往上翻过
    if (live && !hadLiveRef.current) stickToBottomRef.current = true;
    hadLiveRef.current = live !== null;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [items, live]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const isEmpty = items.length === 0 && !live;

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {isEmpty ? emptyState : (
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4 lg:px-6" aria-live="polite">
          {items.map(item => {
            if (item.kind === 'user') return <UserBubble key={item.key} content={item.content} />;
            if (item.kind === 'assistant') return <AssistantBubble key={item.key} content={item.content} copyable />;
            if (item.kind === 'event') return <EventNote key={item.key} event={item.event} />;
            if (item.kind === 'proposal') {
              return <ProposalCard key={item.key} proposalId={item.proposalId} busy={proposalBusy} onDecided={onProposalDecided} />;
            }
            const state = item.ok === null ? 'unknown' : item.ok ? 'ok' : 'error';
            return <ToolRow key={item.key} name={item.name} args={item.arguments} result={item.result} state={state} />;
          })}
          {live && (
            <>
              <UserBubble content={live.userContent} />
              {live.segments.map((segment, index) => <LiveSegmentView key={index} segment={segment} />)}
              {live.segments.length === 0 && !live.error && (
                <p className="text-xs text-text-muted motion-safe:animate-pulse" role="status">{t('agent.thinking')}</p>
              )}
              {live.error && (
                <p className="rounded-xl border border-danger/30 px-3 py-2 text-xs text-danger [overflow-wrap:anywhere]" role="alert">
                  {live.error}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
