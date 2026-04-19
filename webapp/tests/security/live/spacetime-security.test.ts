import { webcrypto } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { DbConnection, tables } from '@/module_bindings';
import type {
  Agent,
  VisibleAgentRow,
  VisibleAgentKeyBundleRow,
  VisibleThreadRow,
  VisibleThreadParticipantRow,
  VisibleInboxRow,
  VisibleMessageRow,
  VisibleThreadSecretEnvelopeRow,
  VisibleContactRequestRow,
  VisibleContactAllowlistEntryRow,
} from '@/module_bindings/types';
import {
  decryptMessage,
  generateAgentKeyPair,
  prepareEncryptedMessage,
  type ActorPublicKeys,
  type AgentKeyPair,
} from '@/lib/crypto';
import {
  fetchPublishedPublicRouteBySlug,
  resolvePublishedActorBySlug,
} from '@/lib/spacetimedb-server';
import { generateDeviceKeyPair } from '../../../../shared/device-sharing';
import {
  formatEncryptedMessageBody,
  parseDecryptedMessagePlaintext,
} from '../../../../shared/message-format';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto;
}

const HOST =
  process.env.SECURITY_TEST_SPACETIMEDB_HOST ??
  process.env.SPACETIMEDB_HOST ??
  'ws://localhost:3000';
const DB_NAME =
  process.env.SECURITY_TEST_SPACETIMEDB_DB_NAME ??
  process.env.SPACETIMEDB_DB_NAME ??
  'agentmessenger-dev';
const RUN_SUFFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const REQUIRED_TOKENS = {
  alice: process.env.SECURITY_TEST_ALICE_ID_TOKEN,
  bob: process.env.SECURITY_TEST_BOB_ID_TOKEN,
  mallory: process.env.SECURITY_TEST_MALLORY_ID_TOKEN,
} as const;

type ConnectedState = {
  conn: DbConnection;
  identityHex: string;
};

type ProvisionedClient = {
  label: string;
  token: string;
  email: string;
  subject: string;
  conn: DbConnection;
  keyPair: AgentKeyPair;
  actor: Agent;
};

const VISIBLE_QUERIES = [
  tables.visibleInboxes,
  tables.visibleAgents,
  tables.visibleAgentKeyBundles,
  tables.visibleThreads,
  tables.visibleThreadParticipants,
  tables.visibleThreadReadStates,
  tables.visibleThreadSecretEnvelopes,
  tables.visibleContactRequests,
  tables.visibleContactAllowlistEntries,
  tables.visibleMessages,
] as const;

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  if (!payload) {
    throw new Error('Malformed JWT payload');
  }

  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function parseTokenIdentity(token: string): { email: string; subject: string } {
  const payload = decodeJwtPayload(token);
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!email || !subject) {
    throw new Error('Security test token is missing email or sub');
  }
  return { email, subject };
}

function listVisibleInboxes(conn: DbConnection): VisibleInboxRow[] {
  return Array.from(conn.db.visibleInboxes.iter());
}

function listVisibleActors(conn: DbConnection): VisibleAgentRow[] {
  return Array.from(conn.db.visibleAgents.iter());
}

function listVisibleBundles(conn: DbConnection): VisibleAgentKeyBundleRow[] {
  return Array.from(conn.db.visibleAgentKeyBundles.iter());
}

function listVisibleThreads(conn: DbConnection): VisibleThreadRow[] {
  return Array.from(conn.db.visibleThreads.iter());
}

function listVisibleParticipants(conn: DbConnection): VisibleThreadParticipantRow[] {
  return Array.from(conn.db.visibleThreadParticipants.iter());
}

function listVisibleMessages(conn: DbConnection): VisibleMessageRow[] {
  return Array.from(conn.db.visibleMessages.iter());
}

function listVisibleSecretEnvelopes(conn: DbConnection): VisibleThreadSecretEnvelopeRow[] {
  return Array.from(conn.db.visibleThreadSecretEnvelopes.iter());
}

function listVisibleContactRequests(conn: DbConnection): VisibleContactRequestRow[] {
  return Array.from(conn.db.visibleContactRequests.iter());
}

