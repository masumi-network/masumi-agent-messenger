import process from 'node:process';
import type { Command } from 'commander';
import { render } from 'ink';
import {
  paginateNewMessages,
  readNewMessages,
  type NewMessageFeed,
  type PaginatedNewMessageFeed,
} from '../../services/messages';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { formatRelativeTime } from '../../services/format';
import { MessagePagerScreen } from '../../ui/message-pager-screen';
import { bold, cyan, gray, red, renderEmpty, senderColor } from '../../services/render';

type MessageOptions = GlobalOptions & {
  page?: string;
  pageSize?: string;
  slug?: string;
  threadId?: string;
  readUnsupported?: boolean;
};

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return Number.parseInt(value, 10);
}

function isInteractiveMessageView(options: MessageOptions): boolean {
  return !options.json && Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function renderTrustLines(message: NewMessageFeed['messages'][number]): string[] {
  return [
    message.trustNotice ? `[notice] ${message.trustNotice}` : null,
    message.trustWarning ? `[warning] ${message.trustWarning}` : null,
  ].filter((line): line is string => Boolean(line));
}

function renderMessageBody(message: NewMessageFeed['messages'][number]): string {
  const lines = renderTrustLines(message);

  if (message.decryptStatus === 'failed') {
    lines.push(`[${message.decryptError ?? 'Unable to decrypt'}]`);
    return lines.join('\n  ');
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
    return lines.join('\n  ');
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
    const warning = message.unsupportedReasons.join(' ');
    if (warning) {
      lines.push(`[revealed unsupported content] ${warning}`);
    }
  }

  return lines.join('\n  ') || '[Unable to render message]';
}

export function registerThreadLatestCommand(command: Command): void {
  command
    .command('latest')
    .description('Show latest inbox messages')
    .option('--page <number>', 'Page number for non-interactive or JSON output')
    .option('--page-size <number>', 'Messages per page', '5')
    .option('--slug <slug>', 'Only latest messages for this direct inbox slug')
    .option('--thread-id <id>', 'Only latest messages for this thread id')
    .option(
      '--read-unsupported',
      'Reveal decrypted bodies and header values even when the payload is outside the current inbox contract'
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as MessageOptions;
      const page = parseOptionalInteger(options.page);
      const pageSize = parseOptionalInteger(options.pageSize);

      if (isInteractiveMessageView(options)) {
        await runCommandAction<NewMessageFeed>({
          title: 'Masumi thread latest',
          options,
          run: ({ reporter }) =>
            readNewMessages({
              profileName: options.profile,
              reporter,
              slug: options.slug,
              threadId: options.threadId,
              readUnsupported: options.readUnsupported,
            }),
          toHuman: result => {
            const paginated = paginateNewMessages(result, {
              page,
              pageSize,
            });
            return {
              summary:
                paginated.totalMessages > 0
                  ? `${bold(String(paginated.totalMessages))} latest message${paginated.totalMessages === 1 ? '' : 's'}.`
                  : renderEmpty('No new messages.'),
              details: [],
            };
          },
          presentInteractive: async ({ result, title }) => {
            const instance = render(
              <MessagePagerScreen
                title={title}
                profile={result.profile}
                messages={result.messages}
                pageSize={pageSize ?? 5}
                initialPage={page ?? 1}
              />,
              {
                patchConsole: false,
                exitOnCtrlC: true,
              }
            );

            await instance.waitUntilExit();
          },
        });
        return;
      }

      await runCommandAction<PaginatedNewMessageFeed>({
          title: 'Masumi thread latest',
          options,
          run: async ({ reporter }) =>
            paginateNewMessages(
              await readNewMessages({
                profileName: options.profile,
              reporter,
              slug: options.slug,
              threadId: options.threadId,
              readUnsupported: options.readUnsupported,
            }),
            {
              page,
              pageSize,
            }
          ),
        toHuman: result => ({
          summary:
            result.totalMessages > 0
              ? `Page ${bold(String(result.page))} of ${bold(String(result.totalPages))} (${result.totalMessages} new).`
              : renderEmpty('No new messages.'),
          details: result.messages.map(message => {
            const sender = message.sender.displayName ?? message.sender.slug;
            const time = gray(formatRelativeTime(message.createdAt));
            const thread = cyan(message.threadLabel);
            const body =
              message.decryptStatus === 'failed'
                ? red(renderMessageBody(message))
                : renderMessageBody(message);
            return `${senderColor(sender)} in ${thread} ${time}\n  ${body}`;
          }),
        }),
      });
    });
}
