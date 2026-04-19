import { WarningCircle, WifiHigh, WifiSlash } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type ConnectionStatusProps = {
  connected: boolean;
  compact?: boolean;
  errorMessage?: string | null;
  host?: string;
  className?: string;
};

export function ConnectionStatus({
  connected,
  compact,
  errorMessage,
  host,
  className,
}: ConnectionStatusProps) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'h-2.5 w-2.5 rounded-full transition-colors duration-300',
              connected ? 'bg-emerald-500' : 'bg-destructive',
              className
            )}
            aria-label={connected ? 'Connected' : 'Disconnected'}
            role="status"
          />
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{connected ? 'Connected' : 'Disconnected'}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Alert
      variant={connected ? 'default' : 'destructive'}
      className={cn(
        '',
        connected &&
          'border-emerald-500/40 bg-emerald-500/5 text-foreground [&>svg]:text-emerald-600',
        className
      )}
      aria-live="polite"
    >
      {connected ? (
        <WifiHigh className="h-4 w-4" aria-hidden suppressHydrationWarning />
      ) : (
        <WifiSlash className="h-4 w-4" aria-hidden suppressHydrationWarning />
      )}
      <AlertTitle>{connected ? 'Connected' : 'Disconnected'}</AlertTitle>
      <AlertDescription>
        {connected
          ? 'Real-time sync is active.'
          : 'Cannot reach the server.'}
      </AlertDescription>
      {!connected ? (
        <>
          <div className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
            <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden suppressHydrationWarning />
            <span>
              Check that the server is running.
              {host ? (
                <>
                  {' '}
                  Host: <span className="font-mono">{host}</span>
                </>
              ) : null}
            </span>
          </div>
          {errorMessage ? (
            <div className="mt-2 rounded-md border border-destructive/30 bg-background/70 px-3 py-2 text-sm">
              <span className="break-words font-mono text-xs">{errorMessage}</span>
            </div>
          ) : null}
        </>
      ) : null}
    </Alert>
  );
}
