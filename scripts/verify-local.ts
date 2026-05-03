import { webcrypto } from 'node:crypto';
import { DbConnection, tables } from '../webapp/src/module_bindings/index.ts';
import type {
  Agent,
  Message,
  Thread,
  ThreadSecretEnvelope,
} from '../webapp/src/module_bindings/types';
import {
  decryptMessage,
  generateAgentKeyPair,
  prepareEncryptedMessage,
  type ActorPublicKeys,
  type AgentKeyPair,
  type SenderSecretState,
} from '../webapp/src/lib/crypto';
import {
  formatEncryptedMessageBody,
  parseDecryptedMessagePlaintext,
} from '../shared/message-format';
import { generateDeviceKeyPair } from '../shared/device-sharing';
import { prepareSpacetimeSubscriptionQuery } from '../shared/spacetime-subscription-limits';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto;
}

const HOST = process.env.VERIFY_SPACETIMEDB_HOST ?? 'ws://127.0.0.1:3000';
const DB_NAME = process.env.VERIFY_SPACETIMEDB_DB_NAME ?? 'agentmessenger-dev';
const RUN_SUFFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const TOKENS = {
  alice: process.env.VERIFY_ALICE_ID_TOKEN ?? process.env.SECURITY_TEST_ALICE_ID_TOKEN,
  bob: process.env.VERIFY_BOB_ID_TOKEN ?? process.env.SECURITY_TEST_BOB_ID_TOKEN,
};

if (!TOKENS.alice || !TOKENS.bob) {
  throw new Error(
    'Set VERIFY_ALICE_ID_TOKEN and VERIFY_BOB_ID_TOKEN (or SECURITY_TEST_* equivalents) before running verify-local.'
  );
}

type ConnectedClient = {
  conn: DbConnection;
  identityHex: string;
};

type ProvisionedClient = ConnectedClient & {
  label: string;
  email: string;
  keyPair: AgentKeyPair;
  actor: Agent;
};

const VISIBLE_QUERIES = [
  prepareSpacetimeSubscriptionQuery(tables.visible_accounts, 'visible_accounts'),
  prepareSpacetimeSubscriptionQuery(tables.visible_account_change_signal, 'visible_account_change_signal'),
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function decodeJwtEmail(token: string): string {
  const [, payload] = token.split('.');
  if (!payload) throw new Error('Malformed JWT payload');
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const claims = JSON.parse(
    Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')
  ) as Record<string, unknown>;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) throw new Error('Token missing email claim');
  return email;
}

function toEncryptionAlgorithm(_algorithm: string): { tag: 'EcdhP256V1' } {
  return { tag: 'EcdhP256V1' };
}

function toSigningAlgorithm(_algorithm: string): { tag: 'EcdsaP256Sha256V1' } {
  return { tag: 'EcdsaP256Sha256V1' };
}

function toDeviceEncryptionAlgorithm(_algorithm: string): { tag: 'EcdhP256DeviceV1' } {
  return { tag: 'EcdhP256DeviceV1' };
}

function toCipherAlgorithm(_algorithm: string): { tag: 'AesGcm256V1' } {
  return { tag: 'AesGcm256V1' };
}

function toWrapAlgorithm(_algorithm: string): { tag: 'EcdhP256AesGcm256V1' } {
  return { tag: 'EcdhP256AesGcm256V1' };
}

function cipherAlgorithmLabel(algorithm: string | { tag: string }): string {
  const tag = typeof algorithm === 'string' ? algorithm : algorithm.tag;
  return tag === 'AesGcm256V1' ? 'aes-gcm-256-v1' : tag;
}

function wrapAlgorithmLabel(algorithm: string | { tag: string }): string {
  const tag = typeof algorithm === 'string' ? algorithm : algorithm.tag;
  return tag === 'EcdhP256AesGcm256V1' ? 'ecdh-p256-aes-gcm-256-wrap-v1' : tag;
}

