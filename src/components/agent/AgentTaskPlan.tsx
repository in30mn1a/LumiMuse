'use client';

import type { AgentTaskPlan as TaskPlan } from '@/lib/agent/task-plan';
import { useTranslation } from '@/lib/i18n-context';

/** 当前任务的独立快照，压缩后仍保留，方便主人确认成果与下一轮目标。 */
export default function AgentTaskPlan({ plan }: { plan: TaskPlan }) {
  const { t } = useTranslation();
  return (
    <details className="mx-3 my-2 max-h-[30dvh] shrink-0 overflow-y-auto rounded-xl border border-border-light bg-surface px-3 py-2 text-sm md:mx-5">
      <summary className="cursor-pointer text-text-primary">
        <span className="font-medium">{t('agent.plan.title')}</span>
        <span className="ml-2 text-text-secondary">{plan.round_goal}</span>
        {plan.recommend_compaction && <span className="ml-2 text-xs text-accent-dark">{t('agent.plan.compactRecommended')}</span>}
      </summary>
      <div className="mt-2 space-y-2 break-words text-text-secondary">
        <p><span className="font-medium">{t('agent.plan.goal')}：</span>{plan.goal}</p>
        <ol className="list-inside list-decimal space-y-1">
          {plan.steps.map(step => (
            <li key={step.id}>
              {step.title} <span className="text-xs text-text-muted">{t(`agent.plan.${step.status}`)}</span>
              {step.result && <p className="pl-4 text-xs">{step.result}</p>}
            </li>
          ))}
        </ol>
        {plan.progress && <p><span className="font-medium">{t('agent.plan.progress')}：</span>{plan.progress}</p>}
        {plan.unresolved.length > 0 && <p><span className="font-medium">{t('agent.plan.unresolved')}：</span>{plan.unresolved.join('；')}</p>}
        {plan.next_round && <p><span className="font-medium">{t('agent.plan.nextRound')}：</span>{plan.next_round}</p>}
      </div>
    </details>
  );
}