function listVisibleAllowlistEntries(conn: DbConnection): VisibleContactAllowlistEntryRow[] {
  return Array.from(conn.db.visibleContactAllowlistEntries.iter());
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

function toPublishedActorPublicKeys(actor: {
  slug: string;
  publicIdentity: string;
  isDefault: boolean;
  displayName?: string | null;
  encryptionPublicKey: string;
  encryptionKeyVersion: string;
  signingPublicKey: string;
  signingKeyVersion: string;
}): ActorPublicKeys {
  return {
    normalizedEmail: '',
    slug: actor.slug,
    isDefault: actor.isDefault,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName ?? null,
    encryptionPublicKey: actor.encryptionPublicKey,
    encryptionKeyVersion: actor.encryptionKeyVersion,
    signingPublicKey: actor.signingPublicKey,
    signingKeyVersion: actor.signingKeyVersion,
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectVisibleClient(token?: string): Promise<ConnectedState> {
  return new Promise((resolve, reject) => {
    const builder = DbConnection.builder().withUri(HOST).withDatabaseName(DB_NAME);
    if (token) {
      builder.withToken(token);
    }

    builder
      .onConnect((conn, identity) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            resolve({
              conn,
              identityHex: identity.toHexString(),
            });
          })
          .onError(ctx => {
            reject(ctx.event ?? new Error('Subscription failed'));
          })
          .subscribe([...VISIBLE_QUERIES]);
      })
      .onConnectError((_ctx, error) => reject(error))
      .build();
  });
}

async function ensureBootstrap(client: ConnectedState, label: string, email: string): Promise<void> {
  if (listVisibleInboxes(client.conn).length > 0) {
    return;
  }

  const bootstrapKeys = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  const bootstrapDevice = await generateDeviceKeyPair();

  await Promise.resolve(
    client.conn.reducers.upsertInboxFromOidcIdentity({
      displayName: `${label} security bootstrap`,
      defaultSlug: undefined,
      encryptionPublicKey: bootstrapKeys.encryption.publicKey,
      encryptionKeyVersion: bootstrapKeys.encryption.keyVersion,
      encryptionAlgorithm: bootstrapKeys.encryption.algorithm,
      signingPublicKey: bootstrapKeys.signing.publicKey,
      signingKeyVersion: bootstrapKeys.signing.keyVersion,
      signingAlgorithm: bootstrapKeys.signing.algorithm,
      deviceId: `${label}-security-device-${RUN_SUFFIX}`,
      deviceLabel: `${label} security device`,
      devicePlatform: 'vitest',
      deviceEncryptionPublicKey: bootstrapDevice.publicKey,
      deviceEncryptionKeyVersion: bootstrapDevice.keyVersion,
      deviceEncryptionAlgorithm: bootstrapDevice.algorithm,
    })
  );

  await waitFor(
    () =>
      listVisibleInboxes(client.conn).some(inbox => inbox.displayEmail.toLowerCase() === email.toLowerCase()),
    `${label} inbox bootstrap`
  );
}

async function provisionClient(label: string, token: string): Promise<ProvisionedClient> {
  const identity = parseTokenIdentity(token);
  const connected = await connectVisibleClient(token);

  await ensureBootstrap(connected, label, identity.email);

  const keyPair = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  const slug = `${label}-sec-${RUN_SUFFIX}`;

  await Promise.resolve(
    connected.conn.reducers.createInboxIdentity({
      slug,
      displayName: `${label} security actor`,
      encryptionPublicKey: keyPair.encryption.publicKey,
      encryptionKeyVersion: keyPair.encryption.keyVersion,
      encryptionAlgorithm: keyPair.encryption.algorithm,
      signingPublicKey: keyPair.signing.publicKey,
      signingKeyVersion: keyPair.signing.keyVersion,
      signingAlgorithm: keyPair.signing.algorithm,
    })
  );

  await waitFor(
    () => listVisibleActors(connected.conn).some(actor => actor.slug === slug),
    `${label} isolated actor`
  );

  const actor = listVisibleActors(connected.conn).find(row => row.slug === slug);
  if (!actor) {
    throw new Error(`Unable to find created actor for ${label}`);
  }

  return {
    label,
    token,
    email: identity.email,
    subject: identity.subject,
    conn: connected.conn,
    keyPair,
    actor,
  };
}