function toReducerEnvelopes(
  envelopes: Array<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: number;
    senderEncryptionKeyVersion: number;
    signingKeyVersion: number;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>
) {
  return envelopes.map(envelope => ({
    recipientPublicIdentity: envelope.recipientPublicIdentity,
    recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
    senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
    signingKeyVersion: envelope.signingKeyVersion,
    wrappedSecretCiphertext: envelope.wrappedSecretCiphertext,
    wrappedSecretIv: envelope.wrappedSecretIv,
    wrapAlgorithm: toWrapAlgorithm(envelope.wrapAlgorithm),
    signature: envelope.signature,
  }));
}

function actorPublicKeysFromClient(client: ProvisionedClient): ActorPublicKeys {
  return {
    actorId: client.actor.id,
    email: client.actor.email,
    slug: client.actor.slug,
    isDefault: client.actor.isDefault,
    publicIdentity: client.actor.publicIdentity,
    displayName: client.actor.displayName ?? null,
    encryptionPublicKey: client.keyPair.encryption.publicKey,
    encryptionKeyVersion: client.keyPair.encryption.keyVersion,
    signingPublicKey: client.keyPair.signing.publicKey,
    signingKeyVersion: client.keyPair.signing.keyVersion,
  };
}

async function connectClient(token: string): Promise<ConnectedClient> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(token)
      .onConnect((conn, identity) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            resolve({ conn, identityHex: identity.toHexString() });
          })
          .onError(ctx => reject(ctx.event ?? new Error('Subscription failed')))
          .subscribe([...VISIBLE_QUERIES]);
      })
      .onConnectError((_ctx, error) => reject(error))
      .build();
  });
}

function listAccounts(conn: DbConnection) {
  return Array.from(conn.db.visible_accounts.iter());
}

async function listAgents(conn: DbConnection): Promise<Agent[]> {
  const owned: Agent[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listOwnedAgentsPage({ afterId, limit: 250 });
    owned.push(...page.agents);
    if (!page.nextAfterId) break;
    afterId = page.nextAfterId;
  }
  const actor = owned.find(row => row.isDefault) ?? owned[0] ?? null;
  const visibleThreadPage = actor
    ? await conn.procedures.listVisibleThreads({
        agentDbId: actor.id,
        afterSortKey: undefined,
        limit: 25,
      })
    : { actors: [] };
  const byId = new Map<bigint, Agent>();
  for (const agent of owned) byId.set(agent.id, agent);
  for (const agent of visibleThreadPage.actors) byId.set(agent.id, agent);
  return Array.from(byId.values());
}

async function listThreads(conn: DbConnection): Promise<Thread[]> {
  const actors = await listAgents(conn);
  const actor = actors.find(row => row.isDefault) ?? actors[0] ?? null;
  if (!actor) return [];
  return (await conn.procedures.listVisibleThreads({
    agentDbId: actor.id,
    afterSortKey: undefined,
    limit: 25,
  })).threads;
}

async function listParticipants(conn: DbConnection) {
  const actors = await listAgents(conn);
  const actor = actors.find(row => row.isDefault) ?? actors[0] ?? null;
  if (!actor) return [];
  return (await conn.procedures.listVisibleThreads({
    agentDbId: actor.id,
    afterSortKey: undefined,
    limit: 25,
  })).participantPreviews;
}

