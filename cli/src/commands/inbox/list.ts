import type { Command } from 'commander';
import { listThreads } from '../../services/thread';
import { listOwnedInboxAgents } from '../../services/inbox-agents';
import { formatRelativeTime } from '../../services/format';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import {
  badge,
  bold,
  cyan,
  dim,
  green,
  renderEmptyWithTry,
  renderTable,
  yellow,
  type TableColumn,
} from '../../services/render';

type InboxListOptions = GlobalOptions & {
  sort?: 'unread' | 'name' | 'updated';
  view?: 'compact' | 'detailed';
};

export function registerInboxListCommand(command: Command): void {
  command
    .command('list')
    .description('List owned inbox identities and slugs')
    .option('--sort <field>', 'Sort: unread|name|updated', 'updated')
    .option('--view <mode>', 'Output view: compact|detailed', 'compact')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as InboxListOptions;
      await runCommandAction({
        title: 'Masumi inbox list',
        options,
        run: async ({ reporter }) => {
          const agentsResult = await listOwnedInboxAgents({
            profileName: options.profile,
            reporter,
          });

          const view = options.view ?? 'compact';
          const sort = options.sort ?? 'updated';

          const rows: Array<{
            slug: string;
            name: string;
            identity: string;
            flags: string[];
            unreadTotal: number;
            updatedAt: string;
          }> = [];

          for (const agent of agentsResult.agents) {
            reporter.verbose?.(`Loading inbox metrics for ${agent.slug}`);
            const threadState = await listThreads({
              profileName: options.profile,
              actorSlug: agent.slug,
              includeArchived: false,
              reporter,
            });

            const unreadTotal = threadState.threads.reduce((sum, thread) => {
              return sum + thread.unreadMessages;
            }, 0);

            const updatedAtIso =
              threadState.threads
                .map(c => c.lastMessageAt)
                .filter(Boolean)
                .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';

            const flags: string[] = [];
            if (agent.isDefault) flags.push('default');
            if (agent.managed) flags.push('managed');

            rows.push({
              slug: agent.slug,
              name: agent.displayName?.trim() ?? '',
              identity: agent.publicIdentity,
              flags,
              unreadTotal,
              updatedAt: updatedAtIso,
            });
          }

          const sortedRows = [...rows].sort((a, b) => {
            if (sort === 'name') {
              return (a.name || a.slug).localeCompare(b.name || b.slug);
            }

            if (sort === 'unread') {
              if (a.unreadTotal !== b.unreadTotal) {
                return b.unreadTotal - a.unreadTotal;
              }
              return (a.name || a.slug).localeCompare(b.name || b.slug);
            }

            // updated
            const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
            const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
            if (aTime !== bTime) return bTime - aTime;
            if (a.unreadTotal !== b.unreadTotal) return b.unreadTotal - a.unreadTotal;
            return (a.name || a.slug).localeCompare(b.name || b.slug);
          });

          return {
            ...agentsResult,
            view,
            sort,
            rows: sortedRows,
          };
        },
        toHuman: result => {
          const view = result.view ?? 'compact';
          const columns: TableColumn[] =
            view === 'detailed'
              ? [
                  { header: 'Slug', key: 'slug', color: cyan },
                  { header: 'Name', key: 'name' },
                  { header: 'Identity', key: 'identity' },
                  { header: 'Flags', key: 'flags' },
                  { header: 'Unread', key: 'unread', align: 'right' },
                  { header: 'Updated', key: 'updated', color: dim },
                ]
              : [
                  { header: 'Slug', key: 'slug', color: cyan },
                  { header: 'Name', key: 'name' },
                  { header: 'Unread', key: 'unread', align: 'right' },
                  { header: 'Updated', key: 'updated', color: dim },
                ];

          const FLAG_COLORS: Record<string, (value: string) => string> = {
            default: yellow,
            managed: cyan,
          };
          const renderFlags = (flags: readonly string[]): string =>
            flags
              .map(flag => badge(flag, FLAG_COLORS[flag] ?? dim))
              .join(' ');

          return {
            summary:
              result.totalAgents > 0
                ? `Found ${bold(String(result.totalAgents))} owned inbox${result.totalAgents === 1 ? '' : 'es'}.`
                : renderEmptyWithTry('No owned inboxes found.', 'masumi-agent-messenger auth sync'),
            details:
              result.totalAgents === 0
                ? []
                : renderTable(
                    result.rows.map(row => ({
                      slug: row.slug,
                      name: row.name,
                      identity: row.identity,
                      flags: renderFlags(row.flags),
                      unread: row.unreadTotal > 0 ? badge(`${row.unreadTotal} new`, green) : '',
                      updated: row.updatedAt ? formatRelativeTime(row.updatedAt) : '',
                    })),
                    columns
                  ),
          };
        },
      });
    });
}
