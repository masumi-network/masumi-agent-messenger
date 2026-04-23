import type { Command } from 'commander';
import {
  approveChannelJoin,
  createChannel,
  joinPublicChannel,
  listChannelJoinRequests,
  listChannelMembers,
  listPublicChannels,
  readAuthenticatedChannelMessages,
  readPublicChannelMessages,
  rejectChannelJoin,
  removeChannelMember,
  requestChannelJoin,
  sendChannelMessage,
  setChannelMemberPermission,
  showPublicChannel,
  updateChannelSettings,
} from '../../services/channel';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { userError } from '../../services/errors';
import { promptChoice } from '../../services/prompts';
import { renderEmpty, renderKeyValue, renderTable, type TableColumn } from '../../services/render';
import { showCommandHelp } from '../menu';

type ChannelOptions = GlobalOptions & {
  agent?: string;
  title?: string;
  description?: string;
  approvalRequired?: boolean;
  public?: boolean;
  discoverable?: boolean;
  permission?: string;
  publicJoinPermission?: string;
  defaultJoinPermission?: string;
  contentType?: string;
  authenticated?: boolean;
  beforeChannelSeq?: string;
  limit?: string;
  afterMemberId?: string;
  incoming?: boolean;
  outgoing?: boolean;
  all?: boolean;
};

function channelColumns(): TableColumn[] {
  return [
    { header: 'ID', key: 'id' },
    { header: 'Slug', key: 'slug' },
    { header: 'Title', key: 'title' },
    { header: 'Join', key: 'join' },
    { header: 'Messages', key: 'messages', align: 'right' },
    { header: 'Discoverable', key: 'discoverable' },
  ];
}

function formatChannelPermission(permission: string): string {
  if (permission === 'read') return 'read';
  if (permission === 'read_write') return 'read/write';
  if (permission === 'admin') return 'admin';
  return permission;
}

function resolveAccessModeOption(options: ChannelOptions): 'public' | 'approval_required' | undefined {
  if (options.public && options.approvalRequired) {
    throw userError('Use either --public or --approval-required, not both.', {
      code: 'CHANNEL_ACCESS_MODE_CONFLICT',
    });
  }
  if (options.approvalRequired) return 'approval_required';
  if (options.public) return 'public';
  return undefined;
}

function resolvePublicJoinPermissionOption(
  options: ChannelOptions,
  fallback?: string
): string | undefined {
  if (
    options.publicJoinPermission !== undefined &&
    options.defaultJoinPermission !== undefined &&
    options.publicJoinPermission !== options.defaultJoinPermission
  ) {
    throw userError(
      'Use either --public-join-permission or --default-join-permission, not both.',
      { code: 'CHANNEL_JOIN_PERMISSION_CONFLICT' }
    );
  }
  return options.publicJoinPermission ?? options.defaultJoinPermission ?? fallback;
}

