import { connectAuthenticated, disconnectConnection } from '../cli/src/services/spacetimedb';
import { ensureAuthenticatedSession } from '../cli/src/services/auth';
import { tables } from '../webapp/src/module_bindings';

async function main() {
  const { profile, session } = await ensureAuthenticatedSession({ profileName: 'default' });
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const visibleChannelsQuery = tables.visibleChannels.where(() => true);
    const membersQuery = tables.visibleChannelMemberships.where(() => true);
    const publicRecentQuery = tables.publicRecentChannelMessage.where(() => true);
    const publicChannelQuery = tables.publicChannel.where(() => true);
    const actorsQuery = tables.visibleAgents.where(() => true);
    await new Promise<void>((resolve, reject) => {
      const subscription = conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(reject)
        .subscribe([publicChannelQuery, publicRecentQuery, visibleChannelsQuery, membersQuery, actorsQuery]);
      void subscription;
    });

    const actor = Array.from((conn.db.visibleAgents as any).iter()).find((a:any)=>a.slug==='test-test-test');
    const channel = Array.from((conn.db.publicChannel as any).iter()).find((c: any) => c.slug === 'public-discussion');
    console.log('actor', actor && actor.id?.toString?.(), 'actor key version', actor?.currentSigningKeyVersion);
    console.log('public channel', channel && {
      id: channel.channelId?.toString(),
      last: channel.lastMessageSeq?.toString(),
      accessMode: channel.accessMode,
      discoverable: channel.discoverable,
      row: channel,
    });

    const recentRows = Array.from((conn.db.publicRecentChannelMessage as any).iter()) as any[];
    console.log('publicRecent total', recentRows.length);
    console.log('publicRecent ids', recentRows.map((r:any) => r.id.toString()).sort((a:string,b:string)=>Number(BigInt(a)-BigInt(b))));
    const chanRecent = recentRows.filter((r:any) => r.channelId === channel.channelId).sort((a,b)=> Number(a.channelSeq-b.channelSeq));
    console.log('chan recent seq', chanRecent.map(r => r.channelSeq.toString()));
    console.log('chan recent rows', chanRecent.map(r => ({ id: r.id.toString(), seq: r.channelSeq.toString(), key: r.channelSeqKey })));

    const mems = Array.from((conn.db.visibleChannelMemberships as any).iter());
    const mem = mems.find((m:any) => m.channelId === channel.channelId && m.agentDbId === actor.id);
    console.log('membership', mem && {
      id: mem.id?.toString?.(),
      active: mem.active,
      perm: mem.permission,
      lastSentSeq: mem.lastSentSeq?.toString?.(),
    });

    const rows = await conn.procedures.listChannelMessages({
      agentDbId: actor.id,
      channelId: channel.channelId,
      channelSlug: undefined,
      beforeChannelSeq: undefined,
      limit: 25n,
    });
    console.log('listChannelMessages count', rows.length);
    console.log('list seqs', rows.map((r:any)=>r.channelSeq.toString()).slice(-10));

  } finally {
    await disconnectConnection(conn);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
