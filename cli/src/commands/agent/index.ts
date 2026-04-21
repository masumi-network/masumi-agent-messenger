import type { Command } from 'commander';
import { getMasumiInboxAgentNetwork } from '../../../../shared/inbox-agent-registration';
import {
  getOwnedAgentProfile,
  listOwnedAgents,
  resolvePreferredAgentSlug,
  updateOwnedAgentMessageCapabilities,
  updateOwnedAgentProfile,
  useOwnedAgent,
  type OwnedAgentMessageCapabilities,
} from '../../services/agent-state';
import { listThreads } from '../../services/thread';
import { formatRelativeTime } from '../../services/format';
import {
  addContactAllowlist,
  listContactAllowlist,
  removeContactAllowlist,
} from '../../services/contact-management';
import { userError } from '../../services/errors';
import { createInboxIdentity, registerInboxAgent, rotateInboxKeys } from '../../services/inbox-management';
import { resolveRotationDeviceSelection } from '../../services/key-rotation-device-selection';
import { maybeOfferBackupAfterKeyCreation } from '../../services/key-backup-prompt';
import { resolvePublicDescriptionOption } from '../../services/public-description';
import {
  confirmYesNo,
  promptMultiline,
  waitForEnterMessage,
} from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import {
  badge,
  bold,
  cyan,
  dim,
  green,
  renderEmptyWithTry,
  renderKeyValue,
  renderTable,
  yellow,
  type TableColumn,
} from '../../services/render';
import { showCommandHelp } from '../menu';

type AgentContextOptions = GlobalOptions & {
  agent?: string;
};

type AgentListOptions = GlobalOptions & {
  sort?: 'unread' | 'name' | 'updated';
  view?: 'compact' | 'detailed';
};

type AgentCreateOptions = GlobalOptions & {
  slug?: string;
  displayName?: string;
  skipAgentRegistration?: boolean;
  disableLinkedEmail?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
};

type AgentUpdateOptions = AgentContextOptions & {
  displayName?: string;
  clearDisplayName?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
  clearPublicDescription?: boolean;
  linkedEmail?: string;
};

type AgentNetworkOptions = AgentContextOptions & {
  disableLinkedEmail?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
};

type AgentAllowlistMutateOptions = AgentContextOptions & {
  identifier?: string;
};

type AgentRotateOptions = AgentContextOptions & {
  shareDevice?: string[];
  revokeDevice?: string[];
};

type AgentMessageMutateOptions = AgentContextOptions;

function normalizeLinkedEmailVisibility(
  value: string | undefined
): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['visible', 'show', 'on', 'true', 'yes'].includes(normalized)) {
    return true;
  }
  if (['hidden', 'hide', 'off', 'false', 'no'].includes(normalized)) {
    return false;
  }
  throw userError('Linked email visibility must be `visible` or `hidden`.', {
    code: 'INVALID_LINKED_EMAIL_VISIBILITY',
  });
}

function splitAllowlistIdentifier(identifier: string): { agent?: string; email?: string } {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw userError('Allowlist identifier is required.', {
      code: 'CONTACT_ALLOWLIST_INPUT_INVALID',
    });
  }

  const normalized = trimmed.toLowerCase();
  return normalized.includes('@') ? { email: normalized } : { agent: normalized };
}

function formatMessageCapabilitiesList(
  values: readonly string[],
  allowAll: boolean
): string {
  if (allowAll) {
    return green('all');
  }
  return values.length > 0 ? values.join(', ') : yellow('none');
}

function renderMessageCapabilities(
  capabilities: OwnedAgentMessageCapabilities
): ReturnType<typeof renderKeyValue> {
  return renderKeyValue([
    {
      key: 'Content types',
      value: formatMessageCapabilitiesList(
        capabilities.supportedContentTypes,
        capabilities.allowAllContentTypes
      ),
    },
    {
      key: 'Headers',
      value: formatMessageCapabilitiesList(
        capabilities.supportedHeaders,
        capabilities.allowAllHeaders
      ),
    },
  ]);
}

function renderMessageCapabilitiesDiff(
  before: OwnedAgentMessageCapabilities,
  after: OwnedAgentMessageCapabilities
): string[] {
  return [
    dim('Before'),
    ...renderMessageCapabilities(before),
    '',
    dim('After'),
    ...renderMessageCapabilities(after),
  ];
}

