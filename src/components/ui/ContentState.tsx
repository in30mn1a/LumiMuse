import type { ReactNode } from 'react';

interface Props {
  mode: 'loading' | 'empty' | 'error';
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export default function ContentState({ mode, title, description, icon, action, className = '' }: Props) {
  return (
    <div
      role={mode === 'error' ? 'alert' : mode === 'loading' ? 'status' : undefined}
      aria-label={mode === 'loading' ? title : undefined}
      className={`px-6 py-8 text-center ${className}`}
    >
      {mode === 'loading' ? (
        <div aria-hidden="true" className="mx-auto mb-4 max-w-md space-y-3 motion-safe:animate-pulse">
          <div className="h-3 w-2/3 rounded-full bg-surface-3" />
          <div className="h-3 w-full rounded-full bg-surface-2" />
          <div className="h-3 w-5/6 rounded-full bg-surface-2" />
        </div>
      ) : icon ? (
        <div aria-hidden="true" className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-accent-dark">
          {icon}
        </div>
      ) : null}
      <p className={`text-sm font-medium ${mode === 'error' ? 'text-danger' : 'text-text-primary'}`}>{title}</p>
      {description && <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-text-muted">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
