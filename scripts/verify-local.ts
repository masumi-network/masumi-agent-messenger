import { webcrypto } from 'node:crypto';
import { DbConnection, tables } from '../webapp/src/module_bindings/index.ts';
import type {
  Agent,
  Thread,
  ThreadSecretEnvelope,
  VisibleMessageRow,
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
  tables.visibleInboxes,
  tables.visibleAgents,
  tables.visibleThreads,
  tables.visibleThreadParticipants,
  tables.visibleThreadReadStates,
  tables.visibleThreadSecretEnvelopes,
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
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!email) throw new Error('Token missing email claim');
  return email;
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

async function ensureBootstrap(client: ConnectedClient, label: string, email: string): Promise<void> {
  if (listInboxes(client.conn).some(row => row.displayEmail.toLowerCase() === email.toLowerCase())) {
    return;
  }

  const bootstrapKeys = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  const bootstrapDevice = await generateDeviceKeyPair();

  await Promise.resolve(
    client.conn.reducers.upsertInboxFromOidcIdentity({
      displayName: `${label} verify bootstrap`,
      defaultSlug: undefined,
      encryptionPublicKey: bootstrapKeys.encryption.publicKey,
      encryptionKeyVersion: bootstrapKeys.encryption.keyVersion,
      encryptionAlgorithm: bootstrapKeys.encryption.algorithm,
      signingPublicKey: bootstrapKeys.signing.publicKey,
      signingKeyVersion: bootstrapKeys.signing.keyVersion,
      signingAlgorithm: bootstrapKeys.signing.algorithm,
      deviceId: `${label}-verify-device-${RUN_SUFFIX}`,
      deviceLabel: `${label} verify device`,
      devicePlatform: 'verify-local',
      deviceEncryptionPublicKey: bootstrapDevice.publicKey,
      deviceEncryptionKeyVersion: bootstrapDevice.keyVersion,
      deviceEncryptionAlgorithm: bootstrapDevice.algorithm,
    })
  );

  await waitFor(
    () =>
      listInboxes(client.conn).some(row => row.displayEmail.toLowerCase() === email.toLowerCase()),
    `${label} inbox bootstrap`
  );
}

async function provisionClient(label: string, token: string): Promise<ProvisionedClient> {
  const email = decodeJwtEmail(token);
  const connected = await connectClient(token);
  await ensureBootstrap(connected, label, email);

  const keyPair = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  const slug = `${label}-verify-${RUN_SUFFIX}`;

  await Promise.resolve(
    connected.conn.reducers.createInboxIdentity({
      slug,
      displayName: `${label} verify agent`,
      encryptionPublicKey: keyPair.encryption.publicKey,
      encryptionKeyVersion: keyPair.encryption.keyVersion,
      encryptionAlgorithm: keyPair.encryption.algorithm,
      signingPublicKey: keyPair.signing.publicKey,
      signingKeyVersion: keyPair.signing.keyVersion,
      signingAlgorithm: keyPair.signing.algorithm,
    })
  );

  await waitFor(
    () => listAgents(connected.conn).some(row => row.slug === slug),
    `${label} identity creation`
  );

  const actor = listAgents(connected.conn).find(row => row.slug === slug);
  if (!actor) throw new Error(`${label} agent row missing after creation`);

  return { ...connected, label, email, keyPair, actor };
}

function listInboxes(conn: DbConnection) {
  return Array.from(conn.db.visibleInboxes.iter());
}

function listAgents(conn: DbConnection): Agent[] {
  return Array.from(conn.db.visibleAgents.iter()) as Agent[];
}

function listThreads(conn: DbConnection): Thread[] {
  return Array.from(conn.db.visibleThreads.iter()) as Thread[];
}

async function listMessagesForThread(client: ProvisionedClient, threadId: bigint): Promise<VisibleMessageRow[]> {
  const page = await client.conn.procedures.listThreadMessages({
    agentDbId: client.actor.id,
    threadId,
    beforeThreadSeq: undefined,
    limit: 100n,
  });
  return page.messages.sort((left, right) => Number(left.threadSeq - right.threadSeq));
}

