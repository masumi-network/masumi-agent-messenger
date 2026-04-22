import { useEffect, useRef } from 'react';
import { Info, PaperPlaneTilt } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const COUNTER_THRESHOLD = 200;
const MAX_AUTO_GROW_ROWS = 8;
const LINE_HEIGHT_PX = 20;
const BASE_ROWS = 2;

function resizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  const minHeight = BASE_ROWS * LINE_HEIGHT_PX + 16;
  const maxHeight = MAX_AUTO_GROW_ROWS * LINE_HEIGHT_PX + 16;
  const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

export function MessageComposer({
  value,
  onChange,
  onKeyDown,
  onSubmit,
  maxLength,
  disabled,
  disabledReason,
  placeholder = 'Send a message…',
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: React.FormEvent) => void;
  maxLength: number;
  disabled: boolean;
  disabledReason?: string | null;
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const remaining = maxLength - value.length;
  const showInlineCounter = remaining <= COUNTER_THRESHOLD;
  const hasText = value.trim().length > 0;
  const sendDisabled = disabled || !hasText;
  const isMac =
    typeof navigator !== 'undefined' &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
  const sendHintKey = isMac ? '⌘↵' : 'Ctrl+↵';

  useEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [value]);

  return (
    <form className="pt-4" onSubmit={onSubmit}>
      {disabled && disabledReason ? (
        <div
          className="mb-2 flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          role="status"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 leading-snug">{disabledReason}</span>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={maxLength}
          rows={BASE_ROWS}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Message"
          className="min-h-[56px] resize-none px-3.5 py-3 text-sm"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              variant={hasText && !disabled ? 'brand' : 'ghost'}
              disabled={sendDisabled}
              aria-label="Send message"
              className="h-14 w-14 shrink-0 rounded-md p-0"
            >
              <PaperPlaneTilt className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            <span className="text-[11px]">
              {value.length.toLocaleString()}/{maxLength.toLocaleString()} · {sendHintKey} to send
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground/60">
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-0.5 font-mono text-[10px]">
            {sendHintKey}
          </kbd>{' '}
          to send
        </span>
        {showInlineCounter ? (
          <span className={cnCounter(remaining)}>
            {remaining.toLocaleString()} characters left
          </span>
        ) : null}
      </div>
    </form>
  );
}

function cnCounter(remaining: number): string {
  if (remaining <= 0) {
    return 'text-[11px] text-destructive';
  }
  if (remaining <= 50) {
    return 'text-[11px] text-amber-500';
  }
  return 'text-[11px] text-muted-foreground/70';
}
