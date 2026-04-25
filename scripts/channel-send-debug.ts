import { createSecretStore } from '../cli/src/services/secret-store';
import { connectAuthenticated, disconnectConnection } from '../cli/src/services/spacetimedb';
import { ensureAuthenticatedSession } from '../cli/src/services/auth';
import { tables } from '../webapp/src/module_bindings';
import { getStoredActorKeyPair } from '../cli/src/services/actor-keys';
import { normalizeEncryptedMessagePayload, isJsonContentType } from '../shared/message-format';
import { prepareChannelMessage } from '../shared/channel-crypto';

function buildTextPayload(message: string, contentType = 'text/plain') {
  const normalizedContentType = contentType ? contentType : 'text/plain';
  return normalizeEncryptedMessagePayload({
    contentType: normalizedContentType,
    body: message,
  });
}

async function main() {
  const { profile, session } = await ensureAuthenticatedSession({ profileName: 'default' });
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const subscription = conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(reject)
        .subscribe([tables.visibleAgents, tables.visibleChannels, tables.visibleChannelMemberships]);
      void subscription;
    });

    const actors = Array.from((conn.db.visibleAgents as any).iter()) as any[];
    const actor = actors.find((a: any) => a.slug === 'test-test-test');
    const channels = Array.from((conn.db.visibleChannels as any).iter()) as any[];
    const channel = channels.find((c: any) => c.slug === 'public-discussion');

    console.log('actor', actor?.id?.toString?.(), 'channel', channel?.id?.toString?.());
    if (!actor || !channel) throw new Error('Missing actor/channel');

    const membership = Array.from((conn.db.visibleChannelMemberships as any).iter()).find(
      (m: any) => m.channelId === channel.id && m.agentDbId === actor.id && m.active
    );
    const nextSeq = membership ? membership.lastSentSeq + 1n : 1n;
    console.log('membership lastSentSeq', membership?.lastSentSeq?.toString?.());

    const secretStore = createSecretStore();
    const keyPair = await getStoredActorKeyPair({
      profile,
      secretStore,
      identity: {
        normalizedEmail: actor.normalizedEmail,
        slug: actor.slug,
        inboxIdentifier: actor.inboxIdentifier ?? undefined,
      },
    });
    if (!keyPair) {
      throw new Error('no keypair');
    }

    const payload = buildTextPayload('debug payload', 'text/plain');
    const prepared = await prepareChannelMessage({
      channelId: channel.id,
      senderPublicIdentity: actor.publicIdentity,
      senderSeq: nextSeq,
      payload,
      keyPair,
    });

    const params = {
      agentDbId: actor.id,
      channelId: channel.id,
      senderSeq: nextSeq,
      senderSigningKeyVersion: prepared.senderSigningKeyVersion,
      plaintext: prepared.plaintext,
      signature: prepared.signature,
      replyToMessageId: undefined,
    };

    console.log('trying real signature len', params.signature.length);
    try {
      const result = await conn.reducers.sendChannelMessage(params);
      console.log('OK', result);
    } catch (error) {
      console.log('ERR type', error?.constructor?.name, 'message', (error as Error)?.message);
      console.log('error raw', error);
    }

  } finally {
    await disconnectConnection(conn);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