export function registerChannelCommands(program: Command): void {
  const channel = program
    .command('channel')
    .alias('channels')
    .description('Public and approval-required channel commands');

  channel.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  channel
    .command('list')
    .description('List public channels without signing in')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel list',
        options,
        run: ({ reporter }) =>
          listPublicChannels({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => ({
          summary:
            result.channels.length === 0
              ? renderEmpty('No public channels found.')
              : `Found ${result.channels.length.toString()} public channel${result.channels.length === 1 ? '' : 's'}.`,
          details: renderTable(
            result.channels.map(row => ({
              id: row.id,
              slug: row.slug,
              title: row.title ?? '',
              join: formatChannelPermission(row.publicJoinPermission),
              messages: row.lastMessageSeq,
              discoverable: row.discoverable ? 'yes' : 'no',
            })),
            channelColumns()
          ),
        }),
      });
    });

  channel
    .command('show')
    .description('Show one public channel without signing in')
    .argument('<slug>', 'Channel slug')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel show',
        options,
        run: ({ reporter }) =>
          showPublicChannel({
            profileName: options.profile,
            slug,
            reporter,
          }),
        toHuman: result => {
          const selected = result.channel;
          return {
            summary: selected ? `Showing #${selected.slug}.` : renderEmpty(`Channel ${slug} not found.`),
            details: selected
              ? renderKeyValue([
                  { key: 'ID', value: selected.id },
                  { key: 'Slug', value: selected.slug },
                  { key: 'Title', value: selected.title ?? 'not set' },
                  { key: 'Description', value: selected.description ?? 'not set' },
                  {
                    key: 'Public join permission',
                    value: formatChannelPermission(selected.publicJoinPermission),
                  },
                  { key: 'Messages', value: selected.lastMessageSeq },
                  { key: 'Discoverable', value: selected.discoverable ? 'yes' : 'no' },
                ])
              : [],
          };
        },
      });
    });

  channel
    .command('messages')
    .description('Read public recent messages, or authenticated paged channel history')
    .argument('<slug>', 'Channel slug')
    .option('--authenticated', 'Use authenticated channel history access')
    .option('--agent <slug>', 'Owned agent slug for authenticated history')
    .option('--before-channel-seq <seq>', 'Read messages before this channel sequence')
    .option('--limit <count>', 'Maximum messages to return, capped by the server')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      const useAuthenticatedHistory = Boolean(
        options.authenticated ||
          options.agent ||
          options.beforeChannelSeq ||
          options.limit
      );
      await runCommandAction({
        title: 'Masumi channel messages',
        options,
        run: ({ reporter }) =>
          useAuthenticatedHistory
            ? readAuthenticatedChannelMessages({
                profileName: options.profile,
                actorSlug: options.agent,
                slug,
                beforeChannelSeq: options.beforeChannelSeq,
                limit: options.limit,
                reporter,
              })
            : readPublicChannelMessages({
                profileName: options.profile,
                slug,
                reporter,
              }),
        toHuman: result => ({
          summary:
            result.messages.length === 0
              ? renderEmpty('No recent public messages.')
              : `Showing ${result.messages.length.toString()} ${result.cappedToRecent ? 'recent public' : 'authenticated'} channel message${result.messages.length === 1 ? '' : 's'} from #${result.slug}.`,
          details: result.messages.map(message => {
            const body =
              message.status === 'ok'
                ? message.text ?? ''
                : `[${message.error ?? 'Unable to verify message'}]`;
            const sentAt = message.createdAt ? ` · ${message.createdAt}` : '';
            return `#${message.channelSeq} ${message.sender}${sentAt}\n  ${body}`;
          }),
        }),
      });
    });

  channel
    .command('members')
    .description('List channel members as a member')
    .argument('<slug>', 'Channel slug')
    .option('--agent <slug>', 'Member agent slug')
    .option('--after-member-id <id>', 'Continue after this member row id')
    .option('--limit <count>', 'Maximum members to return, capped by the server')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel members',
        options,
        run: ({ reporter }) =>
          listChannelMembers({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            afterMemberId: options.afterMemberId,
            limit: options.limit,
            reporter,
          }),
        toHuman: result => ({
          summary:
            result.members.length === 0
              ? renderEmpty('No channel members found.')
              : `Showing ${result.members.length.toString()} member${result.members.length === 1 ? '' : 's'} from #${result.slug}.`,
          details: renderTable(
            result.members.map(member => ({
              id: member.id,
              agent: member.agentSlug,
              permission: member.permission,
              active: member.active ? 'yes' : 'no',
              sent: member.lastSentSeq,
            })),
            [
              { header: 'ID', key: 'id' },
              { header: 'Agent', key: 'agent' },
              { header: 'Permission', key: 'permission' },
              { header: 'Active', key: 'active' },
              { header: 'Sent', key: 'sent', align: 'right' },
            ]
          ),
        }),
      });
    });

  channel
    .command('create')
    .description('Create a channel from an owned agent')
    .argument('<slug>', 'Channel slug')
    .option('--agent <slug>', 'Owned agent slug to create from')
    .option('--title <title>', 'Channel title')
    .option('--description <text>', 'Channel description')
    .option('--approval-required', 'Require admin approval to join')
    .option('--public-join-permission <permission>', 'Public auto-join permission: read or read_write')
    .option('--default-join-permission <permission>', 'Alias for --public-join-permission')
    .option('--no-discoverable', 'Hide from discovery/search surfaces')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      const publicJoinPermission = resolvePublicJoinPermissionOption(options, 'read');
      await runCommandAction({
        title: 'Masumi channel create',
        options,
        run: ({ reporter }) =>
          createChannel({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            title: options.title,
            description: options.description,
            accessMode: options.approvalRequired ? 'approval_required' : 'public',
            publicJoinPermission,
            discoverable: options.discoverable !== false,
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel ${result.slug ?? slug} ${result.status}.`,
          details: [],
        }),
      });
    });

  channel
    .command('add')
    .description('Add a channel from an owned agent')
    .argument('<slug>', 'Channel slug')
    .option('--agent <slug>', 'Owned agent slug to create from')
    .option('--title <title>', 'Channel title')
    .option('--description <text>', 'Channel description')
    .option('--approval-required', 'Require admin approval to join')
    .option('--public-join-permission <permission>', 'Public auto-join permission: read or read_write')
    .option('--default-join-permission <permission>', 'Alias for --public-join-permission')
    .option('--no-discoverable', 'Hide from discovery/search surfaces')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      const publicJoinPermission = resolvePublicJoinPermissionOption(options, 'read');
      await runCommandAction({
        title: 'Masumi channel add',
        options,
        run: ({ reporter }) =>
          createChannel({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            title: options.title,
            description: options.description,
            accessMode: options.approvalRequired ? 'approval_required' : 'public',
            publicJoinPermission,
            discoverable: options.discoverable !== false,
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel ${result.slug ?? slug} ${result.status}.`,
          details: [],
        }),
      });
    });

  channel
    .command('join')
    .description('Join a public channel')
    .argument('<slug>', 'Channel slug')
    .option('--agent <slug>', 'Owned agent slug to join as')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel join',
        options,
        run: ({ reporter }) =>
          joinPublicChannel({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel ${result.slug ?? slug} ${result.status}${
            result.permission ? ` with ${formatChannelPermission(result.permission)} access` : ''
          }.`,
          details: [],
        }),
      });
    });

  channel
    .command('update')
    .description('Update channel access and discovery settings')
    .argument('<slug>', 'Channel slug')
    .option('--agent <slug>', 'Admin agent slug')
    .option('--public', 'Allow direct public joins')
    .option('--approval-required', 'Require admin approval to join')
    .option('--public-join-permission <permission>', 'Public auto-join permission: read or read_write')
    .option('--default-join-permission <permission>', 'Alias for --public-join-permission')
    .option('--discoverable', 'Show in discovery/search surfaces')
    .option('--no-discoverable', 'Hide from discovery/search surfaces')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      const accessMode = resolveAccessModeOption(options);
      const publicJoinPermission = resolvePublicJoinPermissionOption(options);
      if (
        accessMode === undefined &&
        publicJoinPermission === undefined &&
        options.discoverable === undefined
      ) {
        throw userError('Pass at least one channel setting to update.', {
          code: 'CHANNEL_SETTING_REQUIRED',
        });
      }
      await runCommandAction({
        title: 'Masumi channel update',
        options,
        run: ({ reporter }) =>
          updateChannelSettings({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            accessMode,
            publicJoinPermission,
            discoverable: options.discoverable,
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel ${result.slug ?? slug} settings updated.`,
          details: renderKeyValue([
            ...(result.accessMode ? [{ key: 'Access mode', value: result.accessMode }] : []),
            ...(result.publicJoinPermission
              ? [{ key: 'Public join permission', value: result.publicJoinPermission }]
              : []),
            ...(result.discoverable !== undefined
              ? [{ key: 'Discoverable', value: result.discoverable ? 'yes' : 'no' }]
              : []),
          ]),
        }),
      });
    });

  channel
    .command('request')
    .description('Request access to an approval-required channel')
    .argument('<slug>', 'Channel slug')
    .option('--agent <slug>', 'Owned agent slug to request as')
    .option('--permission <permission>', 'Requested permission: read or read_write', 'read')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel request',
        options,
        run: ({ reporter }) =>
          requestChannelJoin({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            permission: options.permission ?? 'read',
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel ${result.slug ?? slug} ${result.status}.`,
          details: [],
        }),
      });
    });

  channel
    .command('requests')
    .description('List visible channel join requests (pending by default)')
    .option('--incoming', 'Show only requests to channels this agent admins')
    .option('--outgoing', 'Show only requests this agent made')
    .option('--all', 'Include resolved (approved/rejected) requests')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ChannelOptions;
      if (options.incoming && options.outgoing) {
        throw new Error('Use either --incoming or --outgoing, not both.');
      }
      const direction = options.incoming
        ? ('incoming' as const)
        : options.outgoing
          ? ('outgoing' as const)
          : undefined;
      await runCommandAction({
        title: 'Masumi channel requests',
        options,
        run: ({ reporter }) =>
          listChannelJoinRequests({
            profileName: options.profile,
            direction,
            includeResolved: options.all === true,
            reporter,
          }),
        toHuman: result => ({
          summary:
            result.requests.length === 0
              ? renderEmpty('No channel join requests found.')
              : `Found ${result.requests.length.toString()} channel join request${result.requests.length === 1 ? '' : 's'}.`,
          details: renderTable(
            result.requests.map(request => ({
              id: request.id,
              channel: request.channelSlug,
              requester: request.requesterSlug,
              permission: request.permission,
              direction: request.direction,
              status: request.status,
              created: request.createdAt,
            })),
            [
              { header: 'ID', key: 'id' },
              { header: 'Channel', key: 'channel' },
              { header: 'Requester', key: 'requester' },
              { header: 'Permission', key: 'permission' },
              { header: 'Direction', key: 'direction' },
              { header: 'Status', key: 'status' },
              { header: 'Created', key: 'created' },
            ]
          ),
        }),
      });
    });

  channel
    .command('approvals')
    .description('List join approvals for one channel you administer')
    .argument('<slug>', 'Channel slug')
    .option('--agent <slug>', 'Admin agent slug')
    .option('--all', 'Include resolved (approved/rejected) requests')
    .action(async function (this: Command, slug: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel approvals',
        options,
        run: ({ reporter }) =>
          listChannelJoinRequests({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            direction: 'incoming',
            includeResolved: options.all === true,
            requireAdmin: true,
            reporter,
          }),
        toHuman: result => ({
          summary:
            result.requests.length === 0
              ? renderEmpty(`No channel join approvals found for #${slug}.`)
              : `Found ${result.requests.length.toString()} channel join approval${result.requests.length === 1 ? '' : 's'} for #${slug}.`,
          details: renderTable(
            result.requests.map(request => ({
              id: request.id,
              requester: request.requesterSlug,
              permission: request.permission,
              status: request.status,
              created: request.createdAt,
            })),
            [
              { header: 'ID', key: 'id' },
              { header: 'Requester', key: 'requester' },
              { header: 'Permission', key: 'permission' },
              { header: 'Status', key: 'status' },
              { header: 'Created', key: 'created' },
            ]
          ),
        }),
      });
    });

  channel
    .command('approve')
    .description('Approve a channel join request')
    .argument('<requestId>', 'Visible request id')
    .option('--agent <slug>', 'Admin agent slug')
    .option('--permission <permission>', 'Granted permission')
    .action(async function (this: Command, requestId: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel approve',
        options,
        run: ({ reporter }) =>
          approveChannelJoin({
            profileName: options.profile,
            actorSlug: options.agent,
            requestId,
            permission: options.permission,
            selectPermission: options.permission || options.json || !process.stdin.isTTY || !process.stdout.isTTY
              ? undefined
              : request =>
                  promptChoice({
                    question: `Approve ${request.requesterSlug} for #${request.channelSlug} as`,
                    defaultValue:
                      request.permission === 'read_write' ? 'read_write' : 'read',
                    options: [
                      { value: 'read', label: 'Read only' },
                      { value: 'read_write', label: 'Read/write' },
                      { value: 'admin', label: 'Admin' },
                    ],
                  }),
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel request ${requestId} ${result.status}${
            result.permission ? ` as ${formatChannelPermission(result.permission)}` : ''
          }.`,
          details: [],
        }),
      });
    });

  channel
    .command('reject')
    .description('Reject a channel join request')
    .argument('<requestId>', 'Visible request id')
    .option('--agent <slug>', 'Admin agent slug')
    .action(async function (this: Command, requestId: string) {
      const options = this.optsWithGlobals() as ChannelOptions;
      await runCommandAction({
        title: 'Masumi channel reject',
        options,
        run: ({ reporter }) =>
          rejectChannelJoin({
            profileName: options.profile,
            actorSlug: options.agent,
            requestId,
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel request ${requestId} ${result.status}.`,
          details: [],
        }),
      });
    });

  channel
    .command('permission')
    .description('Set a channel member permission as an admin')
    .argument('<slug>', 'Channel slug')
    .argument('<memberAgentDbId>', 'Member agent row id')
    .argument('<permission>', 'read, read_write, or admin')
    .option('--agent <slug>', 'Admin agent slug')
    .action(
      async function (
        this: Command,
        slug: string,
        memberAgentDbId: string,
        permission: string
      ) {
        const options = this.optsWithGlobals() as ChannelOptions;
        await runCommandAction({
          title: 'Masumi channel permission',
          options,
          run: ({ reporter }) =>
            setChannelMemberPermission({
              profileName: options.profile,
              actorSlug: options.agent,
              slug,
              memberAgentDbId,
              permission,
              reporter,
            }),
          toHuman: result => ({
            summary: `Channel ${result.slug ?? slug} ${result.status}.`,
            details: [],
          }),
        });
      }
    );

  channel
    .command('remove')
    .description('Remove a channel member (destructive; requires --confirm)')
    .argument('<slug>', 'Channel slug')
    .argument('<memberAgentDbId>', 'Member agent row id')
    .option('--agent <slug>', 'Admin agent slug')
    .option('--confirm', 'Confirm the destructive removal', false)
    .action(async function (this: Command, slug: string, memberAgentDbId: string) {
      const options = this.optsWithGlobals() as ChannelOptions & { confirm?: boolean };
      if (!options.confirm) {
        throw userError(
          `Refusing to remove member ${memberAgentDbId} from channel \`${slug}\` without --confirm. Re-run with --confirm to proceed.`,
          { code: 'CHANNEL_REMOVE_CONFIRM_REQUIRED' }
        );
      }
      await runCommandAction({
        title: 'Masumi channel remove',
        options,
        run: ({ reporter }) =>
          removeChannelMember({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            memberAgentDbId,
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel ${result.slug ?? slug} ${result.status}.`,
          details: [],
        }),
      });
    });

  channel
    .command('send')
    .description('Send a signed channel message')
    .argument('<slug>', 'Channel slug')
    .argument('[message...]', 'Message text')
    .option('--agent <slug>', 'Owned agent slug to send as')
    .option('--content-type <mime>', 'Message content type')
    .action(async function (
      this: Command,
      slug: string,
      messageParts: string[] | undefined
    ) {
      const options = this.optsWithGlobals() as ChannelOptions;
      const message = (messageParts ?? []).join(' ').trim();
      await runCommandAction({
        title: 'Masumi channel send',
        options,
        run: ({ reporter }) =>
          sendChannelMessage({
            profileName: options.profile,
            actorSlug: options.agent,
            slug,
            message,
            contentType: options.contentType,
            reporter,
          }),
        toHuman: result => ({
          summary: `Channel ${result.slug ?? slug} ${result.status}.`,
          details: [],
        }),
      });
    });
}
