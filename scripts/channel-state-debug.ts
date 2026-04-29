import { connectAuthenticated, disconnectConnection } from '../cli/src/services/spacetimedb';
import { ensureAuthenticatedSession } from '../cli/src/services/auth';
import { tables } from '../webapp/src/module_bindings';
import type {
  PublicRecentChannelMessageRow,
  VisibleAgentRow,
  VisibleChannelMembershipRow,
} from '../webapp/src/module_bindings/types';
import { limitSpacetimeSubscriptionQuery } from '../shared/spacetime-subscription-limits';

async function main() {
  const { profile, session } = await ensureAuthenticatedSession({ profileName: 'default' });
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const [channel] = await conn.procedures.readPublicChannel({
      channelId: undefined,
      channelSlug: 'public-discussion',
    });
    if (!channel) {
      throw new Error('public-discussion channel was not found');
    }

    const visibleChannelsQuery = limitSpacetimeSubscriptionQuery(
      tables.visibleChannels.where(row => row.slug.eq('public-discussion')),
      'visibleChannels'
    );
    const membersQuery = limitSpacetimeSubscriptionQuery(
      tables.visibleChannelMemberships.where(row => row.channelId.eq(channel.channelId)),
      'visibleChannelMemberships'
    );
    const actorsQuery = limitSpacetimeSubscriptionQuery(
      tables.visibleAgents.where(row => row.slug.eq('test-test-test')),
      'visibleAgents'
    );
    await new Promise<void>((resolve, reject) => {
      const subscription = conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(reject)
        .subscribe([visibleChannelsQuery, membersQuery, actorsQuery]);
      void subscription;
    });

    const actor =
      (Array.from(conn.db.visibleAgents.iter()) as VisibleAgentRow[]).find(
        row => row.slug === 'test-test-test'
      ) ?? null;
    const recentRows = await conn.procedures.listPublicChannelMessages({
      channelId: channel.channelId,
      channelSlug: undefined,
      beforeChannelSeq: undefined,
      limit: 25n,
    });

    console.log(
      'actor',
      actor?.id.toString() ?? null,
      'actor key version',
      actor?.currentSigningKeyVersion ?? null
    );
    console.log('public channel', {
      id: channel.channelId.toString(),
      last: channel.lastMessageSeq.toString(),
      accessMode: channel.accessMode,
      discoverable: channel.discoverable,
      row: channel,
    });

    console.log('publicRecent total', recentRows.length);
    console.log(
      'publicRecent ids',
      recentRows
        .map((row: PublicRecentChannelMessageRow) => row.id.toString())
        .sort((left, right) => Number(BigInt(left) - BigInt(right)))
    );
    console.log(
      'chan recent seq',
      recentRows.map((row: PublicRecentChannelMessageRow) => row.channelSeq.toString())
    );
    console.log(
      'chan recent rows',
      recentRows.map((row: PublicRecentChannelMessageRow) => ({
        id: row.id.toString(),
        seq: row.channelSeq.toString(),
        key: row.channelSeqKey,
      }))
    );

    const memberships = Array.from(
      conn.db.visibleChannelMemberships.iter()
    ) as VisibleChannelMembershipRow[];
    const membership =
      actor === null
        ? null
        : memberships.find(
            row => row.channelId === channel.channelId && row.agentDbId === actor.id
          ) ?? null;
    console.log(
      'membership',
      membership && {
        id: membership.id.toString(),
        active: membership.active,
        perm: membership.permission,
        lastSentSeq: membership.lastSentSeq.toString(),
      }
    );

    if (actor) {
      const rows = await conn.procedures.listChannelMessages({
        agentDbId: actor.id,
        channelId: channel.channelId,
        channelSlug: undefined,
        beforeChannelSeq: undefined,
        limit: 25n,
      });
      console.log('listChannelMessages count', rows.length);
      console.log('list seqs', rows.map(row => row.channelSeq.toString()).slice(-10));
    }
  } finally {
    await disconnectConnection(conn);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