function inferAllowAllFromSelection(values: readonly string[]): boolean {
  return values.length === 0;
}

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command('agent')
    .description('Owned agent identity, profile, allowlist, and network commands');

  agent.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  agent
    .command('list')
    .description('List owned agents for the current account')
    .option('--sort <field>', 'Sort by: unread|name|updated', 'updated')
    .option('--view <mode>', 'Output view: compact|detailed', 'compact')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AgentListOptions;
      await runCommandAction({
        title: 'Masumi agent list',
        options,
        run: async ({ reporter }) => {
          const { sort, view } = {
            sort: options.sort ?? 'updated',
            view: options.view ?? 'compact',
          };

          const agentsResult = await listOwnedAgents({
            profileName: options.profile,
            reporter,
          });

          const rows: Array<{
            slug: string;
            name: string;
            identity: string;
            flags: string[];
            unreadTotal: number;
            updatedAt: string;
          }> = [];

          for (const agentItem of agentsResult.agents) {
            const threadState = await listThreads({
              profileName: options.profile,
              actorSlug: agentItem.slug,
              includeArchived: false,
              reporter,
            });

            const unreadTotal = threadState.threads.reduce((sum, thread) => {
              return sum + thread.unreadMessages;
            }, 0);

            const updatedAt =
              threadState.threads
                .map(c => c.lastMessageAt)
                .filter(Boolean)
                .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';

            const flags: string[] = [];
            if (agentItem.isActive) flags.push('active');
            if (agentItem.isDefault) flags.push('default');
            flags.push(agentItem.managed ? 'managed' : 'unmanaged');
            flags.push(agentItem.registered ? 'published' : 'unpublished');

            rows.push({
              slug: agentItem.slug,
              name: agentItem.displayName ?? agentItem.slug,
              identity: agentItem.publicIdentity,
              flags,
              unreadTotal,
              updatedAt,
            });
          }

          const sortedRows = [...rows].sort((a, b) => {
            if (sort === 'name') {
              return a.name.localeCompare(b.name);
            }

            if (sort === 'unread') {
              if (a.unreadTotal !== b.unreadTotal) return b.unreadTotal - a.unreadTotal;
              return a.name.localeCompare(b.name);
            }

            // updated (default)
            const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
            const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
            if (aTime !== bTime) return bTime - aTime;
            if (a.unreadTotal !== b.unreadTotal) return b.unreadTotal - a.unreadTotal;
            return a.name.localeCompare(b.name);
          });

          return {
            ...agentsResult,
            sort,
            view,
            rows: sortedRows,
          };
        },
        toHuman: result => {
          const view = result.view ?? 'compact';

          const columns: TableColumn[] =
            view === 'detailed'
              ? [
                  { header: 'Agent', key: 'slug', color: cyan },
                  { header: 'Name', key: 'name' },
                  { header: 'Flags', key: 'flags' },
                  { header: 'Identity', key: 'identity', color: dim },
                  { header: 'Unread', key: 'unread', align: 'right' },
                  { header: 'Updated', key: 'updated', color: dim },
                ]
              : [
                  { header: 'Agent', key: 'slug', color: cyan },
                  { header: 'Name', key: 'name' },
                  { header: 'Unread', key: 'unread', align: 'right' },
                  { header: 'Updated', key: 'updated', color: dim },
                ];

          const FLAG_COLORS: Record<string, (value: string) => string> = {
            active: green,
            default: dim,
            managed: green,
            unmanaged: yellow,
            published: green,
            unpublished: yellow,
          };
          const renderFlags = (flags: readonly string[]): string =>
            flags
              .map(flag => badge(flag, FLAG_COLORS[flag] ?? dim))
              .join(' ');

          return {
            summary:
              result.agents.length > 0
                ? `${bold(String(result.agents.length))} owned agent${
                    result.agents.length === 1 ? '' : 's'
                  }.`
                : renderEmptyWithTry('No owned agents found.', 'masumi-agent-messenger auth sync'),
            details:
              result.agents.length === 0
                ? []
                : renderTable(
                    result.rows.map(row => ({
                      slug: row.slug,
                      name: row.name,
                      flags: renderFlags(row.flags),
                      identity: row.identity,
                      unread: row.unreadTotal > 0 ? badge(`${row.unreadTotal} new`, green) : '',
                      updated: row.updatedAt ? formatRelativeTime(row.updatedAt) : '',
                    })),
                    columns
                  ),
          };
        },
      });
    });

  agent
    .command('create')
    .description('Create a new owned agent slug')
    .argument('<slug>', 'Agent slug to create')
    .option('--display-name <name>', 'Optional agent display name')
    .option('--skip-agent-registration', 'Skip managed agent registration after creation')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option('--public-description <text>', 'Public description to publish when registration runs automatically')
    .option('--public-description-file <path>', 'Read the public description from a local file when registration runs automatically')
    .action(async function (this: Command, slugArg: string) {
      const options = this.optsWithGlobals() as AgentCreateOptions;
      await runCommandAction({
        title: 'Masumi agent create',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) =>
          createInboxIdentity({
            profileName: options.profile,
            slug: slugArg,
            displayName: options.displayName,
            reporter,
            registrationMode: options.skipAgentRegistration
              ? 'skip'
              : options.json
                ? 'auto'
                : 'prompt',
            desiredLinkedEmailVisibility: !options.disableLinkedEmail,
            desiredPublicDescription: await resolvePublicDescriptionOption({
              description: options.publicDescription,
              descriptionFile: options.publicDescriptionFile,
            }),
            confirmRegistration: async ({ actorSlug, displayName, creditsRemaining }) =>
              confirmYesNo({
                question: `Create managed agent for ${displayName ?? actorSlug} on ${getMasumiInboxAgentNetwork()}? Credits: ${creditsRemaining ?? 'unknown'}.`,
                defaultValue: true,
              }),
            confirmLinkedEmailVisibility: async ({ actorSlug }) =>
              confirmYesNo({
                question: `Expose linked email on /${actorSlug}/public?`,
                defaultValue: true,
              }),
            confirmPublicDescription: async ({ actorSlug }) => {
              const shouldSetDescription = await confirmYesNo({
                question: `Set a public description on /${actorSlug}/public now?`,
                defaultValue: false,
              });
              if (!shouldSetDescription) {
                return null;
              }
              const description = await promptMultiline({
                question: 'Enter the public description markdown.',
              });
              return description || null;
            },
            pauseAfterRegistrationBlocked: async message => {
              await waitForEnterMessage(`${message} Press Enter to continue.`);
            },
          }).then(async result => {
            if (!options.json) {
              await maybeOfferBackupAfterKeyCreation({
                profileName: options.profile,
                reporter,
                promptLabel: `Agent ${result.actor.slug} was created successfully.`,
              });
            }
            return result;
          }),
        toHuman: result => ({
          summary: `Created agent ${cyan(result.actor.slug)}.`,
          details: renderKeyValue([
            ...(result.actor.displayName
              ? [{ key: 'Display name', value: result.actor.displayName }]
              : []),
            {
              key: 'Agent',
              value: result.registration.status,
              color: result.registration.status === 'registered' ? green : yellow,
            },
            ...(result.registration.agentIdentifier
              ? [{ key: 'Agent ID', value: result.registration.agentIdentifier, color: dim }]
              : []),
            ...(result.registration.creditsRemaining !== null &&
            result.registration.creditsRemaining !== undefined
              ? [{ key: 'Credits', value: String(result.registration.creditsRemaining) }]
              : []),
            ...(result.registration.error
              ? [{ key: 'Registration note', value: result.registration.error, color: yellow }]
              : []),
          ]),
        }),
      });
    });

  agent
    .command('use')
    .description('Persist the active agent for this CLI profile')
    .argument('<slug>', 'Owned agent slug to make active')
    .action(async function (this: Command, slugArg: string) {
      const options = this.optsWithGlobals() as GlobalOptions;
      await runCommandAction({
        title: 'Masumi agent use',
        options,
        run: ({ reporter }) =>
          useOwnedAgent({
            profileName: options.profile,
            reporter,
            actorSlug: slugArg,
          }),
        toHuman: result => ({
          summary: `Active agent set to ${cyan(result.activeAgentSlug)}.`,
          details: renderKeyValue([
            { key: 'Identity', value: result.agent.publicIdentity, color: dim },
            {
              key: 'Managed',
              value: result.agent.managed ? green('yes') : yellow('no'),
            },
          ]),
        }),
      });
    });

  agent
    .command('show')
    .description('Show one owned agent and its public/profile state')
    .argument('[slug]', 'Owned agent slug (defaults to the active agent)')
    .option('--agent <slug>', 'Owned agent slug to inspect')
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as AgentContextOptions;
      await runCommandAction({
        title: 'Masumi agent show',
        options,
        run: ({ reporter }) =>
          getOwnedAgentProfile({
            profileName: options.profile,
            reporter,
            actorSlug: slugArg ?? options.agent,
          }),
        toHuman: result => ({
          summary: `Showing agent ${cyan(result.agent.slug)}.`,
          details: [
            dim('Identity'),
            ...renderKeyValue([
              { key: 'Display name', value: result.agent.displayName ?? 'n/a' },
              { key: 'Active', value: result.agent.isActive ? green('yes') : 'no' },
              { key: 'Default', value: result.agent.isDefault ? green('yes') : 'no' },
              { key: 'Identity', value: result.agent.publicIdentity, color: dim },
              {
                key: 'Linked email',
                value: result.agent.publicLinkedEmailEnabled ? green('visible') : yellow('hidden'),
              },
              { key: 'Description', value: result.agent.publicDescription ?? 'not set' },
            ]),
            dim('Network registration'),
            ...renderKeyValue([
              ...(result.agent.registrationNetwork
                ? [{ key: 'Network', value: result.agent.registrationNetwork }]
                : []),
              ...(result.agent.agentIdentifier
                ? [{ key: 'Agent ID', value: result.agent.agentIdentifier, color: dim }]
                : []),
              ...(result.agent.registrationState
                ? [{ key: 'Registration', value: result.agent.registrationState }]
                : []),
            ]),
            dim('Message policy'),
            ...renderMessageCapabilities(result.agent.messageCapabilities),
            dim('Security posture'),
            ...renderKeyValue([
              {
                key: 'Managed',
                value: result.agent.managed ? green('yes') : yellow('no'),
              },
              {
                key: 'Registered',
                value: result.agent.registered ? green('yes') : yellow('no'),
              },
            ]),
          ],
        }),
      });
    });

  agent
    .command('update')
    .description('Update one owned agent profile')
    .argument('[slug]', 'Owned agent slug (defaults to the active agent)')
    .option('--agent <slug>', 'Owned agent slug to update')
    .option('--display-name <name>', 'Set the agent display name')
    .option('--clear-display-name', 'Clear the agent display name')
    .option('--public-description <text>', 'Set the public description')
    .option('--public-description-file <path>', 'Read the public description from a file')
    .option('--clear-public-description', 'Clear the public description')
    .option('--linked-email <visibility>', 'Set linked email visibility to visible or hidden')
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as AgentUpdateOptions;
      const publicDescription = options.clearPublicDescription
        ? undefined
        : await resolvePublicDescriptionOption({
            description: options.publicDescription,
            descriptionFile: options.publicDescriptionFile,
          });

      await runCommandAction({
        title: 'Masumi agent update',
        options,
        run: ({ reporter }) =>
          updateOwnedAgentProfile({
            profileName: options.profile,
            reporter,
            actorSlug: slugArg ?? options.agent,
            displayName: options.displayName,
            clearDisplayName: options.clearDisplayName,
            publicDescription,
            clearPublicDescription: options.clearPublicDescription,
            publicLinkedEmailEnabled: normalizeLinkedEmailVisibility(options.linkedEmail),
          }),
        toHuman: result => ({
          summary: `Updated agent ${cyan(result.agent.slug)}.`,
          details: renderKeyValue([
            { key: 'Display name', value: result.agent.displayName ?? 'not set' },
            {
              key: 'Linked email',
              value: result.agent.publicLinkedEmailEnabled ? green('visible') : yellow('hidden'),
            },
            { key: 'Description', value: result.agent.publicDescription ?? 'not set' },
          ]),
        }),
      });
    });

  const message = agent
    .command('message')
    .description('Manage public message capability policy for one owned agent');
  message.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  message
    .command('show')
    .description('Show the public message capabilities for one owned agent')
    .argument('[slug]', 'Owned agent slug (defaults to the active agent)')
    .option('--agent <slug>', 'Owned agent slug to inspect')
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as AgentContextOptions;
      await runCommandAction({
        title: 'Masumi agent message show',
        options,
        run: ({ reporter }) =>
          getOwnedAgentProfile({
            profileName: options.profile,
            reporter,
            actorSlug: slugArg ?? options.agent,
          }),
        toHuman: result => ({
          summary: `Showing message policy for ${cyan(result.agent.slug)}.`,
          details: renderMessageCapabilities(result.agent.messageCapabilities),
        }),
      });
    });

  const contentType = message
    .command('content-type')
    .description('Manage advertised public content types');
  contentType.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  contentType
    .command('add')
    .description('Allow one explicit content type and switch to an explicit content-type list')
    .argument('<mime>', 'Content type to advertise')
    .option('--agent <slug>', 'Owned agent slug to update')
    .action(async function (this: Command, mime: string) {
      const options = this.optsWithGlobals() as AgentMessageMutateOptions;
      let beforeMessageCapabilities: OwnedAgentMessageCapabilities | null = null;
      await runCommandAction({
        title: 'Masumi agent message content-type add',
        options,
        run: async ({ reporter }) => {
          const profile = await getOwnedAgentProfile({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
          });
          beforeMessageCapabilities = profile.agent.messageCapabilities;
          const nextContentTypes = profile.agent.messageCapabilities.supportedContentTypes.includes(
            mime
          )
            ? profile.agent.messageCapabilities.supportedContentTypes
            : [...profile.agent.messageCapabilities.supportedContentTypes, mime];
          return updateOwnedAgentMessageCapabilities({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
            allowAllContentTypes: inferAllowAllFromSelection(nextContentTypes),
            supportedContentTypes: nextContentTypes,
          });
        },
        toHuman: result => ({
          summary: `Allowed content type ${cyan(mime)} for ${result.agent.slug}.`,
          details: renderMessageCapabilitiesDiff(
            beforeMessageCapabilities ?? result.agent.messageCapabilities,
            result.agent.messageCapabilities
          ),
        }),
      });
    });

  contentType
    .command('remove')
    .description('Remove one explicit content type; empty selection returns to default allow-all')
    .argument('<mime>', 'Content type to remove')
    .option('--agent <slug>', 'Owned agent slug to update')
    .action(async function (this: Command, mime: string) {
      const options = this.optsWithGlobals() as AgentMessageMutateOptions;
      let beforeMessageCapabilities: OwnedAgentMessageCapabilities | null = null;
      await runCommandAction({
        title: 'Masumi agent message content-type remove',
        options,
        run: async ({ reporter }) => {
          const profile = await getOwnedAgentProfile({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
          });
          beforeMessageCapabilities = profile.agent.messageCapabilities;
          const nextContentTypes = profile.agent.messageCapabilities.supportedContentTypes.filter(
            existing => existing !== mime
          );
          return updateOwnedAgentMessageCapabilities({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
            allowAllContentTypes: inferAllowAllFromSelection(nextContentTypes),
            supportedContentTypes: nextContentTypes,
          });
        },
        toHuman: result => ({
          summary: `Removed content type ${cyan(mime)} from ${result.agent.slug}.`,
          details: renderMessageCapabilitiesDiff(
            beforeMessageCapabilities ?? result.agent.messageCapabilities,
            result.agent.messageCapabilities
          ),
        }),
      });
    });

  const header = message
    .command('header')
    .description('Manage advertised public encrypted headers');
  header.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  header
    .command('add')
    .description('Allow one explicit header and switch to an explicit header list')
    .argument('<name>', 'Header name to advertise')
    .option('--agent <slug>', 'Owned agent slug to update')
    .action(async function (this: Command, name: string) {
      const options = this.optsWithGlobals() as AgentMessageMutateOptions;
      let beforeMessageCapabilities: OwnedAgentMessageCapabilities | null = null;
      await runCommandAction({
        title: 'Masumi agent message header add',
        options,
        run: async ({ reporter }) => {
          const profile = await getOwnedAgentProfile({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
          });
          beforeMessageCapabilities = profile.agent.messageCapabilities;
          const nextHeaders = profile.agent.messageCapabilities.supportedHeaders.includes(name)
            ? profile.agent.messageCapabilities.supportedHeaders
            : [...profile.agent.messageCapabilities.supportedHeaders, name];
          return updateOwnedAgentMessageCapabilities({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
            allowAllHeaders: inferAllowAllFromSelection(nextHeaders),
            supportedHeaders: nextHeaders,
          });
        },
        toHuman: result => ({
          summary: `Allowed header ${cyan(name)} for ${result.agent.slug}.`,
          details: renderMessageCapabilitiesDiff(
            beforeMessageCapabilities ?? result.agent.messageCapabilities,
            result.agent.messageCapabilities
          ),
        }),
      });
    });

  header
    .command('remove')
    .description('Remove one explicit header; empty selection returns to default allow-all')
    .argument('<name>', 'Header name to remove')
    .option('--agent <slug>', 'Owned agent slug to update')
    .action(async function (this: Command, name: string) {
      const options = this.optsWithGlobals() as AgentMessageMutateOptions;
      let beforeMessageCapabilities: OwnedAgentMessageCapabilities | null = null;
      await runCommandAction({
        title: 'Masumi agent message header remove',
        options,
        run: async ({ reporter }) => {
          const profile = await getOwnedAgentProfile({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
          });
          beforeMessageCapabilities = profile.agent.messageCapabilities;
          const nextHeaders = profile.agent.messageCapabilities.supportedHeaders.filter(
            existing => existing !== name
          );
          return updateOwnedAgentMessageCapabilities({
            profileName: options.profile,
            reporter,
            actorSlug: options.agent,
            allowAllHeaders: inferAllowAllFromSelection(nextHeaders),
            supportedHeaders: nextHeaders,
          });
        },
        toHuman: result => ({
          summary: `Removed header ${cyan(name)} from ${result.agent.slug}.`,
          details: renderMessageCapabilitiesDiff(
            beforeMessageCapabilities ?? result.agent.messageCapabilities,
            result.agent.messageCapabilities
          ),
        }),
      });
    });

  message
    .command('allow-all')
    .description('Enable true wildcard content-type and header acceptance for one agent')
    .argument('[slug]', 'Owned agent slug (defaults to the active agent)')
    .option('--agent <slug>', 'Owned agent slug to update')
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as AgentContextOptions;
      await runCommandAction({
        title: 'Masumi agent message allow-all',
        options,
        run: ({ reporter }) =>
          updateOwnedAgentMessageCapabilities({
            profileName: options.profile,
            reporter,
            actorSlug: slugArg ?? options.agent,
            allowAllContentTypes: true,
            allowAllHeaders: true,
            supportedContentTypes: [],
            supportedHeaders: [],
          }),
        toHuman: result => ({
          summary: `Enabled true allow-all message policy for ${cyan(result.agent.slug)}.`,
          details: renderMessageCapabilities(result.agent.messageCapabilities),
        }),
      });
    });

  message
    .command('reset-defaults')
    .description('Restore the default allow-all message capability policy for one agent')
    .argument('[slug]', 'Owned agent slug (defaults to the active agent)')
    .option('--agent <slug>', 'Owned agent slug to update')
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as AgentContextOptions;
      await runCommandAction({
        title: 'Masumi agent message reset-defaults',
        options,
        run: ({ reporter }) =>
          updateOwnedAgentMessageCapabilities({
            profileName: options.profile,
            reporter,
            actorSlug: slugArg ?? options.agent,
            allowAllContentTypes: true,
            allowAllHeaders: true,
            supportedContentTypes: [],
            supportedHeaders: [],
          }),
        toHuman: result => ({
          summary: `Reset message policy to the default allow-all mode for ${cyan(result.agent.slug)}.`,
          details: renderMessageCapabilities(result.agent.messageCapabilities),
        }),
      });
    });

  const network = agent
    .command('network')
    .description('Managed Masumi network registration commands');
  network.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  network
    .command('sync')
    .description('Register or resync a managed agent on the Masumi network')
    .argument('[slug]', 'Owned agent slug (defaults to the active agent)')
    .option('--agent <slug>', 'Owned agent slug to register or sync')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option('--public-description <text>', 'Public description to publish when registration runs automatically')
    .option('--public-description-file <path>', 'Read the public description from a local file when registration runs automatically')
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as AgentNetworkOptions;
      const selectedAgentSlug =
        (slugArg ?? options.agent) ?? (await resolvePreferredAgentSlug(options.profile));
      await runCommandAction({
        title: 'Masumi agent network sync',
        options,
        run: async ({ reporter }) =>
          registerInboxAgent({
            profileName: options.profile,
            actorSlug: selectedAgentSlug,
            reporter,
            registrationMode: options.json ? 'auto' : 'prompt',
            desiredLinkedEmailVisibility: !options.disableLinkedEmail,
            desiredPublicDescription: await resolvePublicDescriptionOption({
              description: options.publicDescription,
              descriptionFile: options.publicDescriptionFile,
            }),
            confirmRegistration: async ({ actorSlug, displayName, creditsRemaining }) =>
              confirmYesNo({
                question: `Create managed agent for ${displayName ?? actorSlug} on ${getMasumiInboxAgentNetwork()}? Credits: ${creditsRemaining ?? 'unknown'}.`,
                defaultValue: true,
              }),
            confirmLinkedEmailVisibility: async ({ actorSlug }) =>
              confirmYesNo({
                question: `Expose linked email on /${actorSlug}/public?`,
                defaultValue: true,
              }),
            confirmPublicDescription: async ({ actorSlug }) => {
              const shouldSetDescription = await confirmYesNo({
                question: `Set a public description on /${actorSlug}/public now?`,
                defaultValue: false,
              });
              if (!shouldSetDescription) {
                return null;
              }
              const description = await promptMultiline({
                question: 'Enter the public description markdown.',
              });
              return description || null;
            },
            pauseAfterRegistrationBlocked: async message => {
              await waitForEnterMessage(`${message} Press Enter to continue.`);
            },
          }),
        toHuman: result => ({
          summary:
            result.registration.status === 'registered'
              ? green('Managed agent is registered.')
              : yellow(`Managed agent status: ${result.registration.status}.`),
          details: renderKeyValue([
            { key: 'Agent', value: result.actor.slug, color: cyan },
            ...(result.registration.agentIdentifier
              ? [{ key: 'Agent ID', value: result.registration.agentIdentifier, color: dim }]
              : []),
            ...(result.registration.creditsRemaining !== null &&
            result.registration.creditsRemaining !== undefined
              ? [{ key: 'Credits', value: String(result.registration.creditsRemaining) }]
              : []),
          ]),
        }),
      });
    });

  const allowlist = agent
    .command('allowlist')
    .description('Manage standing first-contact allowlist entries');
  allowlist.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  allowlist
    .command('list')
    .description('List allowlist entries for the selected agent')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AgentContextOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      await runCommandAction({
        title: 'Masumi agent allowlist list',
        options,
        run: ({ reporter }) =>
          listContactAllowlist({
            profileName: options.profile,
            reporter,
            actorSlug,
          }),
        toHuman: result => {
          const columns: TableColumn[] = [
            { header: 'Kind', key: 'kind' },
            { header: 'Value', key: 'value', color: cyan },
            { header: 'Label', key: 'label' },
            { header: 'Created', key: 'created', color: dim },
          ];
          return {
            summary:
              result.total > 0
                ? `${bold(String(result.total))} allowlist entr${result.total === 1 ? 'y' : 'ies'}.`
                : renderEmptyWithTry(
                    'No allowlist entries.',
                    'masumi-agent-messenger agent allowlist add <identifier>'
                  ),
            details:
              result.total === 0
                ? []
                : renderTable(
                    result.entries.map(entry => ({
                      kind: entry.kind,
                      value: entry.value,
                      label: entry.label ?? '',
                      created: entry.createdAt,
                    })),
                    columns
                  ),
          };
        },
      });
    });

  allowlist
    .command('add')
    .description('Add an allowlist entry for the selected agent')
    .argument('<identifier>', 'Agent slug/public identity or email address')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .action(async function (this: Command, identifier: string) {
      const options = this.optsWithGlobals() as AgentAllowlistMutateOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      const target = splitAllowlistIdentifier(identifier);
      const normalizedTarget = target.agent ?? target.email ?? '';
      await runCommandAction({
        title: 'Masumi agent allowlist add',
        options,
        run: ({ reporter }) => {
          reporter.info(`Normalized target: ${cyan(normalizedTarget)}`);
          return addContactAllowlist({
            profileName: options.profile,
            reporter,
            actorSlug,
            ...target,
          });
        },
        toHuman: result => ({
          summary: `Added ${result.kind} allowlist entry ${cyan(result.value)}.`,
          details: renderKeyValue([
            { key: 'Normalized target', value: result.value, color: cyan },
          ]),
        }),
      });
    });

  allowlist
    .command('remove')
    .description('Remove an allowlist entry for the selected agent')
    .argument('<identifier>', 'Agent slug/public identity or email address')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .action(async function (this: Command, identifier: string) {
      const options = this.optsWithGlobals() as AgentAllowlistMutateOptions;
      const actorSlug = await resolvePreferredAgentSlug(options.profile, options.agent);
      const target = splitAllowlistIdentifier(identifier);
      const normalizedTarget = target.agent ?? target.email ?? '';
      await runCommandAction({
        title: 'Masumi agent allowlist remove',
        options,
        run: ({ reporter }) => {
          reporter.info(`Normalized target: ${cyan(normalizedTarget)}`);
          return removeContactAllowlist({
            profileName: options.profile,
            reporter,
            actorSlug,
            ...target,
          });
        },
        toHuman: result => ({
          summary: `Removed ${result.kind} allowlist entry ${cyan(result.value)}.`,
          details: renderKeyValue([
            { key: 'Normalized target', value: result.value, color: cyan },
          ]),
        }),
      });
    });

  const key = agent.command('key').description('Owned agent key-management commands');
  key.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  key
    .command('rotate')
    .description('Rotate agent encryption and signing keys')
    .argument('[slug]', 'Owned agent slug (defaults to the active agent)')
    .option('--agent <slug>', 'Owned agent slug whose keys should rotate')
    .option(
      '--share-device <id>',
      'Approved device id that should receive the rotated key snapshot',
      (value: string, existing: string[] = []) => [...existing, value],
      []
    )
    .option(
      '--revoke-device <id>',
      'Device id that should be revoked during key rotation',
      (value: string, existing: string[] = []) => [...existing, value],
      []
    )
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as AgentRotateOptions;
      const actorSlug =
        (slugArg ?? options.agent) ?? (await resolvePreferredAgentSlug(options.profile));
      await runCommandAction({
        title: 'Masumi agent key rotate',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) => {
          const deviceSelection = await resolveRotationDeviceSelection({
            profileName: options.profile,
            json: options.json,
            reporter,
            explicitShareDeviceIds: options.shareDevice ?? [],
            explicitRevokeDeviceIds: options.revokeDevice ?? [],
          });
          const { shareDeviceIds, revokeDeviceIds } = deviceSelection;

          if (revokeDeviceIds.length > 0) {
            reporter.info(
              `${badge('risk', yellow)} Revoking devices disables future decryption for those devices. Ensure you have a fresh encrypted backup before continuing.`
            );
            reporter.info(
              `Impacted devices: ${revokeDeviceIds.map(d => cyan(d)).join(', ')}`
            );
            reporter.info(`Backup reminder: masumi-agent-messenger auth backup export`);
          }

          const result = await rotateInboxKeys({
            profileName: options.profile,
            actorSlug,
            shareDeviceIds,
            shareAllApprovedDevices: deviceSelection.shareAllApprovedDevices,
            revokeDeviceIds,
            reporter,
          });

          if (!options.json) {
            await maybeOfferBackupAfterKeyCreation({
              profileName: options.profile,
              reporter,
              promptLabel: `Agent keys for ${result.actor.slug} were rotated.`,
            });
          }

          return result;
        },
        toHuman: result => ({
          summary: `Rotated keys for ${cyan(result.actor.slug)}.`,
          details: renderKeyValue([
            ...(result.sharedDeviceIds.length > 0
              ? [{ key: 'Shared to', value: result.sharedDeviceIds.join(', ') }]
              : []),
            ...(result.revokedDeviceIds.length > 0
              ? [
                  {
                    key: 'Revoked',
                    value: result.revokedDeviceIds.join(', '),
                    color: yellow,
                  },
                  {
                    key: 'Backup reminder',
                    value: 'Run `masumi-agent-messenger auth backup export` before revoking more devices.',
                    color: yellow,
                  },
                ]
              : []),
          ]),
        }),
      });
    });
}
