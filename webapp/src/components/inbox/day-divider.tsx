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
