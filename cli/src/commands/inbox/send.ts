import type { Command } from 'commander';
import { sendMessageToSlug } from '../../services/send-message';
import { userError } from '../../services/errors';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { cyan, dim, renderKeyValue, senderColor } from '../../services/render';

type SendOptions = GlobalOptions & {
  as?: string;
  to?: string;
  message?: string;
  contentType?: string;
  header?: string[];
  forceUnsupported?: boolean;
  title?: string;
  new?: boolean;
  threadId?: string;
};

function describeMatchedActor(params: {
  slug: string;
  displayName: string | null;
}): string {
  return params.displayName?.trim()
    ? `${params.displayName} (${params.slug})`
    : params.slug;
}

export function registerThreadSendCommand(command: Command): void {
  command
    .command('send')
    .description('Send an encrypted direct message to an inbox slug or email')
    .argument('[to]', 'Recipient inbox slug or exact email')
    .argument('[message...]', 'Plaintext message body')
    .option('--as <slug>', 'Owned inbox slug that will send the message')
    .option('--to <identifier>', 'Recipient inbox slug or exact email')
    .option('--message <text>', 'Plaintext message body')
    .option('--content-type <mime>', 'Encrypted message content type (defaults to text/plain)')
    .option(
      '--header <header>',
      'Encrypted message header in "Name: Value" form',
      (value: string, existing: string[] = []) => [...existing, value],
      []
    )
    .option('--new', 'Always create a fresh direct thread before sending')
    .option('--thread-id <id>', 'Send to a specific existing direct thread id')
    .option('--title <title>', 'Direct thread title to use when a new thread is created')
    .option(
      '--force-unsupported',
      'Send even when the recipient does not advertise support for the chosen content type or headers'
    )
    .action(async function (
      this: Command,
      toArg: string | undefined,
      messageArg: string[] | undefined
    ) {
      const options = this.optsWithGlobals() as SendOptions;
      const to = toArg?.trim() || options.to?.trim();
      const message = (messageArg ?? []).join(' ').trim() || options.message?.trim();
      if (!to) {
        throw userError('Recipient inbox slug or email is required.', {
          code: 'SEND_TO_REQUIRED',
        });
      }
      if (!message) {
        throw userError('Message text is required.', {
          code: 'SEND_MESSAGE_REQUIRED',
        });
      }
      await runCommandAction({
        title: 'Masumi thread send',
        options,
        run: ({ reporter }) =>
          sendMessageToSlug({
            profileName: options.profile,
            actorSlug: options.as,
            to,
            message,
            contentType: options.contentType,
            headerLines: options.header ?? [],
            forceUnsupported: Boolean(options.forceUnsupported),
            title: options.title,
            createNew: options.new,
            threadId: options.threadId,
            reporter,
          }),
        toHuman: result => ({
          summary:
            result.approvalRequired
              ? `Thread request sent to ${senderColor(result.to.slug)}.`
              : result.createdDirectThread
                ? `Sent to ${senderColor(result.to.slug)} (new thread).`
                : `Sent to ${senderColor(result.to.slug)}.`,
          details: renderKeyValue(
            [
              { key: 'To', value: result.to.displayName ?? result.to.slug, color: cyan },
              { key: 'Thread', value: `#${result.threadId}`, color: dim },
              ...(result.approvalRequired
                ? [{ key: 'Request', value: `#${result.requestId}`, color: dim }]
                : []),
              ...(result.targetLookup.inputKind === 'email'
                ? [
                    { key: 'Lookup', value: result.targetLookup.input },
                    {
                      key: 'Matched',
                      value: result.targetLookup.matchedActors
                        .map(actor =>
                          describeMatchedActor({
                            slug: actor.slug,
                            displayName: actor.displayName,
                          })
                        )
                        .join(', '),
                    },
                  ]
                : []),
            ]
          ),
        }),
      });
    });
}
