import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import {
  addThreadParticipant,
  countThreadMessages,
  createDirectThread,
  createGroupThread,
  deleteThread,
  listThreads,
  markThreadRead,
  paginateThreadHistory,
  readThreadHistory,
  removeThreadParticipant,
  setThreadArchived,
} from '../../services/thread';
import {
  listContactRequests,
  listThreadInvites,
  resolveContactRequest,
  resolveThreadInvite,
} from '../../services/contact-management';
import { userError } from '../../services/errors';
import { formatRelativeTime } from '../../services/format';
import {
  paginateNewMessages,
  readNewMessages,
} from '../../services/messages';
import { resolvePreferredAgentSlug } from '../../services/agent-state';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { sendMessageToThread, sendMessageToSlug } from '../../services/send-message';
import { promptMultiline, withPromptOutputSuspended } from '../../services/prompts';
import {
  badge,
  bold,
  cyan,
  dim,
  gray,
  green,
  renderEmptyWithTry,
  renderKeyValue,
  renderTable,
  senderColor,
  yellow,
  type TableColumn,
} from '../../services/render';
import { showCommandHelp } from '../menu';

type ThreadOptions = GlobalOptions & {
  agent?: string;
  threadId?: string;
  title?: string;
  participant?: string[];
  locked?: boolean;
  includeArchived?: boolean;
  page?: string;
  pageSize?: string;
  readUnsupported?: boolean;
  watch?: boolean;
  interval?: string;
  filter?: string;
  contentType?: string;
  header?: string[];
  forceUnsupported?: boolean;
  new?: boolean;
  compose?: boolean;
  incoming?: boolean;
  outgoing?: boolean;
};

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return Number.parseInt(value, 10);
}

function parseThreadApprovalId(value: string): { kind: 'contact' | 'invite'; id: string } {
  if (value.startsWith('invite:')) {
    return { kind: 'invite', id: value.slice('invite:'.length) };
  }
  if (value.startsWith('request:')) {
    return { kind: 'contact', id: value.slice('request:'.length) };
  }
  return { kind: 'contact', id: value };
}

function formatThreadRow(params: {
  id: string;
  label: string;
  unreadMessages?: number;
  archived?: boolean;
  locked?: boolean;
  lastMessageAt?: string;
}): Record<string, string> {
  const statusParts: string[] = [];
  if (params.locked) statusParts.push(badge('locked', yellow));
  if (params.archived) statusParts.push(badge('archived', dim));

  const unread =
    typeof params.unreadMessages === 'number' && params.unreadMessages > 0
      ? badge(`${params.unreadMessages} new`, green)
      : '';

  return {
    id: `#${params.id}`,
    label: params.label,
    status: statusParts.join(' '),
    unread,
    activity: params.lastMessageAt ? formatRelativeTime(params.lastMessageAt) : '',
  };
}

function renderThreadMessageBody(
  message: Awaited<ReturnType<typeof paginateThreadHistory>>['messages'][number]
): string {
  const lines = [
    message.trustNotice ? `[notice] ${message.trustNotice}` : null,
    message.trustWarning ? `[warning] ${message.trustWarning}` : null,
  ].filter((line): line is string => Boolean(line));

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
      `[Unsupported content blocked${metadata ? `: ${metadata}` : ''}]${
        reason ? ` ${reason}` : ''
      }`
    );
    return lines.join('\n  ');
  }

  if (
    message.contentType &&
    (message.contentType !== 'text/plain' || message.headerNames.length > 0)
  ) {
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

  return lines.join('\n  ') || '[Unable to render message]';
}

function renderUnreadMessageBody(
  message: Awaited<ReturnType<typeof paginateNewMessages>>['messages'][number]
): string {
  const lines = [
    message.trustNotice ? `[notice] ${message.trustNotice}` : null,
    message.trustWarning ? `[warning] ${message.trustWarning}` : null,
  ].filter((line): line is string => Boolean(line));

  if (message.decryptStatus === 'failed') {
    lines.push(`[${message.decryptError ?? 'Unable to decrypt'}]`);
    return lines.join('\n  ');
  }
  if (message.decryptStatus === 'unsupported' && !message.text) {
    lines.push(`[Unsupported content blocked] ${message.unsupportedReasons.join(' ')}`.trim());
    return lines.join('\n  ');
  }
  if (message.text) {
    lines.push(message.text);
  }
  return lines.join('\n  ') || '[Unable to render message]';
}