async function ensureBootstrap(client: ConnectedClient, label: string, email: string): Promise<void> {
  if (listAccounts(client.conn).some(row => row.email.toLowerCase() === email)) {
    return;
  }

  const bootstrapKeys = await generateAgentKeyPair({
    encryptionKeyVersion: 1,
    signingKeyVersion: 1,
  });
  const bootstrapDevice = await generateDeviceKeyPair();

  await Promise.resolve(
    client.conn.reducers.upsertAccountFromOidcIdentity({
      displayName: `${label} verify bootstrap`,
      defaultSlug: undefined,
      encryptionPublicKey: bootstrapKeys.encryption.publicKey,
      encryptionKeyVersion: bootstrapKeys.encryption.keyVersion,
      encryptionAlgorithm: toEncryptionAlgorithm(bootstrapKeys.encryption.algorithm),
      signingPublicKey: bootstrapKeys.signing.publicKey,
      signingKeyVersion: bootstrapKeys.signing.keyVersion,
      signingAlgorithm: toSigningAlgorithm(bootstrapKeys.signing.algorithm),
      deviceId: `${label}-verify-device-${RUN_SUFFIX}`,
      deviceLabel: `${label} verify device`,
      devicePlatform: 'verify-local',
      deviceEncryptionPublicKey: bootstrapDevice.publicKey,
      deviceEncryptionKeyVersion: bootstrapDevice.keyVersion,
      deviceEncryptionAlgorithm: toDeviceEncryptionAlgorithm(bootstrapDevice.algorithm),
    })
  );

  await waitFor(
    () => listAccounts(client.conn).some(row => row.email.toLowerCase() === email),
    `${label} account bootstrap`
  );
}

async function provisionClient(label: string, token: string): Promise<ProvisionedClient> {
  const email = decodeJwtEmail(token);
  const connected = await connectClient(token);
  await ensureBootstrap(connected, label, email);

  const keyPair = await generateAgentKeyPair({
    encryptionKeyVersion: 1,
    signingKeyVersion: 1,
  });
  const slug = `${label}-verify-${RUN_SUFFIX}`;

  await Promise.resolve(
    connected.conn.reducers.createAgent({
      slug,
      displayName: `${label} verify agent`,
      encryptionPublicKey: keyPair.encryption.publicKey,
      keyBundleVersion: keyPair.encryption.keyVersion,
      encryptionAlgorithm: toEncryptionAlgorithm(keyPair.encryption.algorithm),
      signingPublicKey: keyPair.signing.publicKey,
      signingAlgorithm: toSigningAlgorithm(keyPair.signing.algorithm),
    })
  );

  await waitFor(
    async () => (await listAgents(connected.conn)).some(row => row.slug === slug),
    `${label} agent creation`
  );

  const actor = (await listAgents(connected.conn)).find(row => row.slug === slug);
  if (!actor) throw new Error(`${label} agent row missing after creation`);

  return { ...connected, label, email, keyPair, actor };
}

async function listMessagesForThread(client: ProvisionedClient, threadId: bigint): Promise<Message[]> {
  const page = await client.conn.procedures.listThreadMessages({
    threadId,
    beforeThreadSeq: undefined,
    limit: 25,
  });
  return page.messages.sort((left, right) => Number(left.threadSeq - right.threadSeq));
}

async function findEnvelope(
  client: ProvisionedClient,
  message: Message
): Promise<ThreadSecretEnvelope> {
  const rows = await client.conn.procedures.listThreadSecretEnvelopes({
    threadId: message.threadId,
    membershipVersion: undefined,
    senderAgentDbId: message.senderAgentDbId,
    recipientAgentDbId: client.actor.id,
    secretVersion: message.secretVersion,
  });
  const envelope = rows[0];
  if (!envelope) throw new Error('Recipient secret envelope missing');
  return envelope;
}

