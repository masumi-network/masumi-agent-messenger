import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold ring-offset-background transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 active:translate-y-px disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'border border-transparent bg-foreground text-background shadow-xs hover:bg-foreground/90 hover:shadow-soft-sm',
        brand:
          'relative border border-transparent bg-foreground text-background shadow-xs hover:bg-foreground/90 hover:shadow-soft-md hover:-translate-y-px',
        destructive:
          'border border-destructive/25 bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 hover:shadow-soft-sm',
        outline:
          'border border-border/90 bg-background shadow-xs hover:border-foreground/20 hover:bg-accent hover:text-accent-foreground hover:shadow-soft-sm',
        secondary:
          'border border-border/70 bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 hover:shadow-soft-sm',
        ghost:
          'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        'ghost-brand':
          'text-primary hover:bg-primary/10',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        xs: 'h-7 rounded-md px-2 text-xs',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-6',
        xl: 'h-12 rounded-md px-7 text-base',
        icon: 'h-10 w-10',
        'icon-sm': 'h-8 w-8 rounded-md',
        'icon-xs': 'h-7 w-7 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
