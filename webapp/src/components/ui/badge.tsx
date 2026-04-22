import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring/60 focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-primary/85',
        secondary:
          'border-border/70 bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/85',
        outline: 'border-border/80 bg-background text-foreground',
        soft: 'border-primary/25 bg-primary/10 text-primary',
        'soft-success':
          'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        'soft-warning':
          'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        'soft-danger':
          'border-destructive/25 bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
