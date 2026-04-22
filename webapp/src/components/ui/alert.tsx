import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3.5 shadow-xs [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-2px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:h-4 [&>svg]:w-4',
  {
    variants: {
      variant: {
        default:
          'border-blue-500/30 bg-blue-500/10 text-foreground [&>h5]:text-blue-700 [&>svg]:text-blue-600 dark:[&>h5]:text-blue-300 dark:[&>svg]:text-blue-300',
        info: 'border-blue-500/30 bg-blue-500/10 text-foreground [&>h5]:text-blue-700 [&>svg]:text-blue-600 dark:[&>h5]:text-blue-300 dark:[&>svg]:text-blue-300',
        success:
          'border-emerald-500/35 bg-emerald-500/10 text-foreground [&>h5]:text-emerald-700 [&>svg]:text-emerald-600 dark:[&>h5]:text-emerald-300 dark:[&>svg]:text-emerald-300',
        warning:
          'border-amber-500/35 bg-amber-500/10 text-foreground [&>h5]:text-amber-700 [&>svg]:text-amber-600 dark:[&>h5]:text-amber-300 dark:[&>svg]:text-amber-300',
        destructive:
          'border-destructive/35 bg-destructive/10 text-foreground [&>h5]:text-destructive [&>svg]:text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> &
    VariantProps<typeof alertVariants> & { onDismiss?: () => void }
>(({ className, variant, onDismiss, children, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), onDismiss && 'pr-10', className)}
    {...props}
  >
    {children}
    {onDismiss ? (
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-2.5 top-2.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    ) : null}
  </div>
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('mb-1 font-semibold leading-snug tracking-normal', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-sm leading-relaxed [&_p]:leading-relaxed', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