function findVersionedKey(
  actor: VisibleAgentRow,
  bundles: VisibleAgentKeyBundleRow[],
  kind: 'encryption' | 'signing',
  version: string
): string | null {
  if (kind === 'encryption' && actor.currentEncryptionKeyVersion === version) {
    return actor.currentEncryptionPublicKey;
  }
  if (kind === 'signing' && actor.currentSigningKeyVersion === version) {
    return actor.currentSigningPublicKey;
  }
  if (kind === 'encryption') {
    return bundles.find(bundle => bundle.encryptionKeyVersion === version)?.encryptionPublicKey ?? null;
  }
  return bundles.find(bundle => bundle.signingKeyVersion === version)?.signingPublicKey ?? null;
}

async function decryptLatestMessage(
  recipient: ProvisionedClient,
  message: VisibleMessageRow
): Promise<string> {
  const sender = listVisibleActors(recipient.conn).find(actor => actor.id === message.senderAgentDbId);
  if (!sender) {
    throw new Error('Sender actor is not visible to recipient');
  }

  const envelope = listVisibleSecretEnvelopes(recipient.conn).find(row => {
    return (
      row.threadId === message.threadId &&
      row.senderAgentDbId === message.senderAgentDbId &&
      row.recipientAgentDbId === recipient.actor.id &&
      row.secretVersion === message.secretVersion
    );
  });
  if (!envelope) {
    throw new Error('Recipient envelope missing');
  }

  const bundles = listVisibleBundles(recipient.conn).filter(bundle => bundle.agentDbId === sender.id);
  const senderEncryptionPublicKey = findVersionedKey(
    sender,
    bundles,
    'encryption',
    envelope.senderEncryptionKeyVersion
  );
  const messageSigningPublicKey = findVersionedKey(
    sender,
    bundles,
    'signing',
    message.signingKeyVersion
  );
  const envelopeSigningPublicKey = findVersionedKey(
    sender,
    bundles,
    'signing',
    envelope.signingKeyVersion
  );

  if (!senderEncryptionPublicKey || !messageSigningPublicKey || !envelopeSigningPublicKey) {
    throw new Error('Sender public key material missing');
  }

  const plaintext = await decryptMessage({
    recipientKeyPair: recipient.keyPair,
    recipientPublicIdentity: recipient.actor.publicIdentity,
    message: {
      threadId: message.threadId,
      senderActorId: sender.id,
      senderPublicIdentity: sender.publicIdentity,
      senderSeq: message.senderSeq,
      secretVersion: message.secretVersion,
      signingKeyVersion: message.signingKeyVersion,
      ciphertext: message.ciphertext,
      iv: message.iv,
      cipherAlgorithm: message.cipherAlgorithm,
      signature: message.signature,
      replyToMessageId: message.replyToMessageId ?? undefined,
    },
    envelope: {
      id: envelope.id,
      threadId: envelope.threadId,
      secretVersion: envelope.secretVersion,
      senderActorId: envelope.senderAgentDbId,
      senderPublicIdentity: sender.publicIdentity,
      recipientActorId: envelope.recipientAgentDbId,
      recipientPublicIdentity: recipient.actor.publicIdentity,
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

async function captureBootstrapFailure(token: string): Promise<string> {
  try {
    const connected = await connectVisibleClient(token);
    try {
      const keyPair = await generateAgentKeyPair({
        encryptionKeyVersion: 'enc-v1',
        signingKeyVersion: 'sig-v1',
      });
      const deviceKeyPair = await generateDeviceKeyPair();
      await Promise.resolve(
        connected.conn.reducers.upsertInboxFromOidcIdentity({
          displayName: 'invalid security bootstrap',
          defaultSlug: undefined,
          encryptionPublicKey: keyPair.encryption.publicKey,
          encryptionKeyVersion: keyPair.encryption.keyVersion,
          encryptionAlgorithm: keyPair.encryption.algorithm,
          signingPublicKey: keyPair.signing.publicKey,
          signingKeyVersion: keyPair.signing.keyVersion,
          signingAlgorithm: keyPair.signing.algorithm,
          deviceId: `invalid-security-device-${RUN_SUFFIX}`,
          deviceLabel: 'invalid security device',
          devicePlatform: 'vitest',
          deviceEncryptionPublicKey: deviceKeyPair.publicKey,
          deviceEncryptionKeyVersion: deviceKeyPair.keyVersion,
          deviceEncryptionAlgorithm: deviceKeyPair.algorithm,
        })
      );
      throw new Error('Unexpectedly bootstrapped with an invalid token');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      connected.conn.disconnect();
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const liveEnvReady = Object.values(REQUIRED_TOKENS).every((value): value is string => Boolean(value));

describe.skipIf(!liveEnvReady)('live spacetime security', () => {
  let alice: ProvisionedClient;
  let bob: ProvisionedClient;
  let mallory: ProvisionedClient;
  let thread: VisibleThreadRow;
  let bobActorFromAliceView: VisibleAgentRow;
  let sentMessage: VisibleMessageRow;

  beforeAll(async () => {
    alice = await provisionClient('alice', REQUIRED_TOKENS.alice!);
    bob = await provisionClient('bob', REQUIRED_TOKENS.bob!);
    mallory = await provisionClient('mallory', REQUIRED_TOKENS.mallory!);

    await Promise.resolve(
      alice.conn.reducers.createDirectThread({
        agentDbId: alice.actor.id,
        otherAgentPublicIdentity: bob.actor.publicIdentity,
        membershipLocked: true,
        title: `security-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      () =>
        listVisibleThreads(alice.conn).length > 0 &&
        listVisibleThreads(bob.conn).length > 0 &&
        listVisibleActors(alice.conn).some(actor => actor.publicIdentity === bob.actor.publicIdentity),
      'alice/bob direct thread visibility'
    );

    bobActorFromAliceView = listVisibleActors(alice.conn).find(
      actor => actor.publicIdentity === bob.actor.publicIdentity
    )!;
    if (!bobActorFromAliceView) {
      throw new Error('Bob actor never became visible to Alice');
    }

    const aliceThread = listVisibleThreads(alice.conn).find(candidate => {
      const participants = listVisibleParticipants(alice.conn).filter(
        participant => participant.threadId === candidate.id && participant.active
      );
      const participantIds = new Set(participants.map(participant => participant.agentDbId));
      return participantIds.has(alice.actor.id) && participantIds.has(bobActorFromAliceView.id);
    });
    if (!aliceThread) {
      throw new Error('Expected shared Alice/Bob thread');
    }
    thread = aliceThread;

    const participants = listVisibleParticipants(alice.conn)
      .filter(participant => participant.threadId === thread.id && participant.active)
      .map(participant => {
        const actor = listVisibleActors(alice.conn).find(row => row.id === participant.agentDbId);
        if (!actor) {
          throw new Error('Participant actor missing from Alice visibility');
        }
        return toActorPublicKeys(actor);
      });

    const prepared = await prepareEncryptedMessage({
      threadId: thread.id,
      senderActorId: alice.actor.id,
      senderPublicIdentity: alice.actor.publicIdentity,
      senderSeq: 1n,
      payload: {
        contentType: 'text/plain',
        body: 'hello from alice security test',
      },
      keyPair: alice.keyPair,
      recipients: participants,
      existingSecret: null,
      latestKnownSecretVersion: null,
      rotateSecret: true,
      replyToMessageId: null,
    });

    await Promise.resolve(
      alice.conn.reducers.sendEncryptedMessage({
        agentDbId: alice.actor.id,
        threadId: thread.id,
        secretVersion: prepared.secretVersion,
        signingKeyVersion: prepared.signingKeyVersion,
        senderSeq: 1n,
        ciphertext: prepared.ciphertext,
        iv: prepared.iv,
        cipherAlgorithm: prepared.cipherAlgorithm,
        signature: prepared.signature,
        replyToMessageId: undefined,
        attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
      })
    );

    await waitFor(
      () => listVisibleMessages(bob.conn).some(message => message.threadId === thread.id),
      'bob inbound message visibility'
    );

    const bobMessage = listVisibleMessages(bob.conn).find(message => message.threadId === thread.id);
    if (!bobMessage) {
      throw new Error('Bob never received Alice message');
    }
    sentMessage = bobMessage;
  });

  afterAll(() => {
    alice?.conn.disconnect();
    bob?.conn.disconnect();
    mallory?.conn.disconnect();
  });

  it('keeps all visible views empty for anonymous connections', async () => {
    const anonymous = await connectVisibleClient();
    try {
      expect(listVisibleInboxes(anonymous.conn)).toHaveLength(0);
      expect(listVisibleActors(anonymous.conn)).toHaveLength(0);
      expect(listVisibleBundles(anonymous.conn)).toHaveLength(0);
      expect(listVisibleThreads(anonymous.conn)).toHaveLength(0);
      expect(listVisibleParticipants(anonymous.conn)).toHaveLength(0);
      expect(listVisibleSecretEnvelopes(anonymous.conn)).toHaveLength(0);
      expect(listVisibleMessages(anonymous.conn)).toHaveLength(0);
    } finally {
      anonymous.conn.disconnect();
    }
  });

  it('limits thread reads to intended participants only', async () => {
    const bobPlaintext = await decryptLatestMessage(bob, sentMessage);

    expect(bobPlaintext).toBe('hello from alice security test');
    expect(listVisibleMessages(alice.conn).some(message => message.threadId === thread.id)).toBe(true);
    expect(listVisibleMessages(bob.conn).some(message => message.threadId === thread.id)).toBe(true);
    expect(listVisibleMessages(mallory.conn).some(message => message.threadId === thread.id)).toBe(false);
    expect(listVisibleSecretEnvelopes(mallory.conn).some(envelope => envelope.threadId === thread.id)).toBe(false);
    expect(listVisibleThreads(mallory.conn).some(candidate => candidate.id === thread.id)).toBe(false);
  });

  it('allows repeated direct thread creation for the same actor pair with distinct thread ids', async () => {
    await Promise.resolve(
      alice.conn.reducers.createDirectThread({
        agentDbId: alice.actor.id,
        otherAgentPublicIdentity: bob.actor.publicIdentity,
        membershipLocked: true,
        title: `security-duplicate-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      () =>
        listVisibleThreads(alice.conn).filter(candidate => candidate.dedupeKey === thread.dedupeKey).length >= 2 &&
        listVisibleThreads(bob.conn).filter(candidate => candidate.dedupeKey === thread.dedupeKey).length >= 2,
      'duplicate direct thread visibility'
    );

    const aliceDirectThreads = listVisibleThreads(alice.conn).filter(
      candidate => candidate.kind === 'direct' && candidate.dedupeKey === thread.dedupeKey
    );

    expect(aliceDirectThreads).toHaveLength(2);
    expect(new Set(aliceDirectThreads.map(candidate => candidate.id.toString())).size).toBe(2);
    expect(new Set(aliceDirectThreads.map(candidate => candidate.dedupeKey))).toEqual(
      new Set([thread.dedupeKey])
    );
  });

  it('blocks foreign-actor mutation attempts even when the foreign actor is visible', async () => {
    await expect(
      Promise.resolve(
        alice.conn.reducers.markThreadRead({
          agentDbId: bobActorFromAliceView.id,
          threadId: thread.id,
          upToThreadSeq: sentMessage.threadSeq,
        })
      )
    ).rejects.toThrow(/not owned/i);

    await expect(
      Promise.resolve(
        alice.conn.reducers.sendEncryptedMessage({
          agentDbId: bobActorFromAliceView.id,
          threadId: thread.id,
          secretVersion: 'secret-v1',
          signingKeyVersion: 'sig-v1',
          senderSeq: 1n,
          ciphertext: 'deadbeef',
          iv: 'deadbeef',
          cipherAlgorithm: 'aes-gcm-256-v1',
          signature: 'deadbeef',
          replyToMessageId: undefined,
          attachedSecretEnvelopes: [],
        })
      )
    ).rejects.toThrow(/not owned/i);
  });

  it('keeps removed participants able to read historical messages', async () => {
    await Promise.resolve(
      bob.conn.reducers.removeThreadParticipant({
        agentDbId: bob.actor.id,
        threadId: thread.id,
        participantAgentDbId: bob.actor.id,
      })
    );

    await waitFor(
      () =>
        listVisibleParticipants(bob.conn).some(
          participant =>
            participant.threadId === thread.id &&
            participant.agentDbId === bob.actor.id &&
            !participant.active
        ),
      'removed participant historical visibility'
    );

    expect(listVisibleThreads(bob.conn).some(candidate => candidate.id === thread.id)).toBe(true);

    const historicalMessage = listVisibleMessages(bob.conn).find(
      message => message.id === sentMessage.id
    );
    if (!historicalMessage) {
      throw new Error('Removed participant lost historical message visibility');
    }

    await expect(decryptLatestMessage(bob, historicalMessage)).resolves.toBe(
      'hello from alice security test'
    );
    await expect(
      Promise.resolve(
        bob.conn.reducers.sendEncryptedMessage({
          agentDbId: bob.actor.id,
          threadId: thread.id,
          secretVersion: 'removed-reader-secret',
          signingKeyVersion: bob.actor.currentSigningKeyVersion,
          senderSeq: 1n,
          ciphertext: 'deadbeef',
          iv: 'deadbeef',
          cipherAlgorithm: 'aes-gcm-256-v1',
          signature: 'deadbeef',
          replyToMessageId: undefined,
          attachedSecretEnvelopes: [],
        })
      )
    ).rejects.toThrow(/not a participant/i);
  });

  it('keeps public key lookup public but removes internal actor ids', async () => {
    const lookup = await resolvePublishedActorBySlug(alice.actor.slug);
    const publishedRoute = await fetchPublishedPublicRouteBySlug(alice.actor.slug);

    expect(lookup).not.toBeNull();
    expect(lookup && 'id' in (lookup as Record<string, unknown>)).toBe(false);
    expect(lookup?.publicIdentity).toBe(alice.actor.publicIdentity);
    expect(publishedRoute && 'id' in (publishedRoute as Record<string, unknown>)).toBe(false);
    expect(publishedRoute).toMatchObject({
      encryptionKeyVersion: alice.actor.currentEncryptionKeyVersion,
      encryptionPublicKey: JSON.parse(alice.actor.currentEncryptionPublicKey) as unknown,
      signingKeyVersion: alice.actor.currentSigningKeyVersion,
      signingPublicKey: JSON.parse(alice.actor.currentSigningPublicKey) as unknown,
    });
  });

  it('allows only one hidden pre-approval message in pending direct-contact threads', async () => {
    const existingRequestIds = new Set(
      listVisibleContactRequests(mallory.conn).map(request => request.id.toString())
    );

    await Promise.resolve(
      mallory.conn.reducers.createPendingDirectContactRequest({
        agentDbId: mallory.actor.id,
        otherAgentPublicIdentity: alice.actor.publicIdentity,
        membershipLocked: true,
        title: `pending-hidden-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      () =>
        listVisibleContactRequests(mallory.conn).some(
          request =>
            request.requesterAgentDbId === mallory.actor.id &&
            request.targetPublicIdentity === alice.actor.publicIdentity &&
            request.status === 'pending' &&
            !existingRequestIds.has(request.id.toString())
        ),
      'pending direct-contact request visibility'
    );

    const pendingRequest = listVisibleContactRequests(mallory.conn).find(
      request =>
        request.requesterAgentDbId === mallory.actor.id &&
        request.targetPublicIdentity === alice.actor.publicIdentity &&
        request.status === 'pending' &&
        !existingRequestIds.has(request.id.toString())
    );
    if (!pendingRequest) {
      throw new Error('Pending direct-contact request did not become visible');
    }

    const publishedAlice = (
      await mallory.conn.procedures.lookupPublishedAgentBySlug({
        slug: alice.actor.slug,
      })
    )[0];
    if (!publishedAlice) {
      throw new Error('Published Alice actor lookup failed');
    }

    const firstPrepared = await prepareEncryptedMessage({
      threadId: pendingRequest.threadId,
      senderActorId: mallory.actor.id,
      senderPublicIdentity: mallory.actor.publicIdentity,
      senderSeq: 1n,
      payload: {
        contentType: 'text/plain',
        body: 'hidden first contact',
      },
      keyPair: mallory.keyPair,
      recipients: [
        toActorPublicKeys(mallory.actor),
        toPublishedActorPublicKeys(publishedAlice),
      ],
      existingSecret: null,
      latestKnownSecretVersion: null,
      rotateSecret: false,
      replyToMessageId: null,
    });

    await Promise.resolve(
      mallory.conn.reducers.sendEncryptedMessage({
        agentDbId: mallory.actor.id,
        threadId: pendingRequest.threadId,
        secretVersion: firstPrepared.secretVersion,
        signingKeyVersion: firstPrepared.signingKeyVersion,
        senderSeq: 1n,
        ciphertext: firstPrepared.ciphertext,
        iv: firstPrepared.iv,
        cipherAlgorithm: firstPrepared.cipherAlgorithm,
        signature: firstPrepared.signature,
        replyToMessageId: undefined,
        attachedSecretEnvelopes: firstPrepared.attachedSecretEnvelopes,
      })
    );

    await waitFor(
      () =>
        listVisibleContactRequests(mallory.conn).find(request => request.id === pendingRequest.id)
          ?.messageCount === 1n,
      'first hidden pre-approval message count'
    );

    const secondPrepared = await prepareEncryptedMessage({
      threadId: pendingRequest.threadId,
      senderActorId: mallory.actor.id,
      senderPublicIdentity: mallory.actor.publicIdentity,
      senderSeq: 2n,
      payload: {
        contentType: 'text/plain',
        body: 'hidden second contact',
      },
      keyPair: mallory.keyPair,
      recipients: [
        toActorPublicKeys(mallory.actor),
        toPublishedActorPublicKeys(publishedAlice),
      ],
      existingSecret: firstPrepared.senderSecret,
      latestKnownSecretVersion: firstPrepared.secretVersion,
      rotateSecret: false,
      replyToMessageId: null,
    });

    await expect(
      Promise.resolve(
        mallory.conn.reducers.sendEncryptedMessage({
          agentDbId: mallory.actor.id,
          threadId: pendingRequest.threadId,
          secretVersion: secondPrepared.secretVersion,
          signingKeyVersion: secondPrepared.signingKeyVersion,
          senderSeq: 2n,
          ciphertext: secondPrepared.ciphertext,
          iv: secondPrepared.iv,
          cipherAlgorithm: secondPrepared.cipherAlgorithm,
          signature: secondPrepared.signature,
          replyToMessageId: undefined,
          attachedSecretEnvelopes: secondPrepared.attachedSecretEnvelopes,
        })
      )
    ).rejects.toThrow(/one hidden pre-approval message/i);
  });

  it('blocks membership changes on pending direct-contact threads until requester approval or allowlist', async () => {
    const existingRequestIds = new Set(
      listVisibleContactRequests(alice.conn).map(request => request.id.toString())
    );

    await Promise.resolve(
      alice.conn.reducers.createPendingDirectContactRequest({
        agentDbId: alice.actor.id,
        otherAgentPublicIdentity: mallory.actor.publicIdentity,
        membershipLocked: false,
        title: `pending-membership-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      () =>
        listVisibleContactRequests(alice.conn).some(
          request =>
            request.requesterAgentDbId === alice.actor.id &&
            request.targetPublicIdentity === mallory.actor.publicIdentity &&
            request.status === 'pending' &&
            !existingRequestIds.has(request.id.toString())
        ),
      'pending direct-contact membership request visibility'
    );

    const pendingRequest = listVisibleContactRequests(alice.conn).find(
      request =>
        request.requesterAgentDbId === alice.actor.id &&
        request.targetPublicIdentity === mallory.actor.publicIdentity &&
        request.status === 'pending' &&
        !existingRequestIds.has(request.id.toString())
    );
    if (!pendingRequest) {
      throw new Error('Pending direct-contact request was not found for membership test');
    }

    await expect(
      Promise.resolve(
        alice.conn.reducers.addThreadParticipant({
          agentDbId: alice.actor.id,
          threadId: pendingRequest.threadId,
          participantPublicIdentity: bob.actor.publicIdentity,
        })
      )
    ).rejects.toThrow(/requester is allowlisted|request is approved/i);
  });

  it('allows first-contact group creation without granting direct-thread approval or allowlist side effects', async () => {
    const allowlistCountBefore = listVisibleAllowlistEntries(bob.conn).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;
    const existingThreadIds = new Set(listVisibleThreads(bob.conn).map(candidate => candidate.id.toString()));

    await Promise.resolve(
      bob.conn.reducers.createGroupThread({
        agentDbId: bob.actor.id,
        participantPublicIdentities: [mallory.actor.publicIdentity],
        membershipLocked: false,
        title: `group-first-contact-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      () =>
        listVisibleThreads(bob.conn).some(candidate => {
          if (candidate.kind !== 'group' || existingThreadIds.has(candidate.id.toString())) {
            return false;
          }
          const participantIds = new Set(
            listVisibleParticipants(bob.conn)
              .filter(participant => participant.threadId === candidate.id && participant.active)
              .map(participant => participant.agentDbId)
          );
          return participantIds.has(bob.actor.id) && participantIds.has(mallory.actor.id);
        }),
      'first-contact group creation visibility'
    );

    const allowlistCountAfter = listVisibleAllowlistEntries(bob.conn).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;

    expect(allowlistCountAfter).toBe(allowlistCountBefore);
    await expect(
      Promise.resolve(
        bob.conn.reducers.createDirectThread({
          agentDbId: bob.actor.id,
          otherAgentPublicIdentity: mallory.actor.publicIdentity,
          membershipLocked: true,
          title: `direct-after-group-${RUN_SUFFIX}`,
        })
      )
    ).rejects.toThrow(/requires approval for first contact/i);
  });

  it('lets group admins add new actors without creating direct-thread approval', async () => {
    const allowlistCountBefore = listVisibleAllowlistEntries(alice.conn).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;

    await Promise.resolve(
      alice.conn.reducers.createGroupThread({
        agentDbId: alice.actor.id,
        participantPublicIdentities: [bob.actor.publicIdentity],
        membershipLocked: false,
        title: `group-admin-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      () =>
        listVisibleThreads(alice.conn).some(candidate => {
          if (candidate.kind !== 'group' || candidate.title !== `group-admin-${RUN_SUFFIX}`) {
            return false;
          }
          const participantIds = new Set(
            listVisibleParticipants(alice.conn)
              .filter(participant => participant.threadId === candidate.id && participant.active)
              .map(participant => participant.agentDbId)
          );
          return participantIds.has(alice.actor.id) && participantIds.has(bob.actor.id);
        }),
      'admin-managed group creation visibility'
    );

    const adminGroup = listVisibleThreads(alice.conn).find(candidate => {
      if (candidate.kind !== 'group' || candidate.title !== `group-admin-${RUN_SUFFIX}`) {
        return false;
      }
      const participantIds = new Set(
        listVisibleParticipants(alice.conn)
          .filter(participant => participant.threadId === candidate.id && participant.active)
          .map(participant => participant.agentDbId)
      );
      return participantIds.has(alice.actor.id) && participantIds.has(bob.actor.id);
    });
    if (!adminGroup) {
      throw new Error('Admin group thread was not found after creation');
    }

    await Promise.resolve(
      alice.conn.reducers.addThreadParticipant({
        agentDbId: alice.actor.id,
        threadId: adminGroup.id,
        participantPublicIdentity: mallory.actor.publicIdentity,
      })
    );

    await waitFor(
      () =>
        listVisibleParticipants(alice.conn).some(
          participant =>
            participant.threadId === adminGroup.id &&
            participant.agentDbId === mallory.actor.id &&
            participant.active
        ),
      'group participant add visibility'
    );

    const allowlistCountAfter = listVisibleAllowlistEntries(alice.conn).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;

    expect(allowlistCountAfter).toBe(allowlistCountBefore);
    await expect(
      Promise.resolve(
        bob.conn.reducers.createDirectThread({
          agentDbId: bob.actor.id,
          otherAgentPublicIdentity: mallory.actor.publicIdentity,
          membershipLocked: true,
          title: `direct-after-admin-add-${RUN_SUFFIX}`,
        })
      )
    ).rejects.toThrow(/requires approval for first contact/i);
  });

  const optionalInvalidTokenCases = [
    ['wrong issuer token', process.env.SECURITY_TEST_WRONG_ISSUER_ID_TOKEN],
    ['wrong audience token', process.env.SECURITY_TEST_WRONG_AUDIENCE_ID_TOKEN],
    ['expired token', process.env.SECURITY_TEST_EXPIRED_ID_TOKEN],
    ['unverified email token', process.env.SECURITY_TEST_UNVERIFIED_EMAIL_ID_TOKEN],
    ['mismatched identity token', process.env.SECURITY_TEST_MISMATCH_ID_TOKEN],
  ] as const;

  for (const [label, token] of optionalInvalidTokenCases) {
    it.skipIf(!token)(`rejects bootstrap for ${label}`, async () => {
      const errorMessage = await captureBootstrapFailure(token!);
      expect(errorMessage).toMatch(/Unauthorized|verify|email_verified|OIDC|bound to|different/i);
    });
  }
});
