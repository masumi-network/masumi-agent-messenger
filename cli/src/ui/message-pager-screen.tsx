import { Box, Text, useApp, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { InboxMessageItem } from '../services/messages';

type MessagePagerScreenProps = {
  title: string;
  profile: string;
  messages: InboxMessageItem[];
  pageSize: number;
  initialPage?: number;
};

function renderTrustLines(message: InboxMessageItem): string[] {
  return [
    message.trustNotice ? `[notice] ${message.trustNotice}` : null,
    message.trustWarning ? `[warning] ${message.trustWarning}` : null,
  ].filter((line): line is string => Boolean(line));
}

function renderMessageText(message: InboxMessageItem): string {
  const lines = renderTrustLines(message);

  if (message.decryptStatus === 'failed') {
    lines.push(`[${message.decryptError ?? 'Unable to decrypt'}]`);
    return lines.join('\n');
  }

  if (message.decryptStatus === 'unsupported' && !message.text) {
    const metadata = [
      message.contentType ? `content type ${message.contentType}` : null,
      message.headerNames.length > 0 ? `headers ${message.headerNames.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    const reason = message.unsupportedReasons.join(' ');
    lines.push(
      `[Unsupported content blocked${metadata ? `: ${metadata}` : ''}]${reason ? ` ${reason}` : ''}`
    );
    return lines.join('\n');
  }

  if (message.contentType && (message.contentType !== 'text/plain' || message.headerNames.length > 0)) {
    lines.push(`[content-type ${message.contentType}]`);
  }
  for (const header of message.headers ?? []) {
    lines.push(`${header.name}: ${header.value}`);
  }
  if (message.text) {
    lines.push(message.text);
  }
  if (message.decryptStatus === 'unsupported' && message.text) {
    const reason = message.unsupportedReasons.join(' ');
    if (reason) {
      lines.push(`[revealed unsupported content] ${reason}`);
    }
  }

  return lines.join('\n') || '[Unable to render message]';
}

export function MessagePagerScreen({
  title,
  profile,
  messages,
  pageSize,
  initialPage = 1,
}: MessagePagerScreenProps) {
  const { exit } = useApp();
  const totalPages = Math.max(1, Math.ceil(messages.length / pageSize));
  const [page, setPage] = useState(Math.min(Math.max(initialPage, 1), totalPages));

  const pageSlice = useMemo(() => {
    const start = (page - 1) * pageSize;
    return messages.slice(start, start + pageSize);
  }, [messages, page, pageSize]);

  useInput((input, key) => {
    if (input.toLowerCase() === 'q' || key.return || key.escape) {
      exit();
      return;
    }

    if (input.toLowerCase() === 'n' && page < totalPages) {
      setPage(current => Math.min(current + 1, totalPages));
    }
  });

  const startIndex = messages.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = messages.length === 0 ? 0 : Math.min(page * pageSize, messages.length);

  return (
    <Box flexDirection="column">
      <Text color="cyan">{title}</Text>
      <Text color="green">
        [done] Showing new messages for {profile}
      </Text>
      <Text color="gray">
        Messages {startIndex}-{endIndex} of {messages.length} | Page {page}/{totalPages}
      </Text>
      {pageSlice.length === 0 ? (
        <Box marginTop={1}>
          <Text color="gray">No new messages.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {pageSlice.map(message => (
            <Box key={message.id} marginBottom={1} flexDirection="column">
              <Text color="yellow">
                {message.sender.displayName ?? message.sender.slug} {'->'} {message.threadLabel}
              </Text>
      <Text color="gray">
        {message.createdAt} | thread #{message.threadId} seq {message.threadSeq}
      </Text>
              <Text>{renderMessageText(message)}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Text color="cyan">
        {page < totalPages ? '[N] Next    [Q] Quit' : '[Q] Quit'}
      </Text>
    </Box>
  );
}