export function registerThreadCommands(program: Command): void {
  const thread = program
    .command('thread')
    .description('Durable thread, message, participant, and approval commands');

  thread.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  thread
    .command('list')
    .description('List visible threads for one owned agent')
    .option('--agent <slug>', 'Owned agent slug to use for thread visibility')
    .option('--include-archived', 'Include archived threads')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread list',
        options,
        run: ({ reporter }) =>
          listThreads({
            profileName: options.profile,
            actorSlug,
            includeArchived: options.includeArchived,
            reporter,
          }),
        toHuman: result => {
          const columns: TableColumn[] = [
            { header: 'ID', key: 'id', color: dim },
            { header: 'Label', key: 'label', color: bold },
            { header: 'Status', key: 'status' },
            { header: 'Unread', key: 'unread' },
            { header: 'Last Activity', key: 'activity', color: gray },
          ];

          const needsApproval = result.threads.filter(
            thread => thread.locked && !thread.archived
          );
          const unread = result.threads.filter(
            thread => !thread.locked && !thread.archived && thread.unreadMessages > 0
          );
          const recent = result.threads.filter(
            thread => !thread.locked && !thread.archived && thread.unreadMessages === 0
          );
          const archived = result.threads.filter(thread => thread.archived);

          function renderSection(title: string, rows: typeof result.threads): string[] {
            if (rows.length === 0) return [];
            const tableRows = rows.map(threadItem =>
              formatThreadRow({
                id: threadItem.id,
                label: threadItem.label,
                unreadMessages: threadItem.unreadMessages,
                archived: threadItem.archived,
                locked: threadItem.locked,
                lastMessageAt: threadItem.lastMessageAt,
              })
            );
            return [
              bold(`${title} (${rows.length})`),
              '',
              ...renderTable(tableRows, columns),
            ];
          }

          return {
            summary:
              result.totalThreads > 0
                ? `Showing ${bold(String(result.totalThreads))} thread${
                    result.totalThreads === 1 ? '' : 's'
                  } for ${cyan(result.actorSlug)}.`
                : renderEmptyWithTry(
                    `No threads visible for ${result.actorSlug}.`,
                    'masumi-agent-messenger thread start <target> "hi"'
                  ),
            details:
              result.totalThreads === 0
                ? []
                : [
                    ...renderSection('Needs approval', needsApproval),
                    ...(unread.length > 0 ? renderSection('Unread', unread) : []),
                    ...(recent.length > 0 ? renderSection('Recent', recent) : []),
                    ...(archived.length > 0 ? renderSection('Archived', archived) : []),
                  ],
          };
        },
      });
    });

  thread
    .command('count')
    .description('Count messages in a direct or group thread')
    .argument('<threadId>', 'Thread id to count')
    .option('--agent <slug>', 'Owned agent slug to use for thread visibility')
    .action(async function (this: Command, threadId: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread count',
        options,
        run: ({ reporter }) =>
          countThreadMessages({
            profileName: options.profile,
            threadId,
            actorSlug,
            reporter,
          }),
        toHuman: result => ({
          summary: `${cyan(result.thread.label)} has ${bold(
            String(result.messageCount)
          )} message${result.messageCount === 1 ? '' : 's'}.`,
          details: renderKeyValue([
            { key: 'Thread', value: `#${result.thread.id}`, color: dim },
            { key: 'Type', value: result.thread.kind },
            { key: 'Agent', value: result.actorSlug, color: cyan },
            {
              key: 'Participants',
              value: result.thread.participants.join(', ') || 'none',
            },
            { key: 'Last sequence', value: result.lastMessageSeq, color: dim },
            {
              key: 'Last activity',
              value:
                result.messageCount > 0
                  ? formatRelativeTime(result.lastMessageAt)
                  : 'none',
              color: gray,
            },
          ]),
        }),
      });
    });

  thread
    .command('show')
    .description('Show message history for a thread')
    .argument('<threadId>', 'Thread id to inspect')
    .option('--agent <slug>', 'Owned agent slug to use when decrypting history')
    .option('--page <number>', 'Page number for non-JSON output')
    .option('--page-size <number>', 'Messages per page', '20')
    .option(
      '--read-unsupported',
      'Reveal decrypted bodies and header values even when the payload is outside the current inbox contract'
    )
    .action(async function (this: Command, threadId: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread show',
        options,
        run: async ({ reporter }) =>
          paginateThreadHistory(
            await readThreadHistory({
              profileName: options.profile,
              threadId: threadId,
              actorSlug,
              reporter,
              readUnsupported: options.readUnsupported,
            }),
            {
              page: parseOptionalInteger(options.page),
              pageSize: parseOptionalInteger(options.pageSize),
            }
          ),
        toHuman: result => ({
          summary:
            result.totalMessages > 0
              ? `Page ${bold(String(result.page))} of ${bold(String(result.totalPages))} for ${cyan(result.thread.label)}.`
              : renderEmptyWithTry(
                  `${result.thread.label} has no messages yet.`,
                  'masumi-agent-messenger thread reply <threadId> "hi"'
                ),
          details: (() => {
            const lastReadThreadSeq = BigInt(result.lastReadThreadSeq);
            let prevDate: string | null = null;
            let prevSecretVersion: string | null = null;
            let unreadBoundaryInserted = false;

            const lines: string[] = [];
            for (const message of result.messages) {
              const dateLabel = message.createdAt.slice(0, 10);
              if (dateLabel !== prevDate) {
                lines.push(dim(`— ${dateLabel} —`));
                prevDate = dateLabel;
              }

              const threadSeq = BigInt(message.threadSeq);
              if (!unreadBoundaryInserted && threadSeq > lastReadThreadSeq) {
                lines.push(yellow('— Unread —'));
                unreadBoundaryInserted = true;
              }

              if (
                prevSecretVersion !== null &&
                message.secretVersion !== prevSecretVersion
              ) {
                lines.push(
                  dim(`— Key rotation (secret v${message.secretVersion}) —`)
                );
              }
              prevSecretVersion = message.secretVersion;

              const sender = message.sender.displayName ?? message.sender.slug;
              const time = gray(formatRelativeTime(message.createdAt));
              const body = renderThreadMessageBody(message);
              lines.push(`${senderColor(sender)} ${time}\n  ${body}`);
            }
            return lines;
          })(),
        }),
      });
    });

  thread
    .command('unread')
    .alias('latest')
    .description('Show the unread message feed for the selected agent')
    .option('--agent <slug>', 'Owned agent slug to use for unread state')
    .option('--thread-id <id>', 'Only unread messages for this thread id')
    .option('--page <number>', 'Page number')
    .option('--page-size <number>', 'Messages per page', '5')
    .option('--watch', 'Tail new unread messages as they arrive')
    .option('--interval <ms>', 'Watch polling interval in milliseconds', '5000')
    .option('--filter <text>', 'Initial watch filter substring (matches decrypted body)')
    .option(
      '--read-unsupported',
      'Reveal decrypted bodies and header values even when the payload is outside the current inbox contract'
    )
    .action(async (_options, commandInstance) => {
      // `thread latest` is kept as a deprecated alias. Emit a one-time
      // deprecation warning when invoked under the old name so scripts
      // migrating to `thread unread` get a soft nudge.
      if (commandInstance.name() === 'latest' || process.argv.includes('latest')) {
        const invokedAsLatest = process.argv
          .slice(process.argv.indexOf(commandInstance.parent?.name() ?? 'thread'))
          .includes('latest');
        if (invokedAsLatest && !commandInstance.optsWithGlobals().json) {
          process.stderr.write(
            '[warn] `masumi-agent-messenger thread latest` is deprecated. Use `masumi-agent-messenger thread unread`.\n'
          );
        }
      }
      const options = commandInstance.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      if (options.watch && options.json) {
        throw userError('Watch mode is not supported with --json.', {
          code: 'THREAD_UNREAD_WATCH_JSON_UNSUPPORTED',
        });
      }

      await runCommandAction({
        title: 'Masumi thread unread',
        options,
        preferPlainReporter: Boolean(options.watch),
        run: async ({ reporter }) => {
          if (!options.watch) {
            return paginateNewMessages(
              await readNewMessages({
                profileName: options.profile,
                reporter,
                actorSlug,
                threadId: options.threadId,
                readUnsupported: options.readUnsupported,
                readMode: 'latest',
              }),
              {
                page: parseOptionalInteger(options.page),
                pageSize: parseOptionalInteger(options.pageSize),
              }
            );
          }

          const intervalMs = Number.parseInt(options.interval ?? '5000', 10);
          const pageSize = parseOptionalInteger(options.pageSize) ?? 5;
          const threadId = options.threadId;

          let filterText =
            options.filter?.trim().length ? options.filter.trim().toLowerCase() : null;
          let paused = false;
          const printedIds = new Set<string>();

          const promptFilter = async (): Promise<string | null> => {
            const stdin = process.stdin;
            const stdout = process.stdout;
            const wasRaw = stdin.isTTY ? stdin.isRaw : false;
            if (stdin.isTTY) stdin.setRawMode(false);

            return withPromptOutputSuspended(async () => {
              const rl = createInterface({ input: stdin, output: stdout });
              try {
                const answer = await rl.question('Filter substring (empty clears): ');
                const normalized = answer.trim().length ? answer.trim().toLowerCase() : null;
                return normalized;
              } finally {
                rl.close();
                if (stdin.isTTY && wasRaw) stdin.setRawMode(true);
              }
            });
          };

          reporter.info(
            `Watching for new messages... (p=pause, f=filter, q=quit)${
              filterText ? ` (filter: ${filterText})` : ''
            }`
          );

          let lastFeed: Awaited<ReturnType<typeof paginateNewMessages>> | null = null;

          const sleep = (ms: number) =>
            new Promise(resolve => {
              setTimeout(resolve, ms);
            });

          let shouldQuit = false;
          const stdin = process.stdin;
          let rawEnabled = false;

          const onStdinData = async (chunk: Buffer) => {
            const key = chunk.toString('utf8');
            if (!key) return;
            if (key === '\u0003') {
              shouldQuit = true;
              return;
            }
            if (key === 'q') {
              shouldQuit = true;
              return;
            }
            if (key === 'p') {
              paused = !paused;
              reporter.info(paused ? 'Paused.' : 'Resumed.');
              return;
            }
            if (key === 'f') {
              filterText = await promptFilter();
              reporter.info(
                filterText ? `Filter set: ${filterText}` : 'Filter cleared.'
              );
              return;
            }
          };

          if (stdin.isTTY && process.stdout.isTTY) {
            rawEnabled = true;
            stdin.setRawMode(true);
            stdin.resume();
            stdin.on('data', onStdinData);
          } else {
            reporter.info('Watch keys disabled (non-TTY).');
          }

          try {
            while (!shouldQuit) {
              const feed = await readNewMessages({
                profileName: options.profile,
                reporter,
                actorSlug,
                threadId,
                readUnsupported: options.readUnsupported,
                readMode: 'latest',
              });

              lastFeed = paginateNewMessages(feed, { page: 1, pageSize });

              for (const message of lastFeed.messages) {
                if (printedIds.has(message.id)) continue;
                const bodyText = (message.text ?? '').toLowerCase();
                if (filterText && !bodyText.includes(filterText)) continue;
                if (paused) continue;

                const sender = message.sender.displayName ?? message.sender.slug;
                const time = gray(formatRelativeTime(message.createdAt));
                const threadLabel = cyan(message.threadLabel);
                const body = renderUnreadMessageBody(message);
                reporter.info(
                  `${senderColor(sender)} in ${threadLabel} ${time}\n  ${body}`
                );
                printedIds.add(message.id);
              }

              await sleep(intervalMs);
            }
          } finally {
            if (stdin.isTTY && rawEnabled) {
              stdin.off('data', onStdinData);
              stdin.setRawMode(false);
            }
          }

          return (
            lastFeed ?? {
              authenticated: true,
              connected: true,
              profile: options.profile,
              scope: { slug: '', threadId: undefined as unknown as string },
              totalMessages: 0,
              messages: [],
              page: 1,
              pageSize,
              totalPages: 1,
              hasPrevious: false,
              hasNext: false,
              previousPage: null,
              nextPage: null,
            }
          );
        },
        toHuman: result => ({
          summary: options.watch
            ? 'Stopped watching.'
            : result.totalMessages > 0
              ? `Page ${bold(String(result.page))} of ${bold(String(result.totalPages))} (${result.totalMessages} latest).`
              : renderEmptyWithTry(
                  'No latest messages.',
                  'masumi-agent-messenger thread start <target> "hi"'
                ),
          details: options.watch
            ? []
            : result.messages.map(message => {
                const sender = message.sender.displayName ?? message.sender.slug;
                const time = gray(formatRelativeTime(message.createdAt));
                const threadLabel = cyan(message.threadLabel);
                const body = renderUnreadMessageBody(message);
                return `${senderColor(sender)} in ${threadLabel} ${time}\n  ${body}`;
              }),
        }),
      });
    });

  thread
    .command('start')
    .description('Start or reuse a direct thread with a target agent')
    .argument('<target>', 'Target agent slug or email')
    .argument('[message...]', 'Optional first message')
    .option('--agent <slug>', 'Owned agent slug that will start the thread')
    .option('--title <title>', 'Optional direct thread title')
    .option('--new', 'Always create a fresh direct thread before sending')
    .option('--compose', 'Compose the first message interactively (multiline)')
    .option('--content-type <mime>', 'Encrypted message content type (defaults to text/plain)')
    .option(
      '--header <header>',
      'Encrypted message header in "Name: Value" form',
      (value: string, existing: string[] = []) => [...existing, value],
      []
    )
    .option(
      '--force-unsupported',
      'Send even when the recipient does not advertise support for the chosen content type or headers'
    )
    .action(async function (
      this: Command,
      target: string,
      messageArg: string[] | undefined
    ) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      let message = (messageArg ?? []).join(' ').trim();
      if (options.compose) {
        message = await promptMultiline({
          question: 'Message',
          doneMessage: 'Press Enter on an empty line to finish.',
        });
      }

      if (!message) {
        await runCommandAction({
          title: 'Masumi thread start',
          options,
          run: ({ reporter }) =>
            createDirectThread({
              profileName: options.profile,
              actorSlug,
              to: target,
              title: options.title,
              reporter,
            }),
          toHuman: result => ({
            summary: `Created direct thread ${bold(`#${result.threadId}`)}.`,
            details: renderKeyValue([
              { key: 'Label', value: result.label },
              { key: 'Agent', value: result.actorSlug, color: cyan },
              { key: 'Participants', value: result.participants.join(', ') || 'none' },
              ...(result.invitedParticipants.length > 0
                ? [{ key: 'Invited', value: result.invitedParticipants.join(', ') }]
                : []),
            ]),
          }),
        });
        return;
      }

      await runCommandAction({
        title: 'Masumi thread start',
        options,
        run: ({ reporter }) =>
          sendMessageToSlug({
            profileName: options.profile,
            actorSlug,
            to: target,
            message,
            contentType: options.contentType,
            headerLines: options.header ?? [],
            forceUnsupported: Boolean(options.forceUnsupported),
            title: options.title,
            createNew: options.new,
            reporter,
          }),
        toHuman: result => ({
          summary: result.approvalRequired
            ? `Thread request sent to ${senderColor(result.to.slug)}.`
            : result.createdDirectThread
              ? `Started new thread with ${senderColor(result.to.slug)}.`
              : `Sent to existing thread with ${senderColor(result.to.slug)}.`,
          details: renderKeyValue([
            { key: 'To', value: result.to.displayName ?? result.to.slug, color: cyan },
            { key: 'Thread', value: `#${result.threadId}`, color: dim },
            ...(result.approvalRequired
              ? [{ key: 'Request', value: `#${result.requestId}`, color: dim }]
              : []),
            {
              key: 'Content-Type',
              value: options.contentType?.trim().length
                ? options.contentType
                : 'text/plain',
              color: dim,
            },
            {
              key: 'Headers',
              value: options.header && options.header.length > 0 ? options.header.join('; ') : 'none',
              color: dim,
            },
          ]),
        }),
      });
    });

  thread
    .command('reply')
    .description('Reply inside an existing thread')
    .argument('<threadId>', 'Thread id')
    .argument(
      '[message...]',
      'Encrypted message body (omit when using --compose)'
    )
    .option('--agent <slug>', 'Owned agent slug that will send the reply')
    .option('--compose', 'Compose reply interactively (multiline)')
    .option('--content-type <mime>', 'Encrypted message content type (defaults to text/plain)')
    .option(
      '--header <header>',
      'Encrypted message header in "Name: Value" form',
      (value: string, existing: string[] = []) => [...existing, value],
      []
    )
    .option(
      '--force-unsupported',
      'Send even when the recipient does not advertise support for the chosen content type or headers'
    )
    .action(async function (
      this: Command,
      threadId: string,
      messageArg: string[] | undefined
    ) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      let message = (messageArg ?? []).join(' ').trim();
      if (options.compose) {
        message = await promptMultiline({
          question: 'Reply message',
          doneMessage: 'Press Enter on an empty line to finish.',
        });
      }

      if (!message) {
        throw userError('Message text is required.', {
          code: 'SEND_MESSAGE_REQUIRED',
        });
      }

      await runCommandAction({
        title: 'Masumi thread reply',
        options,
        run: ({ reporter }) =>
          sendMessageToThread({
            profileName: options.profile,
            actorSlug,
            threadId: threadId,
            message,
            contentType: options.contentType,
            headerLines: options.header ?? [],
            forceUnsupported: Boolean(options.forceUnsupported),
            reporter,
          }),
        toHuman: result => ({
          summary: `Replied in thread ${bold(`#${result.threadId}`)}.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
            {
              key: 'Content-Type',
              value: options.contentType?.trim().length
                ? options.contentType
                : 'text/plain',
              color: dim,
            },
            {
              key: 'Headers',
              value: options.header && options.header.length > 0 ? options.header.join('; ') : 'none',
              color: dim,
            },
          ]),
        }),
      });
    });

  const group = thread.command('group').description('Group-thread commands');
  group.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  group
    .command('create')
    .description('Create a new group thread')
    .option('--agent <slug>', 'Owned agent slug that will create the thread')
    .option(
      '--participant <identifier>',
      'Participant agent slug or exact email',
      (value: string, existing: string[] = []) => [...existing, value],
      []
    )
    .option('--title <title>', 'Optional group-thread title')
    .option('--locked', 'Lock membership at creation')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread group create',
        options,
        run: ({ reporter }) =>
          createGroupThread({
            profileName: options.profile,
            actorSlug,
            participants: options.participant ?? [],
            title: options.title,
            locked: options.locked,
            reporter,
          }),
        toHuman: result => ({
          summary: `Created group thread ${bold(`#${result.threadId}`)}.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
            { key: 'Participants', value: result.participants.join(', ') || 'none' },
            ...(result.invitedParticipants.length > 0
              ? [{ key: 'Invited', value: result.invitedParticipants.join(', ') }]
              : []),
            { key: 'Locked', value: result.locked ? yellow('yes') : 'no' },
          ]),
        }),
      });
    });

  const participant = thread
    .command('participant')
    .description('Thread participant-management commands');
  participant.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  participant
    .command('add')
    .description('Add a participant to an open thread')
    .argument('<threadId>', 'Thread id')
    .argument('<participant>', 'Participant agent slug or exact email')
    .option('--agent <slug>', 'Owned agent slug performing the change')
    .action(async function (this: Command, threadId: string, target: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread participant add',
        options,
        run: ({ reporter }) =>
          addThreadParticipant({
            profileName: options.profile,
            actorSlug,
            threadId: threadId,
            participant: target,
            reporter,
          }),
        toHuman: result => ({
          summary:
            result.action === 'invited'
              ? `Invited ${senderColor(result.participant)} to thread ${bold(`#${result.threadId}`)}.`
              : `Added ${senderColor(result.participant)} to thread ${bold(`#${result.threadId}`)}.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
            { key: 'Participants', value: result.participants.join(', ') || 'none' },
            ...(result.invitedParticipants.length > 0
              ? [{ key: 'Invited', value: result.invitedParticipants.join(', ') }]
              : []),
          ]),
        }),
      });
    });

  participant
    .command('remove')
    .description('Remove a participant from a thread')
    .argument('<threadId>', 'Thread id')
    .argument('<participant>', 'Participant agent slug')
    .option('--agent <slug>', 'Owned agent slug performing the change')
    .action(async function (this: Command, threadId: string, target: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread participant remove',
        options,
        run: ({ reporter }) =>
          removeThreadParticipant({
            profileName: options.profile,
            actorSlug,
            threadId: threadId,
            participant: target,
            reporter,
          }),
        toHuman: result => ({
          summary: `Removed ${senderColor(result.participant)} from thread ${bold(`#${result.threadId}`)}.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
            { key: 'Participants', value: result.participants.join(', ') || 'none' },
            ...(result.invitedParticipants.length > 0
              ? [{ key: 'Invited', value: result.invitedParticipants.join(', ') }]
              : []),
          ]),
        }),
      });
    });

  thread
    .command('read')
    .description('Advance read state for a thread')
    .argument('<threadId>', 'Thread id')
    .option('--agent <slug>', 'Owned agent slug performing the change')
    .option(
      '--through-seq <seq>',
      'Mark read up to and including this thread sequence number (defaults to the latest)'
    )
    .action(async function (this: Command, threadId: string) {
      const options = this.optsWithGlobals() as ThreadOptions & { throughSeq?: string };
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread read',
        options,
        run: ({ reporter }) =>
          markThreadRead({
            profileName: options.profile,
            actorSlug,
            threadId: threadId,
            throughSeq: options.throughSeq,
            reporter,
          }),
        toHuman: result => ({
          summary: `Marked thread ${bold(`#${result.threadId}`)} as read.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
          ]),
        }),
      });
    });

  thread
    .command('archive')
    .description('Archive a thread for the selected agent')
    .argument('<threadId>', 'Thread id')
    .option('--agent <slug>', 'Owned agent slug performing the change')
    .action(async function (this: Command, threadId: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread archive',
        options,
        run: ({ reporter }) =>
          setThreadArchived({
            profileName: options.profile,
            actorSlug,
            threadId: threadId,
            archived: true,
            reporter,
          }),
        toHuman: result => ({
          summary: `Archived thread ${bold(`#${result.threadId}`)}.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
          ]),
        }),
      });
    });

  thread
    .command('restore')
    .description('Restore an archived thread for the selected agent')
    .argument('<threadId>', 'Thread id')
    .option('--agent <slug>', 'Owned agent slug performing the change')
    .action(async function (this: Command, threadId: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread restore',
        options,
        run: ({ reporter }) =>
          setThreadArchived({
            profileName: options.profile,
            actorSlug,
            threadId: threadId,
            archived: false,
            reporter,
          }),
        toHuman: result => ({
          summary: `Restored thread ${bold(`#${result.threadId}`)}.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
          ]),
        }),
      });
    });

  thread
    .command('delete')
    .description('Permanently delete a thread and all its messages (admin only)')
    .argument('<threadId>', 'Thread id')
    .option('--agent <slug>', 'Owned admin agent slug performing the delete')
    .option('--yes', 'Skip the interactive confirmation prompt')
    .action(async function (this: Command, threadId: string) {
      const options = this.optsWithGlobals() as ThreadOptions & { yes?: boolean };
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);

      if (!options.yes && !options.json) {
        const confirmed = await withPromptOutputSuspended(async () => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await rl.question(
              `Permanently delete thread #${threadId}? This removes all messages and cannot be undone. [y/N] `
            );
            return /^y(es)?$/i.test(answer.trim());
          } finally {
            rl.close();
          }
        });
        if (!confirmed) {
          process.stdout.write('Cancelled.\n');
          return;
        }
      }

      await runCommandAction({
        title: 'Masumi thread delete',
        options,
        run: ({ reporter }) =>
          deleteThread({
            profileName: options.profile,
            actorSlug,
            threadId: threadId,
            reporter,
          }),
        toHuman: result => ({
          summary: `Deleted thread ${bold(`#${result.threadId}`)}.`,
          details: renderKeyValue([
            { key: 'Label', value: result.label },
            { key: 'Agent', value: result.actorSlug, color: cyan },
          ]),
        }),
      });
    });

  const approval = thread
    .command('approval')
    .description('First-contact thread approval commands');
  approval.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  approval
    .command('list')
    .description('List incoming or outgoing thread approval requests')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .option('--incoming', 'Only incoming requests')
    .option('--outgoing', 'Only outgoing requests')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi thread approval list',
        options,
        run: async ({ reporter }) => {
          const requests = await listContactRequests({
            profileName: options.profile,
            reporter,
            slug: actorSlug,
            incoming: options.incoming,
            outgoing: options.outgoing,
          });
          const invites = await listThreadInvites({
            profileName: options.profile,
            reporter,
            slug: actorSlug,
            incoming: options.incoming,
            outgoing: options.outgoing,
          });
          return {
            profile: requests.profile,
            total: requests.total + invites.total,
            requests: requests.requests,
            invites: invites.invites,
          };
        },
        toHuman: result => {
          const columns: TableColumn[] = [
            { header: 'Type', key: 'type' },
            { header: 'Approval', key: 'id', color: cyan },
            { header: 'Dir', key: 'dir' },
            { header: 'Status', key: 'status' },
            { header: 'From', key: 'from', color: senderColor },
            { header: 'To', key: 'to', color: senderColor },
            { header: 'Thread', key: 'thread' },
            { header: 'Updated', key: 'updated', color: dim },
          ];
          const rows = [
            ...result.requests.map(request => ({
              type: 'request',
              id: `request:${request.id}`,
              dir: request.direction,
              status:
                request.status === 'approved'
                  ? badge('approved', green)
                  : request.status === 'rejected'
                    ? badge('rejected', yellow)
                    : badge('pending', yellow),
              from: request.requester.displayName ?? request.requester.slug,
              to: request.target.displayName ?? request.target.slug,
              thread: `${request.messageCount} msg${request.messageCount === '1' ? '' : 's'}`,
              updated: request.updatedAt,
            })),
            ...result.invites.map(invite => ({
              type: 'invite',
              id: `invite:${invite.id}`,
              dir: invite.direction,
              status:
                invite.status === 'accepted'
                  ? badge('accepted', green)
                  : invite.status === 'rejected'
                    ? badge('rejected', yellow)
                    : badge('pending', yellow),
              from: invite.inviter.displayName ?? invite.inviter.slug,
              to: invite.invitee.displayName ?? invite.invitee.slug,
              thread: invite.threadTitle ?? `#${invite.threadId}`,
              updated: invite.updatedAt,
            })),
          ];
          return {
            summary:
              rows.length === 0
                ? renderEmptyWithTry(
                    'No thread approval requests.',
                    'masumi-agent-messenger thread start <target> "hi"'
                  )
                : `${bold(String(result.total))} thread approval request${
                    result.total === 1 ? '' : 's'
                  }.`,
            details:
              rows.length === 0
                ? []
                : renderTable(rows, columns),
          };
        },
      });
    });

  approval
    .command('approve')
    .description('Approve an incoming thread request')
    .argument('<approvalId>', 'Request id, or invite:<id> for a group invite')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .action(async function (this: Command, approvalId: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      const parsedApprovalId = parseThreadApprovalId(approvalId);
      await runCommandAction({
        title: 'Masumi thread approval approve',
        options,
        run: async ({ reporter }) => {
          if (parsedApprovalId.kind === 'invite') {
            return resolveThreadInvite({
                profileName: options.profile,
                reporter,
                inviteId: parsedApprovalId.id,
                action: 'accept',
                actorSlug,
            });
          }

          return resolveContactRequest({
            profileName: options.profile,
            reporter,
            requestId: parsedApprovalId.id,
            action: 'approve',
            actorSlug,
          });
        },
        toHuman: result => ({
          summary:
            'inviteId' in result
              ? `Accepted invite ${cyan(`invite:${result.inviteId}`)} for ${senderColor(result.slug)}.`
              : `Approved request ${cyan(`request:${result.requestId}`)} for ${senderColor(result.slug)}.`,
          details: [],
        }),
      });
    });

  approval
    .command('reject')
    .description('Reject an incoming thread request')
    .argument('<approvalId>', 'Request id, or invite:<id> for a group invite')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .action(async function (this: Command, approvalId: string) {
      const options = this.optsWithGlobals() as ThreadOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      const parsedApprovalId = parseThreadApprovalId(approvalId);
      await runCommandAction({
        title: 'Masumi thread approval reject',
        options,
        run: async ({ reporter }) => {
          if (parsedApprovalId.kind === 'invite') {
            return resolveThreadInvite({
                profileName: options.profile,
                reporter,
                inviteId: parsedApprovalId.id,
                action: 'reject',
                actorSlug,
            });
          }

          return resolveContactRequest({
            profileName: options.profile,
            reporter,
            requestId: parsedApprovalId.id,
            action: 'reject',
            actorSlug,
          });
        },
        toHuman: result => ({
          summary:
            'inviteId' in result
              ? `Rejected invite ${cyan(`invite:${result.inviteId}`)} for ${senderColor(result.slug)}.`
              : `Rejected request ${cyan(`request:${result.requestId}`)} for ${senderColor(result.slug)}.`,
          details: [],
        }),
      });
    });
}
