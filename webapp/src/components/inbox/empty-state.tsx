import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon: Icon,
  title,
  description,
  hint,
  action,
  secondaryAction,
  tone = 'default',
  className,
}: {
  icon: PhosphorIcon;
  title: string;
  description?: string;
  hint?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  tone?: 'default' | 'celebrate';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'animate-soft-slow flex flex-col items-center justify-center rounded-md px-6 py-12 text-center',
        className
      )}
    >
      <div
        className={cn(
          'mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-border',
          tone === 'celebrate' ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
      {hint ? (
        <p className="mt-5 max-w-xs text-[11px] leading-relaxed text-muted-foreground/80">{hint}</p>
      ) : null}
    </div>
  );
}
