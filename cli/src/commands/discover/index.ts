import type { Command } from 'commander';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { discoverAgents, showDiscoveredAgent } from '../../services/discover';
import {
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
import { userError } from '../../services/errors';

type DiscoverOptions = GlobalOptions & {
  agent?: string;
  page?: number;
  take?: number;
  allowPending?: boolean;
};

function formatBoolean(value: boolean): string {
  return value ? green('yes') : yellow('no');
}

function formatOptionalBoolean(value: boolean | null): string {
  if (value === null) {
    return dim('n/a');
  }
  return formatBoolean(value);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw userError(`${label} must be a positive integer.`, {
      code: `INVALID_${label.toUpperCase().replace(/\s+/g, '_')}`,
    });
  }
  return parsed;
}

export function registerDiscoverCommands(program: Command): void {
  const discover = program
    .command('discover')
    .description('Search and inspect public Masumi agent details');

  discover.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  discover
    .command('search')
    .description('Search published agents through Masumi discovery')
    .argument('[query]', 'Search query')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .option('--allow-pending', 'Include pending Masumi inbox-agent registrations')
    .option('--page <number>', 'Page number', value => parsePositiveInteger(value, 'page'))
    .option('--take <number>', 'Results per page', value =>
      parsePositiveInteger(value, 'result count')
    )
    .action(async function (this: Command, query: string | undefined) {
      const options = this.optsWithGlobals() as DiscoverOptions;
      await runCommandAction({
        title: 'Masumi discover search',
        options,
        preferPlainReporter: true,
        run: ({ reporter }) =>
          discoverAgents({
            profileName: options.profile,
            reporter,
            query,
            actorSlug: options.agent,
            page: options.page,
            limit: options.take,
            allowPending: Boolean(options.allowPending),
          }),
        toHuman: result => {
          const columns: TableColumn[] = [
            { header: 'Slug', key: 'slug', color: cyan },
            { header: 'Name', key: 'name' },
            { header: 'Description', key: 'description' },
            { header: 'Agent ID', key: 'agentId', color: dim },
          ];
          const agentScope = options.allowPending ? 'verified/pending' : 'verified';
          return {
            summary:
              result.total > 0
                ? result.mode === 'search'
                  ? `Found ${bold(String(result.total))} ${agentScope} agent${
                      result.total === 1 ? '' : 's'
                    } on page ${bold(String(result.page))}.`
                  : `Showing ${bold(String(result.total))} ${agentScope} agent${
                      result.total === 1 ? '' : 's'
                    } on page ${bold(String(result.page))}.`
                : result.query
                  ? renderEmptyWithTry(
                      `No ${options.allowPending ? 'verified or pending' : 'verified'} agents matched "${result.query}".`,
                      'masumi-agent-messenger discover search <query> --page 1'
                    )
                  : renderEmptyWithTry(
                      'No registered agents available on this page.',
                      'masumi-agent-messenger discover search --page 1'
                    ),
            details:
              result.total === 0
                ? []
                : [
                    dim(
                      `Page ${result.page} · ${result.hasNextPage ? 'more results available' : 'last page'}`
                    ),
                    ...renderTable(
                      result.results.map(item => ({
                        slug: item.slug,
                        name: item.displayName ?? '',
                        description: item.description ?? '',
                        agentId: item.agentIdentifier ?? '',
                      })),
                      columns
                    ),
                  ],
          };
        },
      });
    });

  discover
    .command('show')
    .description('Show merged public discovery and route details for one agent')
    .argument('<slugOrIdentity>', 'Published agent slug, identity, or email')
    .option('--agent <slug>', 'Owned agent slug to use as context')
    .option('--allow-pending', 'Include pending Masumi inbox-agent registrations')
    .action(async function (this: Command, slugOrIdentity: string) {
      const options = this.optsWithGlobals() as DiscoverOptions;
      await runCommandAction({
        title: 'Masumi discover show',
        options,
        preferPlainReporter: true,
        run: ({ reporter }) =>
          showDiscoveredAgent({
            profileName: options.profile,
            reporter,
            identifier: slugOrIdentity,
            actorSlug: options.agent,
            allowPending: Boolean(options.allowPending),
          }),
        toHuman: result => {
          const details = renderKeyValue([
            { key: 'Slug', value: result.selected.slug, color: cyan },
            { key: 'Display name', value: result.selected.displayName ?? 'n/a' },
            {
              key: 'Identity',
              value: result.selected.publicIdentity ?? 'not published in inbox registry',
              color: dim,
            },
            { key: 'Default', value: formatOptionalBoolean(result.selected.isDefault) },
            {
              key: 'Inbox published',
              value: formatOptionalBoolean(result.selected.inboxPublished),
            },
            {
              key: 'Agent ID',
              value: result.selected.agentIdentifier ?? 'n/a',
              color: dim,
            },
            {
              key: 'Encryption key',
              value: result.selected.encryptionKeyVersion ?? 'n/a',
            },
            {
              key: 'Signing key',
              value: result.selected.signingKeyVersion ?? 'n/a',
            },
            ...(result.publicRoute
              ? [
                  {
                    key: 'Linked email',
                    value: result.publicRoute.linkedEmail ?? 'hidden',
                  },
                  {
                    key: 'Description',
                    value: result.publicRoute.description ?? 'not set',
                  },
                  {
                    key: 'Contact policy',
                    value: result.publicRoute.contactPolicy.mode,
                  },
                  {
                    key: 'Allowlist scope',
                    value: result.publicRoute.contactPolicy.allowlistScope,
                  },
                  {
                    key: 'Preview before approval',
                    value: formatBoolean(
                      result.publicRoute.contactPolicy.messagePreviewVisibleBeforeApproval
                    ),
                  },
                  {
                    key: 'Content types',
                    value:
                      result.publicRoute.allowAllContentTypes
                        ? green('all')
                        : result.publicRoute.supportedContentTypes.length > 0
                        ? result.publicRoute.supportedContentTypes.join(', ')
                        : 'none declared',
                  },
                  {
                    key: 'Headers',
                    value:
                      result.publicRoute.allowAllHeaders
                        ? green('all')
                        : result.publicRoute.supportedHeaders.length > 0
                        ? result.publicRoute.supportedHeaders
                            .map(header => {
                              const flags = [
                                header.required ? 'required' : null,
                                header.allowMultiple ? 'multi' : null,
                                header.sensitive ? 'sensitive' : null,
                              ]
                                .filter(Boolean)
                                .join('/');
                              return flags ? `${header.name} (${flags})` : header.name;
                            })
                            .join(', ')
                        : 'none declared',
                  },
                ]
              : [
                  {
                    key: 'Public route',
                    value:
                      result.detailScope === 'saas_only'
                        ? yellow('available for exact slug lookup')
                        : yellow('not published'),
                  },
                ]),
            ...(result.matchedActors.length > 1
              ? [
                  {
                    key: 'Matches',
                    value: result.matchedActors
                      .map(match => match.displayName ?? match.slug)
                      .join(', '),
                  },
                ]
              : []),
          ]);

          return {
            summary: `Showing public details for ${cyan(result.selected.slug)}.`,
            details,
          };
        },
      });
    });
}
