import type { Command } from 'commander';
import {
  listContactRequests,
  resolveContactRequest,
} from '../../services/contact-management';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import {
  badge,
  bold,
  cyan,
  dim,
  green,
  renderEmptyWithTry,
  renderTable,
  red,
  senderColor,
  yellow,
} from '../../services/render';

type ApprovalListOptions = GlobalOptions & {
  slug?: string;
  incoming?: boolean;
  outgoing?: boolean;
};

type ApprovalResolveOptions = GlobalOptions & {
  requestId: string;
  agent?: string;
};

function renderStatus(status: 'pending' | 'approved' | 'rejected'): string {
  if (status === 'approved') return badge(status, green);
  if (status === 'rejected') return badge(status, red);
  return badge(status, yellow);
}

export function registerInboxRequestCommands(command: Command): void {
  const approvals = command
    .command('request')
    .description('List and resolve first-contact approval requests');

  approvals
    .command('list')
    .description('List incoming or outgoing contact requests')
    .option('--slug <slug>', 'Filter to one owned inbox slug')
    .option('--incoming', 'Only incoming requests')
    .option('--outgoing', 'Only outgoing requests')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ApprovalListOptions;
      await runCommandAction({
        title: 'Masumi inbox request list',
        options,
        run: ({ reporter }) =>
          listContactRequests({
            profileName: options.profile,
            reporter,
            slug: options.slug,
            incoming: options.incoming,
            outgoing: options.outgoing,
          }),
        toHuman: result => {
          if (result.requests.length === 0) {
            return {
              summary: renderEmptyWithTry(
                'No contact requests.',
                'masumi-agent-messenger thread start <target> "hi"'
              ),
              details: [],
            };
          }

          return {
            summary: `${bold(String(result.total))} contact request${result.total === 1 ? '' : 's'}.`,
            details: renderTable(
              result.requests.map(request => ({
                id: `#${request.id}`,
                dir: request.direction,
                status: renderStatus(request.status),
                from: request.requester.displayName ?? request.requester.slug,
                to: request.target.displayName ?? request.target.slug,
                msgs: request.messageCount,
                updated: request.updatedAt,
              })),
              [
                { header: 'Request', key: 'id', color: cyan },
                { header: 'Dir', key: 'dir' },
                { header: 'Status', key: 'status' },
                { header: 'From', key: 'from', color: senderColor },
                { header: 'To', key: 'to', color: senderColor },
                { header: 'Msgs', key: 'msgs', align: 'right' },
                { header: 'Updated', key: 'updated', color: dim },
              ]
            ),
          };
        },
      });
    });

  approvals
    .command('approve')
    .description('Approve a pending incoming contact request')
    .requiredOption('--request-id <id>', 'Contact request id')
    .option('--agent <slug>', 'Owned agent slug to approve on behalf of')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ApprovalResolveOptions;
      await runCommandAction({
        title: 'Masumi inbox request approve',
        options,
        run: ({ reporter }) =>
          resolveContactRequest({
            profileName: options.profile,
            reporter,
            requestId: options.requestId,
            action: 'approve',
            actorSlug: options.agent,
          }),
        toHuman: result => ({
          summary: `Approved request ${cyan(`#${result.requestId}`)} for ${senderColor(result.slug)}.`,
          details: [],
        }),
      });
    });

  approvals
    .command('reject')
    .description('Reject a pending incoming contact request')
    .requiredOption('--request-id <id>', 'Contact request id')
    .option('--agent <slug>', 'Owned agent slug to reject on behalf of')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ApprovalResolveOptions;
      await runCommandAction({
        title: 'Masumi inbox request reject',
        options,
        run: ({ reporter }) =>
          resolveContactRequest({
            profileName: options.profile,
            reporter,
            requestId: options.requestId,
            action: 'reject',
            actorSlug: options.agent,
          }),
        toHuman: result => ({
          summary: `Rejected request ${cyan(`#${result.requestId}`)} for ${senderColor(result.slug)}.`,
          details: [],
        }),
      });
    });
}