async function decryptInbound(params: {
  recipient: ProvisionedClient;
  sender: ProvisionedClient;
  message: Message;
}): Promise<string> {
  const envelope = await findEnvelope(params.recipient, params.message);

  const plaintext = await decryptMessage({
    recipientKeyPair: params.recipient.keyPair,
    recipientPublicIdentity: params.recipient.actor.publicIdentity,
    message: {
      threadId: params.message.threadId,
      senderActorId: params.sender.actor.id,
      senderPublicIdentity: params.sender.actor.publicIdentity,
      senderMessageId: params.message.senderMessageId,
      secretVersion: params.message.secretVersion,
      signingKeyVersion: params.message.signingKeyVersion,
      ciphertext: params.message.ciphertext,
      iv: params.message.iv,
      cipherAlgorithm: cipherAlgorithmLabel(params.message.cipherAlgorithm),
      signature: params.message.signature,
      replyToMessageId: params.message.replyToMessageId ?? undefined,
    },
    envelope: {
      id: envelope.id,
      threadId: envelope.threadId,
      secretVersion: envelope.secretVersion,
      senderActorId: envelope.senderAgentDbId,
      senderPublicIdentity: params.sender.actor.publicIdentity,
      recipientActorId: envelope.recipientAgentDbId,
      recipientPublicIdentity: params.recipient.actor.publicIdentity,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
      wrappedSecretCiphertext: envelope.wrappedSecretCiphertext,
      wrappedSecretIv: envelope.wrappedSecretIv,
      wrapAlgorithm: wrapAlgorithmLabel(envelope.wrapAlgorithm),
      signature: envelope.signature,
    },
    senderEncryptionPublicKey: params.sender.keyPair.encryption.publicKey,
    messageSigningPublicKey: params.sender.keyPair.signing.publicKey,
    envelopeSigningPublicKey: params.sender.keyPair.signing.publicKey,
  });

  const parsed = parseDecryptedMessagePlaintext(plaintext);
  if (parsed.invalidStructuredEnvelopeReason) {
    throw new Error(parsed.invalidStructuredEnvelopeReason);
  }
  return formatEncryptedMessageBody(parsed.payload);
}

async function sendMessage(params: {
  sender: ProvisionedClient;
  thread: Thread;
  recipients: ActorPublicKeys[];
  senderMessageId: bigint;
  body: string;
  existingSecret: SenderSecretState | null;
  rotateSecret: boolean;
  replyToMessageId?: bigint | null;
}): Promise<SenderSecretState> {
  const prepared = await prepareEncryptedMessage({
    threadId: params.thread.id,
    senderActorId: params.sender.actor.id,
    senderPublicIdentity: params.sender.actor.publicIdentity,
    senderMessageId: params.senderMessageId,
    payload: { contentType: 'text/plain', body: params.body },
    keyPair: params.sender.keyPair,
    recipients: params.recipients,
    existingSecret: params.existingSecret,
    latestKnownSecretVersion: params.existingSecret?.secretVersion ?? null,
    rotateSecret: params.rotateSecret,
    replyToMessageId: params.replyToMessageId ?? null,
  });

  await Promise.resolve(
    params.sender.conn.reducers.sendEncryptedMessage({
      agentDbId: params.sender.actor.id,
      threadId: params.thread.id,
      secretVersion: prepared.secretVersion,
      signingKeyVersion: prepared.signingKeyVersion,
      senderMessageId: params.senderMessageId,
      ciphertext: prepared.ciphertext,
      iv: prepared.iv,
      cipherAlgorithm: toCipherAlgorithm(prepared.cipherAlgorithm),
      signature: prepared.signature,
      replyToMessageId: params.replyToMessageId ?? undefined,
      attachedSecretEnvelopes: toReducerEnvelopes(prepared.attachedSecretEnvelopes),
    })
  );

  return prepared.senderSecret;
}