function toActorPublicKeys(actor: Agent): ActorPublicKeys {
  return {
    actorId: actor.id,
    normalizedEmail: actor.normalizedEmail,
    slug: actor.slug,
    inboxIdentifier: actor.inboxIdentifier ?? undefined,
    isDefault: actor.isDefault,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName ?? null,
    encryptionPublicKey: actor.currentEncryptionPublicKey,
    encryptionKeyVersion: actor.currentEncryptionKeyVersion,
    signingPublicKey: actor.currentSigningPublicKey,
    signingKeyVersion: actor.currentSigningKeyVersion,
  };
}

async function findVersionedKey(
  conn: DbConnection,
  viewerAgentDbId: bigint,
  sender: Agent,
  kind: 'encryption' | 'signing',
  version: string
): Promise<string | null> {
  if (kind === 'encryption' && sender.currentEncryptionKeyVersion === version) {
    return sender.currentEncryptionPublicKey;
  }
  if (kind === 'signing' && sender.currentSigningKeyVersion === version) {
    return sender.currentSigningPublicKey;
  }

  const rows = await conn.procedures.lookupAgentPublicKeys({
    agentDbId: viewerAgentDbId,
    requests: [
      {
        agentDbId: sender.id,
        keyKind: kind,
        keyVersion: version,
      },
    ],
  });
  return rows[0]?.publicKey ?? null;
}

async function decryptInbound(params: {
  recipient: ProvisionedClient;
  message: VisibleMessageRow;
}): Promise<string> {
  const sender = listAgents(params.recipient.conn).find(
    row => row.id === params.message.senderAgentDbId
  );
  if (!sender) throw new Error('Sender not visible to recipient');

  const envelope = (Array.from(params.recipient.conn.db.visibleThreadSecretEnvelopes.iter()) as ThreadSecretEnvelope[]).find(
    row =>
      row.threadId === params.message.threadId &&
      row.senderAgentDbId === params.message.senderAgentDbId &&
      row.recipientAgentDbId === params.recipient.actor.id &&
      row.secretVersion === params.message.secretVersion
  );
  if (!envelope) throw new Error('Recipient secret envelope missing');

  const senderEncryptionPublicKey = await findVersionedKey(
    params.recipient.conn,
    params.recipient.actor.id,
    sender,
    'encryption',
    envelope.senderEncryptionKeyVersion
  );
  const messageSigningPublicKey = await findVersionedKey(
    params.recipient.conn,
    params.recipient.actor.id,
    sender,
    'signing',
    params.message.signingKeyVersion
  );
  const envelopeSigningPublicKey = await findVersionedKey(
    params.recipient.conn,
    params.recipient.actor.id,
    sender,
    'signing',
    envelope.signingKeyVersion
  );
  if (!senderEncryptionPublicKey || !messageSigningPublicKey || !envelopeSigningPublicKey) {
    throw new Error('Missing sender key material');
  }

  const plaintext = await decryptMessage({
    recipientKeyPair: params.recipient.keyPair,
    recipientPublicIdentity: params.recipient.actor.publicIdentity,
    message: {
      threadId: params.message.threadId,
      senderActorId: sender.id,
      senderPublicIdentity: sender.publicIdentity,
      senderSeq: params.message.senderSeq,
      secretVersion: params.message.secretVersion,
      signingKeyVersion: params.message.signingKeyVersion,
      ciphertext: params.message.ciphertext,
      iv: params.message.iv,
      cipherAlgorithm: params.message.cipherAlgorithm,
      signature: params.message.signature,
      replyToMessageId: params.message.replyToMessageId ?? undefined,
    },
    envelope: {
      id: envelope.id,
      threadId: envelope.threadId,
      secretVersion: envelope.secretVersion,
      senderActorId: envelope.senderAgentDbId,
      senderPublicIdentity: sender.publicIdentity,
      recipientActorId: envelope.recipientAgentDbId,
      recipientPublicIdentity: params.recipient.actor.publicIdentity,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
      wrappedSecretCiphertext: envelope.wrappedSecretCiphertext,
      wrappedSecretIv: envelope.wrappedSecretIv,
      wrapAlgorithm: envelope.wrapAlgorithm,
      signature: envelope.signature,
    },
    senderEncryptionPublicKey,
    messageSigningPublicKey,
    envelopeSigningPublicKey,
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
  senderSeq: bigint;
  body: string;
  existingSecret: SenderSecretState | null;
  rotateSecret: boolean;
  replyToMessageId?: bigint | null;
}): Promise<SenderSecretState> {
  const prepared = await prepareEncryptedMessage({
    threadId: params.thread.id,
    senderActorId: params.sender.actor.id,
    senderPublicIdentity: params.sender.actor.publicIdentity,
    senderSeq: params.senderSeq,
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
      senderSeq: params.senderSeq,
      ciphertext: prepared.ciphertext,
      iv: prepared.iv,
      cipherAlgorithm: prepared.cipherAlgorithm,
      signature: prepared.signature,
      replyToMessageId: params.replyToMessageId ?? undefined,
      attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
    })
  );

  return prepared.senderSecret;
}

