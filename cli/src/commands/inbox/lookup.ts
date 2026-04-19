import type { Command } from 'commander';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { formatRelativeTime } from '../../services/format';
import { lookupInboxes } from '../../services/inbox-lookup';
import {
  badge,
  bold,
  cyan,
  dim,
  gray,
  green,
  renderEmptyWithTry,
  renderTable,
  type TableColumn,
} from '../../services/render';

type LookupOptions = GlobalOptions & {
  query?: string;
  limit?: string;
};

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return Number.parseInt(value, 10);
}

function describeMatchedActor(params: {
  slug: string;
  displayName: string | null;
  isDefault: boolean;
}): string {
  const label = params.isDefault ? `${params.slug} [default]` : params.slug;
  return params.displayName?.trim() ? `${params.displayName} (${label})` : label;
}

export function registerThreadContactListCommand(command: Command): void {
  command
        .command('list')
        .description('List direct inbox contacts and verified discovery matches')
        .option('--query <text>', 'Filter by inbox slug, display name, or public identity')
        .option('--limit <number>', 'Maximum inboxes to show', '20')
        .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as LookupOptions;
      await runCommandAction({
        title: 'Masumi thread contact list',
        options,
        run: ({ reporter }) =>
          lookupInboxes({
            profileName: options.profile,
            query: options.query,
            limit: parseOptionalInteger(options.limit),
            reporter,
          }),
        toHuman: result => {
          const COLUMNS: TableColumn[] = [
            { header: 'Slug', key: 'slug', color: cyan },
            { header: 'Name', key: 'name' },
            { header: 'Unread', key: 'unread' },
            { header: 'Threads', key: 'threads', align: 'right' },
            { header: 'Last Activity', key: 'activity', color: gray },
          ];
          const discoveredColumns: TableColumn[] = [
            { header: 'Slug', key: 'slug', color: cyan },
            { header: 'Name', key: 'name' },
            { header: 'Identity', key: 'identity', color: gray },
          ];
          const summaryParts: string[] = [];
          if (result.totalInboxes > 0) {
            summaryParts.push(
              `${bold(String(result.totalInboxes))} local contact${result.totalInboxes === 1 ? '' : 's'}`
            );
          }
          if (result.discoveredCount > 0) {
            summaryParts.push(
              `${bold(String(result.discoveredCount))} verified agent${
                result.discoveredCount === 1 ? '' : 's'
              }`
            );
          }

          const details: string[] = [];
          if (result.totalInboxes > 0) {
            details.push(bold('Local contacts'));
            details.push(
              ...renderTable(
                result.results.map(item => ({
                  slug: item.slug,
                  name: item.displayName?.trim() ?? '',
                  unread: item.newMessages > 0 ? badge(`${item.newMessages} new`, green) : '',
                  threads: String(item.threadCount),
                  activity: item.latestMessageAt ? formatRelativeTime(item.latestMessageAt) : '',
                })),
                COLUMNS
              )
            );
          }
          if (result.discoveredCount > 0) {
            if (details.length > 0) {
              details.push('');
            }
            details.push(bold('Verified discovery'));
            details.push(
              ...renderTable(
                result.discoveredResults.map(item => ({
                  slug: item.slug,
                  name: describeMatchedActor({
                    slug: item.slug,
                    displayName: item.displayName,
                    isDefault: item.isDefault,
                  }),
                  identity: item.publicIdentity,
                })),
                discoveredColumns
              )
            );
          }
          if (result.discoveryError) {
            if (details.length > 0) {
              details.push('');
            }
            details.push(`${dim('Discovery')}  ${result.discoveryError}`);
          }
          return {
            summary:
              summaryParts.length > 0
                ? `Found ${summaryParts.join(' and ')}.`
                : renderEmptyWithTry(
                    'No local contacts or verified agents found.',
                    'masumi-agent-messenger thread start <target> "hi"'
                  ),
            details,
          };
        },
      });
    });
}