async function main(): Promise<void> {
  const alice = await provisionClient('alice', TOKENS.alice!);
  const bob = await provisionClient('bob', TOKENS.bob!);

  try {
    await Promise.resolve(
      bob.conn.reducers.addContactAllowlistEntry({
        agentDbId: bob.actor.id,
        kind: { tag: 'Agent' },
        agentPublicIdentity: alice.actor.publicIdentity,
        email: undefined,
      })
    );

    await Promise.resolve(
      alice.conn.reducers.createThread({
        agentDbId: alice.actor.id,
        kind: { tag: 'Direct' },
        otherAgentPublicIdentity: bob.actor.publicIdentity,
        participantPublicIdentities: undefined,
        title: `verify-${RUN_SUFFIX}`,
        firstMessage: undefined,
      })
    );

    await waitFor(
      async () =>
        (await listThreads(alice.conn)).some(row => row.title === `verify-${RUN_SUFFIX}`) &&
        (await listThreads(bob.conn)).some(row => row.title === `verify-${RUN_SUFFIX}`),
      'direct thread visibility'
    );

    const thread = (await listThreads(alice.conn)).find(candidate => candidate.title === `verify-${RUN_SUFFIX}`);
    if (!thread) throw new Error('Verify thread did not become visible');

    const aliceRecipients = [actorPublicKeysFromClient(alice), actorPublicKeysFromClient(bob)];
    const bobRecipients = [actorPublicKeysFromClient(bob), actorPublicKeysFromClient(alice)];

    const firstSecret = await sendMessage({
      sender: alice,
      thread,
      recipients: aliceRecipients,
      senderMessageId: 1n,
      body: 'hello bob',
      existingSecret: null,
      rotateSecret: true,
    });

    await waitFor(
      async () => (await listMessagesForThread(bob, thread.id)).length === 1,
      'first inbound message'
    );
    const firstInbound = (await listMessagesForThread(bob, thread.id))[0]!;
    const bobFirstText = await decryptInbound({
      recipient: bob,
      sender: alice,
      message: firstInbound,
    });
    if (bobFirstText !== 'hello bob') {
      throw new Error(`Unexpected Bob plaintext: ${bobFirstText}`);
    }

    await sendMessage({
      sender: alice,
      thread,
      recipients: aliceRecipients,
      senderMessageId: 2n,
      body: 'second alice message',
      existingSecret: firstSecret,
      rotateSecret: false,
    });

    await waitFor(
      async () => (await listMessagesForThread(bob, thread.id)).length === 2,
      'second inbound message'
    );
    const secondInbound = (await listMessagesForThread(bob, thread.id))[1]!;
    if (secondInbound.secretVersion !== firstSecret.secretVersion) {
      throw new Error('Second message unexpectedly rotated the sender secret');
    }

    const secondInboundOnAlice = (await listMessagesForThread(alice, thread.id))[1];
    await sendMessage({
      sender: bob,
      thread,
      recipients: bobRecipients,
      senderMessageId: 1n,
      body: 'hi alice',
      existingSecret: null,
      rotateSecret: true,
      replyToMessageId: secondInboundOnAlice?.id ?? null,
    });

    await waitFor(
      async () => (await listMessagesForThread(alice, thread.id)).length === 3,
      'bob reply visible to alice'
    );
    const aliceMessages = await listMessagesForThread(alice, thread.id);
    const replyInbound = aliceMessages[2]!;
    const aliceReplyText = await decryptInbound({
      recipient: alice,
      sender: bob,
      message: replyInbound,
    });
    if (aliceReplyText !== 'hi alice') {
      throw new Error(`Unexpected Alice plaintext: ${aliceReplyText}`);
    }

    await Promise.resolve(
      bob.conn.reducers.updateThreadReadState({
        agentDbId: bob.actor.id,
        threadId: thread.id,
        lastReadThreadSeq: replyInbound.threadSeq,
        archived: undefined,
      })
    );

    await waitFor(
      async () =>
        (await listParticipants(alice.conn)).some(row => {
          return (
            row.agentDbId === bob.actor.id &&
            row.threadId === thread.id &&
            row.lastReadThreadSeq === replyInbound.threadSeq
          );
        }),
      'bob read state propagation'
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          aliceIdentity: alice.identityHex,
          bobIdentity: bob.identityHex,
          threadId: thread.id.toString(),
          messageCount: aliceMessages.length,
          bobFirstDecrypted: bobFirstText,
          aliceReplyDecrypted: aliceReplyText,
        },
        null,
        2
      )
    );
  } finally {
    alice.conn.disconnect();
    bob.conn.disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
