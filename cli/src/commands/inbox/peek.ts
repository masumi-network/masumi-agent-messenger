import type { Command } from 'commander';
import { readNewMessages, type NewMessageFeed } from '../../services/messages';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { cyan, dim, green, senderColor } from '../../services/render';

type PeekOptions = GlobalOptions & {
  slug?: string;
  threadId?: string;
  readUnsupported?: boolean;
};

export function registerInboxPeekCommand(command: Command): void {
  command
    .command('peek')
    .description('Quickly check inbox for new messages (headless-friendly)')
    .option('--slug <slug>', 'Only peek messages for this direct inbox slug')
    .option('--thread-id <id>', 'Only peek messages for this thread id')
    .option(
      '--read-unsupported',
      'Reveal decrypted bodies even when outside the current inbox contract'
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as PeekOptions;

      await runCommandAction<NewMessageFeed>({
        title: 'Masumi inbox peek',
        options,
        preferPlainReporter: true,
        run: ({ reporter }) =>
          readNewMessages({
            profileName: options.profile,
            reporter,
            slug: options.slug,
            threadId: options.threadId,
            readUnsupported: options.readUnsupported,
          }),
        toHuman: result => {
          const messages = result.messages;
          const count = messages.length;

          if (count === 0) {
            return {
              summary: green('No new messages.'),
              details: [],
            };
          }

          const details = messages.map(msg => {
            const sender = msg.sender.displayName ?? msg.sender.slug;
            const time = new Date(msg.createdAt).toLocaleTimeString();
            const preview = msg.text
              ? msg.text.length > 60
                ? msg.text.slice(0, 60) + '...'
                : msg.text
              : '[no preview]';
            return `${dim(time)} ${senderColor(sender)}: ${preview}`;
          });

          return {
            summary: `${green(String(count))} new message${count === 1 ? '' : 's'} from ${cyan(String(result.totalMessages))} total.`,
            details,
          };
        },
      });
    });
}
