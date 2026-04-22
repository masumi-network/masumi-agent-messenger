import { ArrowClockwise, Info, WarningCircle } from '@phosphor-icons/react';
import type { EncryptedMessageHeader } from '../../../../shared/message-format';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from './agent-avatar';
import { cn } from '@/lib/utils';

export function MessageItem({
  senderName,
  senderIdentity,
  timestamp,
  messageState,
  isOwnMessage,
  onRevealUnsupported,
  onRetryDecrypt,
  groupedWithPrevious = false,
  className,
}: {
  senderName: string;
  senderIdentity: string;
  timestamp: string;
  messageState:
    | {
        status: 'ok' | 'unsupported' | 'failed';
        bodyText: string | null;
        error: string | null;
        contentType: string | null;
        headerNames: string[];
        headers: EncryptedMessageHeader[] | null;
        unsupportedReasons: string[];
        revealedUnsupported: boolean;
        trustStatus?: 'self' | 'trusted' | 'unpinned-first-seen' | 'untrusted-rotation';
        trustWarning?: string | null;
      }
    | undefined;
  isOwnMessage: boolean;
  onRevealUnsupported?: () => void;
  onRetryDecrypt?: () => void;
  groupedWithPrevious?: boolean;
  className?: string;
}) {
  const isDecrypting = messageState === undefined;
  const isError = messageState?.status === 'failed';
  const isUnsupported = messageState?.status === 'unsupported';
  const shouldRevealUnsupported = Boolean(messageState?.revealedUnsupported);
  const visibleHeaders =
    !messageState || (isUnsupported && !shouldRevealUnsupported)
      ? null
      : messageState.headers ?? [];

  return (
    <div
      className={cn(
        'animate-soft-subtle',
        groupedWithPrevious ? 'mt-0.5' : 'mt-2',
        className
      )}
    >
      <div className={cn('flex gap-3', isOwnMessage && 'flex-row-reverse')}>
        <div className="w-8 shrink-0">
          {groupedWithPrevious ? null : (
            <AgentAvatar
              name={senderName}
              identity={senderIdentity}
              size="md"
              variant={isOwnMessage ? 'self' : 'default'}
            />
          )}
        </div>
        <div
          className={cn(
            'min-w-0 max-w-[85%] rounded-lg px-3 py-2',
            isOwnMessage
              ? 'border border-primary/20 bg-primary/10'
              : 'bg-muted/60'
          )}
        >
          {groupedWithPrevious ? null : (
            <div className="mb-1 flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-medium text-foreground">
                {isOwnMessage ? 'You' : senderName}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{timestamp}</span>
            </div>
          )}
          {isDecrypting ? (
            <Skeleton className="h-4 w-3/4" />
          ) : (
            <div className="space-y-2" aria-live="polite">
              {messageState.trustWarning ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
                  role="alert"
                >
                  <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    {messageState.trustWarning}
                  </span>
                </div>
              ) : null}
              {messageState.contentType && messageState.contentType !== 'text/plain' ? (
                <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {messageState.contentType}
                </p>
              ) : null}
              {visibleHeaders && visibleHeaders.length > 0 ? (
                <div className="rounded-md bg-background/60 px-2.5 py-1.5 font-mono text-xs">
                  {visibleHeaders.map(header => (
                    <div key={`${header.name}:${header.value}`} className="break-all">
                      <span className="text-muted-foreground">{header.name}:</span> {header.value}
                    </div>
                  ))}
                </div>
              ) : null}
              {isUnsupported && !shouldRevealUnsupported ? (
                <div
                  className="flex items-start gap-2.5 rounded-md border border-border/60 bg-background/40 px-3 py-2"
                  style={{
                    backgroundColor: 'hsl(var(--chip-bg) / 0.6)',
                    borderColor: 'hsl(var(--chip-border))',
                  }}
                >
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="text-xs font-medium text-foreground">Can't show this yet</p>
                    {messageState.unsupportedReasons.length > 0 ? (
                      <details>
                        <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                          Details
                        </summary>
                        <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                          {messageState.unsupportedReasons.map(reason => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {onRevealUnsupported ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={onRevealUnsupported}
                      >
                        Reveal anyway
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : isError ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm italic text-muted-foreground">
                    Couldn't unlock this message.
                  </p>
                  {onRetryDecrypt ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={onRetryDecrypt}
                    >
                      <ArrowClockwise className="h-3 w-3" />
                      Retry
                    </Button>
                  ) : null}
                  {messageState.error ? (
                    <span className="font-mono text-[10px] text-muted-foreground/70">
                      {messageState.error}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {messageState.bodyText}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function KeyRotationItem({
  actorName,
  timestamp,
}: {
  actorName: string;
  timestamp: string;
}) {
  return (
    <div className="animate-soft-fade flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[11px] text-muted-foreground">
        {actorName} refreshed their keys <span className="font-mono text-muted-foreground/70">· {timestamp}</span>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