async function main(): Promise<void> {
  const alice = await provisionClient('alice', TOKENS.alice!);
  const bob = await provisionClient('bob', TOKENS.bob!);

  await Promise.resolve(
    alice.conn.reducers.createDirectThread({
      agentDbId: alice.actor.id,
      otherAgentPublicIdentity: bob.actor.publicIdentity,
      membershipLocked: false,
      title: `verify-${RUN_SUFFIX}`,
    })
  );

  await waitFor(
    () =>
      listThreads(alice.conn).length > 0 &&
      listThreads(bob.conn).length > 0 &&
      listAgents(alice.conn).some(row => row.publicIdentity === bob.actor.publicIdentity),
    'direct thread visibility'
  );

  const thread = listThreads(alice.conn).find(candidate => {
    return candidate.kind === 'direct' && candidate.title === `verify-${RUN_SUFFIX}`;
  });
  if (!thread) throw new Error('Verify thread did not become visible');

  const bobFromAlice = listAgents(alice.conn).find(
    row => row.publicIdentity === bob.actor.publicIdentity
  );
  const aliceFromBob = listAgents(bob.conn).find(
    row => row.publicIdentity === alice.actor.publicIdentity
  );
  if (!bobFromAlice || !aliceFromBob) {
    throw new Error('Peer agent rows did not propagate');
  }

  const aliceRecipients = [toActorPublicKeys(alice.actor), toActorPublicKeys(bobFromAlice)];
  const bobRecipients = [toActorPublicKeys(bob.actor), toActorPublicKeys(aliceFromBob)];

  const firstSecret = await sendMessage({
    sender: alice,
    thread,
    recipients: aliceRecipients,
    senderSeq: 1n,
    body: 'hello bob',
    existingSecret: null,
    rotateSecret: true,
  });

  await waitFor(
    async () => (await listMessagesForThread(bob, thread.id)).length === 1,
    'first inbound message'
  );
  const firstInbound = (await listMessagesForThread(bob, thread.id))[0]!;
  const bobFirstText = await decryptInbound({ recipient: bob, message: firstInbound });
  if (bobFirstText !== 'hello bob') {
    throw new Error(`Unexpected Bob plaintext: ${bobFirstText}`);
  }

  await sendMessage({
    sender: alice,
    thread,
    recipients: aliceRecipients,
    senderSeq: 2n,
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
    senderSeq: 1n,
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
  const aliceReplyText = await decryptInbound({ recipient: alice, message: replyInbound });
  if (aliceReplyText !== 'hi alice') {
    throw new Error(`Unexpected Alice plaintext: ${aliceReplyText}`);
  }

  await Promise.resolve(
    bob.conn.reducers.markThreadRead({
      agentDbId: bob.actor.id,
      threadId: thread.id,
      upToThreadSeq: replyInbound.threadSeq,
    })
  );

  await waitFor(
    () =>
      Array.from(alice.conn.db.visibleThreadReadStates.iter()).some(row => {
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

  alice.conn.disconnect();
  bob.conn.disconnect();
}

main().catch(error => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
