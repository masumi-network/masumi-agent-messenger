import { cn } from '@/lib/utils';

export function DayDivider({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn('animate-soft-fade flex items-center gap-3 py-4', className)}>
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function UnreadDivider({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-soft-fade flex items-center gap-3 py-2', className)}
      role="separator"
      aria-label="New messages"
    >
      <div className="h-px flex-1 bg-primary/60" />
      <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
        New
      </span>
      <div className="h-px flex-1 bg-primary/60" />
    </div>
  );
}
