import { useEffect, useRef } from 'react';
import { PaperPlaneTilt } from '@phosphor-icons/react';
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
  placeholder = 'Send a message…',
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: React.FormEvent) => void;
  maxLength: number;
  disabled: boolean;
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const remaining = maxLength - value.length;
  const showInlineCounter = remaining <= COUNTER_THRESHOLD;

  useEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [value]);

  return (
    <form className="pt-4" onSubmit={onSubmit}>
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
              variant="ghost"
              disabled={disabled || !value.trim()}
              aria-label="Send message"
              className="h-14 w-14 shrink-0 rounded-md p-0"
            >
              <PaperPlaneTilt className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            <span className="text-[11px]">
              {value.length.toLocaleString()}/{maxLength.toLocaleString()} · Cmd+Enter to send
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      {showInlineCounter ? (
        <p className={cnCounter(remaining)}>
          {remaining.toLocaleString()} characters left
        </p>
      ) : null}
    </form>
  );
}

function cnCounter(remaining: number): string {
  if (remaining <= 0) {
    return 'mt-2 text-[11px] text-destructive';
  }
  if (remaining <= 50) {
    return 'mt-2 text-[11px] text-amber-500';
  }
  return 'mt-2 text-[11px] text-muted-foreground/70';
}
