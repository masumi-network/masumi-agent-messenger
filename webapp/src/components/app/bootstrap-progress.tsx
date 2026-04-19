import { Check } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

type BootstrapStep = 'connect' | 'unlock' | 'create' | 'sync';

const BOOTSTRAP_STEPS: Array<{
  key: BootstrapStep;
  label: string;
  description: string;
}> = [
  {
    key: 'connect',
    label: 'Connect',
    description: 'Connect to the server.',
  },
  {
    key: 'unlock',
    label: 'Unlock vault',
    description: 'Unlock your vault.',
  },
  {
    key: 'create',
    label: 'Create keys',
    description: 'Generate your keys.',
  },
  {
    key: 'sync',
    label: 'Sync inbox',
    description: 'Set up your inbox.',
  },
];

export function BootstrapProgress({
  currentStep,
}: {
  currentStep: BootstrapStep;
}) {
  const currentIndex = BOOTSTRAP_STEPS.findIndex(step => step.key === currentStep);

  return (
    <div className="grid gap-2">
      {BOOTSTRAP_STEPS.map((step, index) => {
        const status =
          index < currentIndex ? 'complete' : index === currentIndex ? 'active' : 'pending';

        return (
          <div
            key={step.key}
            className={cn(
              'flex items-start gap-3 rounded-lg border px-3 py-3',
              status === 'complete' && 'border-primary/30 bg-primary/[0.05]',
              status === 'active' && 'border-primary/40 bg-primary/[0.08]',
              status === 'pending' && 'border-border bg-background'
            )}
          >
            <div
              className={cn(
                'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                status === 'complete' && 'border-primary/50 bg-primary/15 text-primary',
                status === 'active' && 'border-primary/50 bg-primary text-primary-foreground',
                status === 'pending' && 'border-border text-muted-foreground'
              )}
            >
              {status === 'complete' ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{step.label}</p>
              <p className="text-xs text-muted-foreground">{step.description}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
