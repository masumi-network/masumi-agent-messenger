// Live security tests exercise real two-agent flows against a running
// SpacetimeDB runtime. They skip unless local auth/runtime env is present.

import { webcrypto } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { DbConnection, tables } from '@/module_bindings';
import type {
  Account,
  AccountChangeSignal,
  Agent,
  Channel,
  ChannelJoinRequest,
  ChannelMessage,
  ContactAllowlistEntry,
  ContactRequest,
  Message,
  Thread,
  ThreadInvite,
  ThreadParticipantPreview,
} from '@/module_bindings/types';
import {
  decryptMessage,
  fromHex,
  generateAgentKeyPair,
  prepareEncryptedMessage,
  toHex,
  type ActorPublicKeys,
  type AgentKeyPair,
  type SenderSecretState,
} from '@/lib/crypto';
import {
  fetchPublishedPublicRouteBySlug,
  resolvePublishedActorBySlug,
} from '@/lib/spacetimedb-server';
import { generateDeviceKeyPair } from '../../../../shared/device-sharing';
import { prepareChannelMessage } from '../../../../shared/channel-crypto';
import {
  formatEncryptedMessageBody,
  parseDecryptedMessagePlaintext,
} from '../../../../shared/message-format';
import { generateClientThreadId } from '../../../../shared/inbox-state';
import { prepareSpacetimeSubscriptionQuery } from '../../../../shared/spacetime-subscription-limits';

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
  deviceId: string;
  keyPair: AgentKeyPair;
  actor: Agent;
};

type ActorFixture = {
  owner: ProvisionedClient;
  actor: Agent;
  keyPair: AgentKeyPair;
};

type SignalVersionKey =
  | 'ownedAgentsVersion'
  | 'ownedDevicesVersion'
  | 'contactRequestsVersion'
  | 'threadInvitesVersion'
  | 'contactAllowlistVersion'
  | 'channelJoinRequestsVersion'
  | 'threadListVersion';

const SIGNAL_VERSION_KEYS: SignalVersionKey[] = [
  'ownedAgentsVersion',
  'ownedDevicesVersion',
  'contactRequestsVersion',
  'threadInvitesVersion',
  'contactAllowlistVersion',
  'channelJoinRequestsVersion',
  'threadListVersion',
];

const VISIBLE_QUERIES = [
  prepareSpacetimeSubscriptionQuery(tables.visible_accounts, 'visible_accounts'),
  prepareSpacetimeSubscriptionQuery(tables.visible_account_change_signal, 'visible_account_change_signal'),
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

function securityDeviceId(label: string): string {
  return `${label}-security-device-${RUN_SUFFIX}`;
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

function listVisibleAccounts(conn: DbConnection): Account[] {
  return Array.from(conn.db.visible_accounts.iter());
}

function readAccountSignal(conn: DbConnection): AccountChangeSignal | null {
  return Array.from(conn.db.visible_account_change_signal.iter())[0] ?? null;
}

async function waitForAccountSignal(
  conn: DbConnection,
  label: string
): Promise<AccountChangeSignal> {
  let signal: AccountChangeSignal | null = null;
  await waitFor(() => {
    signal = readAccountSignal(conn);
    return signal !== null;
  }, `${label} account signal`);
  if (!signal) {
    throw new Error(`Account signal missing for ${label}`);
  }
  return signal;
}

async function waitForSignalVersions(
  conn: DbConnection,
  before: AccountChangeSignal,
  changedKeys: SignalVersionKey[],
  label: string
): Promise<AccountChangeSignal> {
  const changed = new Set<SignalVersionKey>(changedKeys);
  let after = before;
  await waitFor(() => {
    const current = readAccountSignal(conn);
    if (!current) return false;
    after = current;
    return changedKeys.every(key => current[key] > before[key]);
  }, `${label} signal bump`);

  for (const key of SIGNAL_VERSION_KEYS) {
    if (changed.has(key)) {
      expect(after[key] > before[key], `${label} should bump ${key}`).toBe(true);
    } else {
      expect(after[key], `${label} should not bump ${key}`).toBe(before[key]);
    }
  }
  return after;
}

async function expectSignalChange(
  conn: DbConnection,
  changedKeys: SignalVersionKey[],
  action: () => Promise<void>,
  label: string
): Promise<AccountChangeSignal> {
  const before = await waitForAccountSignal(conn, label);
  await action();
  return await waitForSignalVersions(conn, before, changedKeys, label);
}

function mergeRowsById<Row extends { id: bigint }>(...groups: Row[][]): Row[] {
  const rows = new Map<bigint, Row>();
  for (const group of groups) {
    for (const row of group) {
      rows.set(row.id, row);
    }
  }
  return Array.from(rows.values());
}

async function listOwnedAgents(conn: DbConnection): Promise<Agent[]> {
  const rows: Agent[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listOwnedAgentsPage({ afterId, limit: 250 });
    rows.push(...page.agents);
    if (!page.nextAfterId) return rows;
    afterId = page.nextAfterId;
  }
}

async function listVisibleThreadPage(conn: DbConnection) {
  const actors = await listOwnedAgents(conn);
  const actor = actors.find(row => row.isDefault) ?? actors[0] ?? null;
  if (!actor) {
    return {
      actors: [],
      participantPreviews: [],
      readStates: [],
      threads: [],
      nextAfterSortKey: undefined,
    };
  }
  return await conn.procedures.listVisibleThreads({
    agentDbId: actor.id,
    afterSortKey: undefined,
    limit: 25,
  });
}

async function listVisibleActors(conn: DbConnection): Promise<Agent[]> {
  const [owned, threadPage] = await Promise.all([
    listOwnedAgents(conn),
    listVisibleThreadPage(conn),
  ]);
  return mergeRowsById(owned, threadPage.actors);
}

async function listVisibleThreads(conn: DbConnection): Promise<Thread[]> {
  return (await listVisibleThreadPage(conn)).threads;
}

async function listVisibleParticipants(conn: DbConnection): Promise<ThreadParticipantPreview[]> {
  return (await listVisibleThreadPage(conn)).participantPreviews;
}

async function listVisibleThreadInvites(conn: DbConnection): Promise<ThreadInvite[]> {
  const page = await conn.procedures.listPendingThreadInvitesPage({
    afterSortKey: undefined,
    limit: 250,
  });
  return page.threadInvites;
}

async function listVisibleChannelJoinRequests(
  conn: DbConnection
): Promise<ChannelJoinRequest[]> {
  const page = await conn.procedures.listPendingChannelJoinRequestsPage({
    afterSortKey: undefined,
    limit: 250,
  });
  return page.joinRequests;
}

async function listVisibleContactRequests(conn: DbConnection): Promise<ContactRequest[]> {
  const page = await conn.procedures.listPendingContactRequestsPage({
    afterSortKey: undefined,
    limit: 250,
  });
  return page.contactRequests;
}

async function listVisibleAllowlistEntries(conn: DbConnection): Promise<ContactAllowlistEntry[]> {
  const rows: ContactAllowlistEntry[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listContactAllowlistEntries({
      afterId,
      limit: 250,
    });
    rows.push(...page);
    if (page.length < 250) return rows;
    afterId = page.at(-1)?.id;
    if (afterId === undefined) return rows;
  }
}

function toPublishedActorPublicKeys(actor: {
  slug: string;
  publicIdentity: string;
  isDefault: boolean;
  displayName?: string | null;
  encryptionPublicKey: string;
  encryptionKeyVersion: number;
  signingPublicKey: string;
  signingKeyVersion: number;
}): ActorPublicKeys {
  return {
    email: '',
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
    wrappedSecretCiphertext: fromHex(envelope.wrappedSecretCiphertext),
    wrappedSecretIv: fromHex(envelope.wrappedSecretIv),
    wrapAlgorithm: toWrapAlgorithm(envelope.wrapAlgorithm),
    signature: fromHex(envelope.signature),
  }));
}

function flipFirstHexByte(hex: string): string {
  if (hex.length < 2) {
    throw new Error('hex value is too short to tamper');
  }
  return `${hex.slice(0, 2) === '00' ? 'ff' : '00'}${hex.slice(2)}`;
}

let fixtureCounter = 0;
let signalSenderMessageCounter = 7_000n;

function actorPublicKeysFromAgent(actor: Agent, keyPair: AgentKeyPair): ActorPublicKeys {
  return {
    actorId: actor.id,
    email: actor.email,
    slug: actor.slug,
    isDefault: actor.isDefault,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName ?? null,
    encryptionPublicKey: keyPair.encryption.publicKey,
    encryptionKeyVersion: keyPair.encryption.keyVersion,
    signingPublicKey: keyPair.signing.publicKey,
    signingKeyVersion: keyPair.signing.keyVersion,
  };
}

function actorPublicKeysFromClient(client: ProvisionedClient): ActorPublicKeys {
  return actorPublicKeysFromAgent(client.actor, client.keyPair);
}

function actorFixtureFromClient(client: ProvisionedClient): ActorFixture {
  return {
    owner: client,
    actor: client.actor,
    keyPair: client.keyPair,
  };
}

async function createOwnedActor(
  owner: ProvisionedClient,
  purpose: string
): Promise<ActorFixture> {
  fixtureCounter += 1;
  const slug = `${owner.label}-${purpose}-${RUN_SUFFIX}-${fixtureCounter}`;
  const keyPair = await generateAgentKeyPair({
    encryptionKeyVersion: 1,
    signingKeyVersion: 1,
  });
  const signalBefore = await waitForAccountSignal(owner.conn, `${slug} createAgent`);

  await Promise.resolve(
    owner.conn.reducers.createAgent({
      slug,
      displayName: `${owner.label} ${purpose} signal actor`,
      encryptionPublicKey: keyPair.encryption.publicKey,
      keyBundleVersion: keyPair.encryption.keyVersion,
      encryptionAlgorithm: toEncryptionAlgorithm(keyPair.encryption.algorithm),
      signingPublicKey: keyPair.signing.publicKey,
      signingAlgorithm: toSigningAlgorithm(keyPair.signing.algorithm),
    })
  );
  await waitForSignalVersions(
    owner.conn,
    signalBefore,
    ['ownedAgentsVersion'],
    `${slug} createAgent`
  );

  await waitFor(
    async () => (await listOwnedAgents(owner.conn)).some(actor => actor.slug === slug),
    `${slug} actor creation`
  );

  const actor = (await listOwnedAgents(owner.conn)).find(row => row.slug === slug);
  if (!actor) {
    throw new Error(`Unable to find created actor ${slug}`);
  }
  return {
    owner,
    actor,
    keyPair,
  };
}

function nextSignalSenderMessageId(): bigint {
  signalSenderMessageCounter += 1n;
  return signalSenderMessageCounter;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function listThreadMessagesFor(
  client: ProvisionedClient,
  threadId: bigint
): Promise<Message[]> {
  const page = await client.conn.procedures.listThreadMessages({
    agentDbId: client.actor.id,
    threadId,
    beforeMessageId: undefined,
    limit: 25,
  });
  return page.messages;
}

async function createPendingContactRequest(params: {
  requester: ActorFixture;
  target: ActorFixture;
  title: string;
}): Promise<ContactRequest> {
  const threadId = generateClientThreadId();
  const senderMessageId = nextSignalSenderMessageId();
  const prepared = await prepareEncryptedMessage({
    threadId,
    senderActorId: params.requester.actor.id,
    senderPublicIdentity: params.requester.actor.publicIdentity,
    senderMessageId,
    payload: {
      contentType: 'text/plain',
      body: `signal contact ${params.title}`,
    },
    keyPair: params.requester.keyPair,
    recipients: [
      actorPublicKeysFromAgent(params.requester.actor, params.requester.keyPair),
      actorPublicKeysFromAgent(params.target.actor, params.target.keyPair),
    ],
    existingSecret: null,
    latestKnownSecretVersion: null,
    rotateSecret: false,
    replyToMessageId: null,
  });

  await Promise.resolve(
    params.requester.owner.conn.reducers.requestDirectContact({
      agentDbId: params.requester.actor.id,
      otherAgentPublicIdentity: params.target.actor.publicIdentity,
      threadId,
      title: params.title,
      secretVersion: prepared.secretVersion,
      signingKeyVersion: prepared.signingKeyVersion,
      senderMessageId,
      ciphertext: fromHex(prepared.ciphertext),
      iv: fromHex(prepared.iv),
      cipherAlgorithm: toCipherAlgorithm(prepared.cipherAlgorithm),
      signature: fromHex(prepared.signature),
      attachedSecretEnvelopes: toReducerEnvelopes(prepared.attachedSecretEnvelopes),
    })
  );

  await waitFor(
    async () =>
      (await listVisibleContactRequests(params.requester.owner.conn)).some(
        request => request.threadId === threadId && request.status.tag === 'Pending'
      ),
    `${params.title} pending contact request`
  );
  const request = (await listVisibleContactRequests(params.requester.owner.conn)).find(
    row => row.threadId === threadId
  );
  if (!request) {
    throw new Error(`Pending contact request not found for ${params.title}`);
  }
  return request;
}

async function createVisibleGroupThread(params: {
  owner: ActorFixture;
  participants: ActorFixture[];
  title: string;
}): Promise<Thread> {
  const signalClients = [params.owner, ...params.participants].filter(
    (fixture, index, fixtures) =>
      fixtures.findIndex(candidate => candidate.owner.label === fixture.owner.label) === index
  );
  const signalBefore = await Promise.all(
    signalClients.map(async fixture => ({
      fixture,
      signal: await waitForAccountSignal(fixture.owner.conn, `${params.title} group signal`),
    }))
  );
  await Promise.resolve(
    params.owner.owner.conn.reducers.createThread({
      agentDbId: params.owner.actor.id,
      kind: { tag: 'Group' },
      otherAgentPublicIdentity: undefined,
      participantPublicIdentities: params.participants.map(
        participant => participant.actor.publicIdentity
      ),
      title: params.title,
    })
  );

  await waitFor(
    async () =>
      (await listVisibleThreads(params.owner.owner.conn)).some(
        thread => thread.kind.tag === 'Group' && thread.title === params.title
      ),
    `${params.title} group thread`
  );
  const thread = (await listVisibleThreads(params.owner.owner.conn)).find(
    row => row.kind.tag === 'Group' && row.title === params.title
  );
  if (!thread) {
    throw new Error(`Group thread not found for ${params.title}`);
  }
  await Promise.all(
    signalBefore.map(async ({ fixture, signal }) => {
      await waitForSignalVersions(
        fixture.owner.conn,
        signal,
        ['threadListVersion'],
        `${params.title} group signal ${fixture.owner.label}`
      );
    })
  );
  return thread;
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
  const bootstrapKeys = await generateAgentKeyPair({
    encryptionKeyVersion: 1,
    signingKeyVersion: 1,
  });
  const bootstrapDevice = await generateDeviceKeyPair();
  const deviceId = securityDeviceId(label);

  await Promise.resolve(
    client.conn.reducers.upsertAccountFromOidcIdentity({
      displayName: `${label} security bootstrap`,
      defaultSlug: undefined,
      encryptionPublicKey: bootstrapKeys.encryption.publicKey,
      keyBundleVersion: bootstrapKeys.encryption.keyVersion,
      encryptionAlgorithm: toEncryptionAlgorithm(bootstrapKeys.encryption.algorithm),
      signingPublicKey: bootstrapKeys.signing.publicKey,
      signingAlgorithm: toSigningAlgorithm(bootstrapKeys.signing.algorithm),
      deviceId,
      deviceLabel: `${label} security device`,
      devicePlatform: 'vitest',
      deviceEncryptionPublicKey: bootstrapDevice.publicKey,
      deviceEncryptionKeyVersion: bootstrapDevice.keyVersion,
      deviceEncryptionAlgorithm: toDeviceEncryptionAlgorithm(bootstrapDevice.algorithm),
    })
  );

  await waitFor(
    () =>
      listVisibleAccounts(client.conn).some(account => account.email.toLowerCase() === email.toLowerCase()),
    `${label} account bootstrap`
  );
}

async function provisionClient(label: string, token: string): Promise<ProvisionedClient> {
  const identity = parseTokenIdentity(token);
  const connected = await connectVisibleClient(token);

  await ensureBootstrap(connected, label, identity.email);

  const keyPair = await generateAgentKeyPair({
    encryptionKeyVersion: 1,
    signingKeyVersion: 1,
  });
  const slug = `${label}-sec-${RUN_SUFFIX}`;

  await Promise.resolve(
    connected.conn.reducers.createAgent({
      slug,
      displayName: `${label} security actor`,
      encryptionPublicKey: keyPair.encryption.publicKey,
      keyBundleVersion: keyPair.encryption.keyVersion,
      encryptionAlgorithm: toEncryptionAlgorithm(keyPair.encryption.algorithm),
      signingPublicKey: keyPair.signing.publicKey,
      signingAlgorithm: toSigningAlgorithm(keyPair.signing.algorithm),
    })
  );

  await waitFor(
    async () => (await listVisibleActors(connected.conn)).some(actor => actor.slug === slug),
    `${label} isolated actor`
  );

  const actor = (await listVisibleActors(connected.conn)).find(row => row.slug === slug);
  if (!actor) {
    throw new Error(`Unable to find created actor for ${label}`);
  }

  return {
    label,
    token,
    email: identity.email,
    subject: identity.subject,
    conn: connected.conn,
    deviceId: securityDeviceId(label),
    keyPair,
    actor,
  };
}

async function findVersionedKey(
  conn: DbConnection,
  actor: Agent,
  kind: 'encryption' | 'signing',
  version: number
): Promise<string | null> {
  const rows = await conn.procedures.lookupAgentPublicKeys({
    requests: [
      {
        agentDbId: actor.id,
        keyKind: { tag: kind === 'encryption' ? 'Encryption' : 'Signing' },
        keyVersion: version,
      },
    ],
  });
  return rows[0]?.publicKey ?? null;
}

async function decryptLatestMessage(
  recipient: ProvisionedClient,
  message: Message
): Promise<string> {
  const sender = (await listVisibleActors(recipient.conn)).find(
    actor => actor.id === message.senderAgentDbId
  );
  if (!sender) {
    throw new Error('Sender actor is not visible to recipient');
  }

  const envelopes = await recipient.conn.procedures.listThreadSecretEnvelopes({
    agentDbId: recipient.actor.id,
    threadId: message.threadId,
    membershipVersion: undefined,
    senderAgentDbId: message.senderAgentDbId,
    recipientAgentDbId: recipient.actor.id,
    secretVersion: message.secretVersion,
    afterId: undefined,
    limit: undefined,
  });
  const envelope = envelopes.find(row => {
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

  const senderEncryptionPublicKey = await findVersionedKey(
    recipient.conn,
    sender,
    'encryption',
    envelope.senderEncryptionKeyVersion
  );
  const messageSigningPublicKey = await findVersionedKey(
    recipient.conn,
    sender,
    'signing',
    message.signingKeyVersion
  );
  const envelopeSigningPublicKey = await findVersionedKey(
    recipient.conn,
    sender,
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
      senderMessageId: message.senderMessageId,
      secretVersion: message.secretVersion,
      signingKeyVersion: message.signingKeyVersion,
      ciphertext: toHex(message.ciphertext),
      iv: toHex(message.iv),
      cipherAlgorithm: cipherAlgorithmLabel(message.cipherAlgorithm),
      signature: toHex(message.signature),
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
      wrappedSecretCiphertext: toHex(envelope.wrappedSecretCiphertext),
      wrappedSecretIv: toHex(envelope.wrappedSecretIv),
      wrapAlgorithm: wrapAlgorithmLabel(envelope.wrapAlgorithm),
      signature: toHex(envelope.signature),
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
        encryptionKeyVersion: 1,
        signingKeyVersion: 1,
      });
      const deviceKeyPair = await generateDeviceKeyPair();
      await Promise.resolve(
        connected.conn.reducers.upsertAccountFromOidcIdentity({
          displayName: 'invalid security bootstrap',
          defaultSlug: undefined,
          encryptionPublicKey: keyPair.encryption.publicKey,
          keyBundleVersion: keyPair.encryption.keyVersion,
          encryptionAlgorithm: toEncryptionAlgorithm(keyPair.encryption.algorithm),
          signingPublicKey: keyPair.signing.publicKey,
          signingAlgorithm: toSigningAlgorithm(keyPair.signing.algorithm),
          deviceId: `invalid-security-device-${RUN_SUFFIX}`,
          deviceLabel: 'invalid security device',
          devicePlatform: 'vitest',
          deviceEncryptionPublicKey: deviceKeyPair.publicKey,
          deviceEncryptionKeyVersion: deviceKeyPair.keyVersion,
          deviceEncryptionAlgorithm: toDeviceEncryptionAlgorithm(deviceKeyPair.algorithm),
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
  let thread: Thread;
  let bobActorFromAliceView: Agent;
  let sentMessage: Message;
  let sentSenderSecret: SenderSecretState;

  beforeAll(async () => {
    alice = await provisionClient('alice', REQUIRED_TOKENS.alice!);
    bob = await provisionClient('bob', REQUIRED_TOKENS.bob!);
    mallory = await provisionClient('mallory', REQUIRED_TOKENS.mallory!);

    await Promise.resolve(
      alice.conn.reducers.createThread({
        agentDbId: alice.actor.id,
        kind: { tag: 'Direct' },
        otherAgentPublicIdentity: bob.actor.publicIdentity,
        participantPublicIdentities: undefined,
        title: `security-${RUN_SUFFIX}`,
      })
    );
    await waitFor(
      async () =>
        (await listVisibleThreads(alice.conn)).length > 0 &&
        (await listVisibleThreads(bob.conn)).length > 0 &&
        (await listVisibleActors(alice.conn)).some(
          actor => actor.publicIdentity === bob.actor.publicIdentity
        ),
      'alice/bob direct thread visibility'
    );

    bobActorFromAliceView = (await listVisibleActors(alice.conn)).find(
      actor => actor.publicIdentity === bob.actor.publicIdentity
    )!;
    if (!bobActorFromAliceView) {
      throw new Error('Bob actor never became visible to Alice');
    }

    const aliceParticipants = await listVisibleParticipants(alice.conn);
    const aliceThreadFromParticipants = (await listVisibleThreads(alice.conn)).find(candidate => {
      const participants = aliceParticipants.filter(
        participant => participant.threadId === candidate.id && participant.active
      );
      const participantIds = new Set(participants.map(participant => participant.agentDbId));
      return participantIds.has(alice.actor.id) && participantIds.has(bobActorFromAliceView.id);
    });
    if (!aliceThreadFromParticipants) {
      throw new Error('Expected shared Alice/Bob thread');
    }
    thread = aliceThreadFromParticipants;

    const participants = [actorPublicKeysFromClient(alice), actorPublicKeysFromClient(bob)];

    const prepared = await prepareEncryptedMessage({
      threadId: thread.id,
      senderActorId: alice.actor.id,
      senderPublicIdentity: alice.actor.publicIdentity,
      senderMessageId: 101n,
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
    sentSenderSecret = prepared.senderSecret;

    await Promise.resolve(
      alice.conn.reducers.sendEncryptedMessage({
        agentDbId: alice.actor.id,
        threadId: thread.id,
        secretVersion: prepared.secretVersion,
        signingKeyVersion: prepared.signingKeyVersion,
        senderMessageId: 101n,
        ciphertext: fromHex(prepared.ciphertext),
        iv: fromHex(prepared.iv),
        cipherAlgorithm: toCipherAlgorithm(prepared.cipherAlgorithm),
        signature: fromHex(prepared.signature),
        replyToMessageId: undefined,
        attachedSecretEnvelopes: toReducerEnvelopes(prepared.attachedSecretEnvelopes),
      })
    );
    await waitFor(
      async () =>
        (await listVisibleThreads(bob.conn)).some(
          visibleThread =>
            visibleThread.id === thread.id && visibleThread.lastMessageId >= 1n
        ),
      'bob inbound thread signal'
    );

    const bobMessage = (await listThreadMessagesFor(bob, thread.id)).find(
      message => message.threadId === thread.id
    );
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
      expect(listVisibleAccounts(anonymous.conn)).toHaveLength(0);
      expect(await listVisibleActors(anonymous.conn)).toHaveLength(0);
      expect(await listVisibleThreads(anonymous.conn)).toHaveLength(0);
      expect(await listVisibleParticipants(anonymous.conn)).toHaveLength(0);
    } finally {
      anonymous.conn.disconnect();
    }
  });

  it('bumps account signal slices for owned agents, devices, allowlist, and thread list reducers', async () => {
    const createAgentBefore = await waitForAccountSignal(alice.conn, 'createAgent');
    const ownedSignalActor = await createOwnedActor(alice, 'owned-signal');
    await waitForSignalVersions(
      alice.conn,
      createAgentBefore,
      ['ownedAgentsVersion'],
      'createAgent'
    );

    await expectSignalChange(
      alice.conn,
      ['ownedAgentsVersion'],
      async () => {
        await Promise.resolve(
          alice.conn.reducers.updateAgentProfile({
            agentDbId: ownedSignalActor.actor.id,
            displayName: `Owned signal profile ${RUN_SUFFIX}`,
            publicDescription: 'Signal profile update coverage',
            publicLinkedEmailEnabled: undefined,
            allowAllMessageContentTypes: undefined,
            allowAllMessageHeaders: undefined,
            supportedMessageContentTypes: undefined,
            supportedMessageHeaderNames: undefined,
          })
        );
      },
      'updateAgentProfile'
    );

    await expectSignalChange(
      alice.conn,
      ['ownedAgentsVersion'],
      async () => {
        await Promise.resolve(
          alice.conn.reducers.upsertMasumiRegistration({
            agentDbId: ownedSignalActor.actor.id,
            masumiRegistrationNetwork: 'preprod',
            masumiInboxAgentId: `inbox-${RUN_SUFFIX}`,
            masumiAgentIdentifier: `agent-${RUN_SUFFIX}`,
            masumiRegistrationState: { tag: 'Registered' },
          })
        );
      },
      'upsertMasumiRegistration'
    );

    const rotated = await generateAgentKeyPair({
      encryptionKeyVersion: ownedSignalActor.actor.currentKeyBundleVersion + 1,
      signingKeyVersion: ownedSignalActor.actor.currentKeyBundleVersion + 1,
    });
    await expectSignalChange(
      alice.conn,
      ['ownedAgentsVersion'],
      async () => {
        await Promise.resolve(
          alice.conn.reducers.rotateAgentKeys({
            agentDbId: ownedSignalActor.actor.id,
            encryptionPublicKey: rotated.encryption.publicKey,
            keyBundleVersion: rotated.encryption.keyVersion,
            encryptionAlgorithm: toEncryptionAlgorithm(rotated.encryption.algorithm),
            signingPublicKey: rotated.signing.publicKey,
            signingAlgorithm: toSigningAlgorithm(rotated.signing.algorithm),
          })
        );
      },
      'rotateAgentKeys'
    );

    const deviceKeys = await generateDeviceKeyPair();
    const signalDeviceId = `signal-device-${RUN_SUFFIX}`;
    await expectSignalChange(
      alice.conn,
      ['ownedDevicesVersion'],
      async () => {
        await Promise.resolve(
          alice.conn.reducers.registerDevice({
            deviceId: signalDeviceId,
            label: 'Signal coverage device',
            platform: 'vitest',
            deviceEncryptionPublicKey: deviceKeys.publicKey,
            deviceEncryptionKeyVersion: deviceKeys.keyVersion,
            deviceEncryptionAlgorithm: toDeviceEncryptionAlgorithm(deviceKeys.algorithm),
          })
        );
      },
      'registerDevice'
    );
    await expectSignalChange(
      alice.conn,
      ['ownedDevicesVersion'],
      async () => {
        await Promise.resolve(alice.conn.reducers.revokeDevice({ deviceId: signalDeviceId }));
      },
      'revokeDevice'
    );

    const allowlistEmail = `signal-${RUN_SUFFIX}@example.test`;
    await expectSignalChange(
      alice.conn,
      ['contactAllowlistVersion'],
      async () => {
        await Promise.resolve(
          alice.conn.reducers.addContactAllowlistEntry({
            agentDbId: alice.actor.id,
            kind: { tag: 'Email' },
            agentPublicIdentity: undefined,
            email: allowlistEmail,
          })
        );
      },
      'addContactAllowlistEntry'
    );
    const allowlistEntry = (await listVisibleAllowlistEntries(alice.conn)).find(
      entry => entry.email === allowlistEmail
    );
    if (!allowlistEntry) {
      throw new Error('Signal allowlist entry was not created');
    }
    await expectSignalChange(
      alice.conn,
      ['contactAllowlistVersion'],
      async () => {
        await Promise.resolve(
          alice.conn.reducers.removeContactAllowlistEntry({ entryId: allowlistEntry.id })
        );
      },
      'removeContactAllowlistEntry'
    );

    const aliceFixture = actorFixtureFromClient(alice);
    const bobFixture = actorFixtureFromClient(bob);
    const signalThread = await createVisibleGroupThread({
      owner: aliceFixture,
      participants: [bobFixture],
      title: `thread-signal-${RUN_SUFFIX}`,
    });

    await expectSignalChange(
      alice.conn,
      ['threadListVersion'],
      async () => {
        await Promise.resolve(
          alice.conn.reducers.updateThreadReadState({
            agentDbId: alice.actor.id,
            threadId: signalThread.id,
            lastReadMessageId: undefined,
            archived: true,
          })
        );
      },
      'updateThreadReadState'
    );

    const sendBeforeAlice = await waitForAccountSignal(alice.conn, 'sendEncryptedMessage alice');
    const sendBeforeBob = await waitForAccountSignal(bob.conn, 'sendEncryptedMessage bob');
    const signalSenderMessageId = nextSignalSenderMessageId();
    const prepared = await prepareEncryptedMessage({
      threadId: signalThread.id,
      senderActorId: alice.actor.id,
      senderPublicIdentity: alice.actor.publicIdentity,
      senderMessageId: signalSenderMessageId,
      payload: {
        contentType: 'text/plain',
        body: 'thread signal fanout',
      },
      keyPair: alice.keyPair,
      recipients: [actorPublicKeysFromClient(alice), actorPublicKeysFromClient(bob)],
      existingSecret: null,
      latestKnownSecretVersion: null,
      rotateSecret: true,
      replyToMessageId: null,
    });
    await Promise.resolve(
      alice.conn.reducers.sendEncryptedMessage({
        agentDbId: alice.actor.id,
        threadId: signalThread.id,
        secretVersion: prepared.secretVersion,
        signingKeyVersion: prepared.signingKeyVersion,
        senderMessageId: signalSenderMessageId,
        ciphertext: fromHex(prepared.ciphertext),
        iv: fromHex(prepared.iv),
        cipherAlgorithm: toCipherAlgorithm(prepared.cipherAlgorithm),
        signature: fromHex(prepared.signature),
        replyToMessageId: undefined,
        attachedSecretEnvelopes: toReducerEnvelopes(prepared.attachedSecretEnvelopes),
      })
    );
    await waitForSignalVersions(
      alice.conn,
      sendBeforeAlice,
      ['threadListVersion'],
      'sendEncryptedMessage alice'
    );
    await waitForSignalVersions(
      bob.conn,
      sendBeforeBob,
      ['threadListVersion'],
      'sendEncryptedMessage bob'
    );

    const adminBeforeAlice = await waitForAccountSignal(alice.conn, 'setThreadParticipantAdmin alice');
    const adminBeforeBob = await waitForAccountSignal(bob.conn, 'setThreadParticipantAdmin bob');
    await Promise.resolve(
      alice.conn.reducers.setThreadParticipantAdmin({
        agentDbId: alice.actor.id,
        threadId: signalThread.id,
        targetAgentDbId: bob.actor.id,
        isAdmin: true,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      adminBeforeAlice,
      ['threadListVersion'],
      'setThreadParticipantAdmin alice'
    );
    await waitForSignalVersions(
      bob.conn,
      adminBeforeBob,
      ['threadListVersion'],
      'setThreadParticipantAdmin bob'
    );

    const removeThread = await createVisibleGroupThread({
      owner: aliceFixture,
      participants: [bobFixture],
      title: `remove-signal-${RUN_SUFFIX}`,
    });
    const removeBeforeAlice = await waitForAccountSignal(alice.conn, 'removeThreadParticipant alice');
    const removeBeforeBob = await waitForAccountSignal(bob.conn, 'removeThreadParticipant bob');
    await Promise.resolve(
      alice.conn.reducers.removeThreadParticipant({
        agentDbId: alice.actor.id,
        threadId: removeThread.id,
        targetAgentDbId: bob.actor.id,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      removeBeforeAlice,
      ['threadListVersion'],
      'removeThreadParticipant alice'
    );
    await waitForSignalVersions(
      bob.conn,
      removeBeforeBob,
      ['threadListVersion'],
      'removeThreadParticipant bob'
    );

    const deleteThread = await createVisibleGroupThread({
      owner: aliceFixture,
      participants: [bobFixture],
      title: `delete-signal-${RUN_SUFFIX}`,
    });
    const deleteBeforeAlice = await waitForAccountSignal(alice.conn, 'deleteThread alice');
    const deleteBeforeBob = await waitForAccountSignal(bob.conn, 'deleteThread bob');
    await Promise.resolve(
      alice.conn.reducers.deleteThread({
        agentDbId: alice.actor.id,
        threadId: deleteThread.id,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      deleteBeforeAlice,
      ['threadListVersion'],
      'deleteThread alice'
    );
    await waitForSignalVersions(
      bob.conn,
      deleteBeforeBob,
      ['threadListVersion'],
      'deleteThread bob'
    );
  });

  it('bumps contact request signals for requester and target lifecycle reducers', async () => {
    const approveRequester = await createOwnedActor(alice, 'contact-approve-requester');
    const approveTarget = await createOwnedActor(bob, 'contact-approve-target');
    const requestBeforeAlice = await waitForAccountSignal(alice.conn, 'requestDirectContact alice');
    const requestBeforeBob = await waitForAccountSignal(bob.conn, 'requestDirectContact bob');
    const approveRequest = await createPendingContactRequest({
      requester: approveRequester,
      target: approveTarget,
      title: `contact-approve-${RUN_SUFFIX}`,
    });
    await waitForSignalVersions(
      alice.conn,
      requestBeforeAlice,
      ['contactRequestsVersion', 'threadListVersion'],
      'requestDirectContact alice'
    );
    await waitForSignalVersions(
      bob.conn,
      requestBeforeBob,
      ['contactRequestsVersion'],
      'requestDirectContact bob'
    );

    const approveBeforeAlice = await waitForAccountSignal(alice.conn, 'approveContactRequest alice');
    const approveBeforeBob = await waitForAccountSignal(bob.conn, 'approveContactRequest bob');
    await Promise.resolve(
      bob.conn.reducers.approveContactRequest({
        agentDbId: approveTarget.actor.id,
        requestId: approveRequest.id,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      approveBeforeAlice,
      ['contactRequestsVersion', 'threadListVersion'],
      'approveContactRequest alice'
    );
    await waitForSignalVersions(
      bob.conn,
      approveBeforeBob,
      ['contactRequestsVersion', 'threadListVersion'],
      'approveContactRequest bob'
    );

    const rejectRequester = await createOwnedActor(alice, 'contact-reject-requester');
    const rejectTarget = await createOwnedActor(bob, 'contact-reject-target');
    const rejectSetupBeforeAlice = await waitForAccountSignal(
      alice.conn,
      'reject setup contact request alice'
    );
    const rejectSetupBeforeBob = await waitForAccountSignal(
      bob.conn,
      'reject setup contact request bob'
    );
    const rejectRequest = await createPendingContactRequest({
      requester: rejectRequester,
      target: rejectTarget,
      title: `contact-reject-${RUN_SUFFIX}`,
    });
    await waitForSignalVersions(
      alice.conn,
      rejectSetupBeforeAlice,
      ['contactRequestsVersion', 'threadListVersion'],
      'reject setup contact request alice'
    );
    await waitForSignalVersions(
      bob.conn,
      rejectSetupBeforeBob,
      ['contactRequestsVersion'],
      'reject setup contact request bob'
    );
    const rejectBeforeAlice = await waitForAccountSignal(alice.conn, 'rejectContactRequest alice');
    const rejectBeforeBob = await waitForAccountSignal(bob.conn, 'rejectContactRequest bob');
    await Promise.resolve(
      bob.conn.reducers.rejectContactRequest({
        agentDbId: rejectTarget.actor.id,
        requestId: rejectRequest.id,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      rejectBeforeAlice,
      ['contactRequestsVersion', 'threadListVersion'],
      'rejectContactRequest alice'
    );
    await waitForSignalVersions(
      bob.conn,
      rejectBeforeBob,
      ['contactRequestsVersion'],
      'rejectContactRequest bob'
    );

    const cancelRequester = await createOwnedActor(alice, 'contact-cancel-requester');
    const cancelTarget = await createOwnedActor(bob, 'contact-cancel-target');
    const cancelSetupBeforeAlice = await waitForAccountSignal(
      alice.conn,
      'cancel setup contact request alice'
    );
    const cancelSetupBeforeBob = await waitForAccountSignal(
      bob.conn,
      'cancel setup contact request bob'
    );
    const cancelRequest = await createPendingContactRequest({
      requester: cancelRequester,
      target: cancelTarget,
      title: `contact-cancel-${RUN_SUFFIX}`,
    });
    await waitForSignalVersions(
      alice.conn,
      cancelSetupBeforeAlice,
      ['contactRequestsVersion', 'threadListVersion'],
      'cancel setup contact request alice'
    );
    await waitForSignalVersions(
      bob.conn,
      cancelSetupBeforeBob,
      ['contactRequestsVersion'],
      'cancel setup contact request bob'
    );
    const cancelBeforeAlice = await waitForAccountSignal(alice.conn, 'cancelContactRequest alice');
    const cancelBeforeBob = await waitForAccountSignal(bob.conn, 'cancelContactRequest bob');
    await Promise.resolve(
      alice.conn.reducers.cancelContactRequest({
        agentDbId: cancelRequester.actor.id,
        requestId: cancelRequest.id,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      cancelBeforeAlice,
      ['contactRequestsVersion', 'threadListVersion'],
      'cancelContactRequest alice'
    );
    await waitForSignalVersions(
      bob.conn,
      cancelBeforeBob,
      ['contactRequestsVersion'],
      'cancelContactRequest bob'
    );
  });

  it('bumps invite and channel-join signals for pending and resolved lifecycle reducers', async () => {
    const aliceFixture = actorFixtureFromClient(alice);
    const bobFixture = actorFixtureFromClient(bob);
    const invitee = await createOwnedActor(mallory, 'thread-invite-accept');
    const inviteThread = await createVisibleGroupThread({
      owner: aliceFixture,
      participants: [bobFixture],
      title: `invite-accept-${RUN_SUFFIX}`,
    });

    const inviteBeforeMallory = await waitForAccountSignal(mallory.conn, 'addThreadParticipant invitee');
    await Promise.resolve(
      alice.conn.reducers.addThreadParticipant({
        agentDbId: alice.actor.id,
        threadId: inviteThread.id,
        inviteePublicIdentity: invitee.actor.publicIdentity,
      })
    );
    await waitForSignalVersions(
      mallory.conn,
      inviteBeforeMallory,
      ['threadInvitesVersion'],
      'addThreadParticipant invitee'
    );
    await waitFor(
      async () =>
        (await listVisibleThreadInvites(mallory.conn)).some(
          invite =>
            invite.threadId === inviteThread.id &&
            invite.inviteeAgentDbId === invitee.actor.id &&
            invite.status.tag === 'Pending'
        ),
      'pending thread invite for accept'
    );
    const pendingInvite = (await listVisibleThreadInvites(mallory.conn)).find(
      invite => invite.threadId === inviteThread.id && invite.inviteeAgentDbId === invitee.actor.id
    );
    if (!pendingInvite) {
      throw new Error('Pending thread invite not found for signal accept coverage');
    }

    const acceptBeforeAlice = await waitForAccountSignal(alice.conn, 'acceptThreadInvite inviter');
    const acceptBeforeMallory = await waitForAccountSignal(mallory.conn, 'acceptThreadInvite invitee');
    await Promise.resolve(
      mallory.conn.reducers.acceptThreadInvite({
        agentDbId: invitee.actor.id,
        inviteId: pendingInvite.id,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      acceptBeforeAlice,
      ['threadInvitesVersion', 'threadListVersion'],
      'acceptThreadInvite inviter'
    );
    await waitForSignalVersions(
      mallory.conn,
      acceptBeforeMallory,
      ['threadInvitesVersion', 'threadListVersion'],
      'acceptThreadInvite invitee'
    );

    const declinee = await createOwnedActor(mallory, 'thread-invite-decline');
    const declineThread = await createVisibleGroupThread({
      owner: aliceFixture,
      participants: [bobFixture],
      title: `invite-decline-${RUN_SUFFIX}`,
    });
    const declineSetupBeforeMallory = await waitForAccountSignal(
      mallory.conn,
      'addThreadParticipant decline invitee'
    );
    await Promise.resolve(
      alice.conn.reducers.addThreadParticipant({
        agentDbId: alice.actor.id,
        threadId: declineThread.id,
        inviteePublicIdentity: declinee.actor.publicIdentity,
      })
    );
    await waitFor(
      async () =>
        (await listVisibleThreadInvites(mallory.conn)).some(
          invite =>
            invite.threadId === declineThread.id &&
            invite.inviteeAgentDbId === declinee.actor.id &&
            invite.status.tag === 'Pending'
        ),
      'pending thread invite for decline'
    );
    await waitForSignalVersions(
      mallory.conn,
      declineSetupBeforeMallory,
      ['threadInvitesVersion'],
      'addThreadParticipant decline invitee'
    );
    const declinedInvite = (await listVisibleThreadInvites(mallory.conn)).find(
      invite => invite.threadId === declineThread.id && invite.inviteeAgentDbId === declinee.actor.id
    );
    if (!declinedInvite) {
      throw new Error('Pending thread invite not found for signal decline coverage');
    }
    const declineBeforeAlice = await waitForAccountSignal(alice.conn, 'declineThreadInvite inviter');
    const declineBeforeMallory = await waitForAccountSignal(mallory.conn, 'declineThreadInvite invitee');
    await Promise.resolve(
      mallory.conn.reducers.declineThreadInvite({
        agentDbId: declinee.actor.id,
        inviteId: declinedInvite.id,
      })
    );
    await waitForSignalVersions(
      alice.conn,
      declineBeforeAlice,
      ['threadInvitesVersion'],
      'declineThreadInvite inviter'
    );
    await waitForSignalVersions(
      mallory.conn,
      declineBeforeMallory,
      ['threadInvitesVersion'],
      'declineThreadInvite invitee'
    );

    const channelSlug = `signal-approval-${RUN_SUFFIX}`;
    await Promise.resolve(
      alice.conn.reducers.createChannel({
        agentDbId: alice.actor.id,
        slug: channelSlug,
        title: 'Signal approval channel',
        description: undefined,
        accessMode: { tag: 'ApprovalRequired' },
        discoverable: false,
        defaultPermission: { tag: 'ReadWrite' },
      })
    );
    await waitFor(
      async () =>
        Boolean(
          await alice.conn.procedures.readVisibleChannelState({
            channelId: undefined,
            channelSlug,
          })
        ),
      'signal channel creation'
    );
    const channelState = await alice.conn.procedures.readVisibleChannelState({
      channelId: undefined,
      channelSlug,
    });
    const channel = channelState?.channel ?? null;
    if (!channel) {
      throw new Error('Signal approval channel was not created');
    }

    const joinBeforeAlice = await waitForAccountSignal(alice.conn, 'requestChannelJoin admin');
    const joinBeforeBob = await waitForAccountSignal(bob.conn, 'requestChannelJoin requester');
    await Promise.resolve(
      bob.conn.reducers.requestChannelJoin({
        agentDbId: bob.actor.id,
        channelId: channel.id,
        requestedPermission: { tag: 'ReadWrite' },
      })
    );
    await waitForSignalVersions(
      bob.conn,
      joinBeforeBob,
      ['channelJoinRequestsVersion'],
      'requestChannelJoin requester'
    );
    await waitFor(
      async () =>
        (await listVisibleChannelJoinRequests(alice.conn)).some(
          request =>
            request.channelId === channel.id &&
            request.requesterAgentDbId === bob.actor.id &&
            request.status.tag === 'Pending'
        ),
      'admin pending channel join request'
    );
    await waitForSignalVersions(
      alice.conn,
      joinBeforeAlice,
      ['channelJoinRequestsVersion'],
      'requestChannelJoin admin'
    );
    const rejectedJoinRequest = (await listVisibleChannelJoinRequests(alice.conn)).find(
      request =>
        request.channelId === channel.id &&
        request.requesterAgentDbId === bob.actor.id &&
        request.status.tag === 'Pending'
    );
    if (!rejectedJoinRequest) {
      throw new Error('Pending channel join request not found for reject coverage');
    }

    const rejectJoinBeforeAlice = await waitForAccountSignal(alice.conn, 'rejectChannelJoin admin');
    const rejectJoinBeforeBob = await waitForAccountSignal(bob.conn, 'rejectChannelJoin requester');
    await Promise.resolve(
      alice.conn.reducers.rejectChannelJoin({
        agentDbId: alice.actor.id,
        requestId: rejectedJoinRequest.id,
      })
    );
    await waitForSignalVersions(
      bob.conn,
      rejectJoinBeforeBob,
      ['channelJoinRequestsVersion'],
      'rejectChannelJoin requester'
    );
    await waitForSignalVersions(
      alice.conn,
      rejectJoinBeforeAlice,
      ['channelJoinRequestsVersion'],
      'rejectChannelJoin admin'
    );

    const approveJoinBeforeRequestBob = await waitForAccountSignal(
      bob.conn,
      'requestChannelJoin approval requester'
    );
    const approveJoinBeforeRequestAlice = await waitForAccountSignal(
      alice.conn,
      'requestChannelJoin approval admin'
    );
    await Promise.resolve(
      bob.conn.reducers.requestChannelJoin({
        agentDbId: bob.actor.id,
        channelId: channel.id,
        requestedPermission: { tag: 'ReadWrite' },
      })
    );
    await waitForSignalVersions(
      bob.conn,
      approveJoinBeforeRequestBob,
      ['channelJoinRequestsVersion'],
      'requestChannelJoin approval requester'
    );
    await waitFor(
      async () =>
        (await listVisibleChannelJoinRequests(alice.conn)).some(
          request =>
            request.channelId === channel.id &&
            request.requesterAgentDbId === bob.actor.id &&
            request.status.tag === 'Pending'
        ),
      'admin pending channel join request for approve'
    );
    await waitForSignalVersions(
      alice.conn,
      approveJoinBeforeRequestAlice,
      ['channelJoinRequestsVersion'],
      'requestChannelJoin approval admin'
    );
    const approvedJoinRequest = (await listVisibleChannelJoinRequests(alice.conn)).find(
      request =>
        request.channelId === channel.id &&
        request.requesterAgentDbId === bob.actor.id &&
        request.status.tag === 'Pending'
    );
    if (!approvedJoinRequest) {
      throw new Error('Pending channel join request not found for approve coverage');
    }
    const approveJoinBeforeAlice = await waitForAccountSignal(alice.conn, 'approveChannelJoin admin');
    const approveJoinBeforeBob = await waitForAccountSignal(bob.conn, 'approveChannelJoin requester');
    await Promise.resolve(
      alice.conn.reducers.approveChannelJoin({
        agentDbId: alice.actor.id,
        requestId: approvedJoinRequest.id,
      })
    );
    await waitForSignalVersions(
      bob.conn,
      approveJoinBeforeBob,
      ['channelJoinRequestsVersion'],
      'approveChannelJoin requester'
    );
    await waitForSignalVersions(
      alice.conn,
      approveJoinBeforeAlice,
      ['channelJoinRequestsVersion'],
      'approveChannelJoin admin'
    );
  });

  it('limits thread reads to intended participants only', async () => {
    const bobPlaintext = await decryptLatestMessage(bob, sentMessage);

    expect(bobPlaintext).toBe('hello from alice security test');
    await expect(listThreadMessagesFor(alice, thread.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ threadId: thread.id })])
    );
    await expect(listThreadMessagesFor(bob, thread.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ threadId: thread.id })])
    );
    await expect(listThreadMessagesFor(mallory, thread.id)).resolves.toEqual([]);
    await expect(
      mallory.conn.procedures.listThreadSecretEnvelopes({
        agentDbId: mallory.actor.id,
        threadId: thread.id,
        membershipVersion: undefined,
        senderAgentDbId: undefined,
        recipientAgentDbId: undefined,
        secretVersion: undefined,
        afterId: undefined,
        limit: undefined,
      })
    ).resolves.toHaveLength(0);
    expect((await listVisibleThreads(mallory.conn)).some(candidate => candidate.id === thread.id)).toBe(false);
  });

  it('rejects senderMessageId replay for a valid sender', async () => {
    const duplicate = await prepareEncryptedMessage({
      threadId: thread.id,
      senderActorId: alice.actor.id,
      senderPublicIdentity: alice.actor.publicIdentity,
      senderMessageId: sentMessage.senderMessageId,
      payload: {
        contentType: 'text/plain',
        body: 'duplicate sender message id',
      },
      keyPair: alice.keyPair,
      recipients: [actorPublicKeysFromClient(alice), actorPublicKeysFromClient(bob)],
      existingSecret: sentSenderSecret,
      latestKnownSecretVersion: sentSenderSecret.secretVersion,
      rotateSecret: false,
      replyToMessageId: null,
    });

    await expect(
      Promise.resolve(
        alice.conn.reducers.sendEncryptedMessage({
          agentDbId: alice.actor.id,
          threadId: thread.id,
          secretVersion: duplicate.secretVersion,
          signingKeyVersion: duplicate.signingKeyVersion,
          senderMessageId: sentMessage.senderMessageId,
          ciphertext: fromHex(duplicate.ciphertext),
          iv: fromHex(duplicate.iv),
          cipherAlgorithm: toCipherAlgorithm(duplicate.cipherAlgorithm),
          signature: fromHex(duplicate.signature),
          replyToMessageId: undefined,
          attachedSecretEnvelopes: toReducerEnvelopes(duplicate.attachedSecretEnvelopes),
        })
      )
    ).rejects.toThrow(/senderMessageId has already been used/i);
  });

  it('rejects a valid actor message when the signature is corrupted', async () => {
    const sender = (await listVisibleActors(bob.conn)).find(
      actor => actor.id === sentMessage.senderAgentDbId
    );
    if (!sender) {
      throw new Error('Sender actor is not visible to Bob');
    }
    const envelopes = await bob.conn.procedures.listThreadSecretEnvelopes({
      agentDbId: bob.actor.id,
      threadId: sentMessage.threadId,
      membershipVersion: undefined,
      senderAgentDbId: sentMessage.senderAgentDbId,
      recipientAgentDbId: bob.actor.id,
      secretVersion: sentMessage.secretVersion,
      afterId: undefined,
      limit: undefined,
    });
    const envelope = envelopes.find(row => row.recipientAgentDbId === bob.actor.id);
    if (!envelope) {
      throw new Error('Bob envelope missing');
    }

    const senderEncryptionPublicKey = await findVersionedKey(
      bob.conn,
      sender,
      'encryption',
      envelope.senderEncryptionKeyVersion
    );
    const messageSigningPublicKey = await findVersionedKey(
      bob.conn,
      sender,
      'signing',
      sentMessage.signingKeyVersion
    );
    const envelopeSigningPublicKey = await findVersionedKey(
      bob.conn,
      sender,
      'signing',
      envelope.signingKeyVersion
    );
    if (!senderEncryptionPublicKey || !messageSigningPublicKey || !envelopeSigningPublicKey) {
      throw new Error('Sender public keys missing');
    }

    await expect(
      decryptMessage({
        recipientKeyPair: bob.keyPair,
        recipientPublicIdentity: bob.actor.publicIdentity,
        message: {
          threadId: sentMessage.threadId,
          senderActorId: sender.id,
          senderPublicIdentity: sender.publicIdentity,
          senderMessageId: sentMessage.senderMessageId,
          secretVersion: sentMessage.secretVersion,
          signingKeyVersion: sentMessage.signingKeyVersion,
          ciphertext: toHex(sentMessage.ciphertext),
          iv: toHex(sentMessage.iv),
          cipherAlgorithm: cipherAlgorithmLabel(sentMessage.cipherAlgorithm),
          signature: flipFirstHexByte(toHex(sentMessage.signature)),
          replyToMessageId: sentMessage.replyToMessageId ?? undefined,
        },
        envelope: {
          id: envelope.id,
          threadId: envelope.threadId,
          secretVersion: envelope.secretVersion,
          senderActorId: envelope.senderAgentDbId,
          senderPublicIdentity: sender.publicIdentity,
          recipientActorId: envelope.recipientAgentDbId,
          recipientPublicIdentity: bob.actor.publicIdentity,
          recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
          senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
          signingKeyVersion: envelope.signingKeyVersion,
          wrappedSecretCiphertext: toHex(envelope.wrappedSecretCiphertext),
          wrappedSecretIv: toHex(envelope.wrappedSecretIv),
          wrapAlgorithm: wrapAlgorithmLabel(envelope.wrapAlgorithm),
          signature: toHex(envelope.signature),
        },
        senderEncryptionPublicKey,
        messageSigningPublicKey,
        envelopeSigningPublicKey,
      })
    ).rejects.toThrow();
  });

  it('rejects repeated direct thread creation for the same actor pair', async () => {
    await expect(
      Promise.resolve(
        alice.conn.reducers.createThread({
          agentDbId: alice.actor.id,
          kind: { tag: 'Direct' },
          otherAgentPublicIdentity: bob.actor.publicIdentity,
          participantPublicIdentities: undefined,
          title: `security-duplicate-${RUN_SUFFIX}`,
        })
      )
    ).rejects.toThrow(/already exists/i);
  });

  it('blocks foreign-actor mutation attempts even when the foreign actor is visible', async () => {
    await expect(
      Promise.resolve(
        alice.conn.reducers.updateThreadReadState({
          agentDbId: bobActorFromAliceView.id,
          threadId: thread.id,
          lastReadMessageId: sentMessage.id,
          archived: undefined,
        })
      )
    ).rejects.toThrow(/not owned/i);

    await expect(
      Promise.resolve(
        alice.conn.reducers.sendEncryptedMessage({
          agentDbId: bobActorFromAliceView.id,
          threadId: thread.id,
          secretVersion: 1,
          signingKeyVersion: 1,
          senderMessageId: 901n,
          ciphertext: fromHex('deadbeef'),
          iv: fromHex('deadbeef'),
          cipherAlgorithm: { tag: 'AesGcm256V1' },
          signature: fromHex('deadbeef'),
          replyToMessageId: undefined,
          attachedSecretEnvelopes: [],
        })
      )
    ).rejects.toThrow(/not owned/i);
  });

  it('blocks removed participants from reading or sending', async () => {
    await Promise.resolve(
      alice.conn.reducers.createThread({
        agentDbId: alice.actor.id,
        kind: { tag: 'Group' },
        otherAgentPublicIdentity: undefined,
        participantPublicIdentities: [bob.actor.publicIdentity],
        title: `removal-${RUN_SUFFIX}`,
      })
    );
    await waitFor(
      async () =>
        (await listVisibleThreads(bob.conn)).some(
          candidate => candidate.kind.tag === 'Group' && candidate.title === `removal-${RUN_SUFFIX}`
        ),
      'removable group thread visibility'
    );
    const removableThread = (await listVisibleThreads(bob.conn)).find(
      candidate => candidate.kind.tag === 'Group' && candidate.title === `removal-${RUN_SUFFIX}`
    );
    if (!removableThread) {
      throw new Error('Removable group thread was not found');
    }

    await Promise.resolve(
      bob.conn.reducers.removeThreadParticipant({
        agentDbId: bob.actor.id,
        threadId: removableThread.id,
        targetAgentDbId: bob.actor.id,
      })
    );

    await waitFor(
      async () =>
        !(await listVisibleThreads(bob.conn)).some(candidate => candidate.id === removableThread.id),
      'removed participant thread disappearance'
    );

    await expect(listThreadMessagesFor(bob, removableThread.id)).resolves.toEqual([]);
    await expect(
      Promise.resolve(
        bob.conn.reducers.sendEncryptedMessage({
          agentDbId: bob.actor.id,
          threadId: removableThread.id,
          secretVersion: 1,
          signingKeyVersion: bob.actor.currentKeyBundleVersion,
          senderMessageId: 902n,
          ciphertext: fromHex('deadbeef'),
          iv: fromHex('deadbeef'),
          cipherAlgorithm: { tag: 'AesGcm256V1' },
          signature: fromHex('deadbeef'),
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
      encryptionKeyVersion: alice.actor.currentKeyBundleVersion,
      encryptionPublicKey: JSON.parse(alice.keyPair.encryption.publicKey) as unknown,
      signingKeyVersion: alice.actor.currentKeyBundleVersion,
      signingPublicKey: JSON.parse(alice.keyPair.signing.publicKey) as unknown,
    });
  });

  it('supports channel send/read flow and bounds read state to existing messages', async () => {
    const channelSlug = `public-flow-${RUN_SUFFIX}`;
    await Promise.resolve(
      alice.conn.reducers.createChannel({
        agentDbId: alice.actor.id,
        slug: channelSlug,
        title: 'Security public flow',
        description: undefined,
        accessMode: { tag: 'Public' },
        discoverable: false,
        defaultPermission: { tag: 'ReadWrite' },
      })
    );

    await waitFor(
      async () => Boolean(await alice.conn.procedures.lookupPublicChannelBySlug({ slug: channelSlug })),
      'public channel lookup'
    );
    const channel: Channel | undefined = await alice.conn.procedures.lookupPublicChannelBySlug({
      slug: channelSlug,
    });
    if (!channel) {
      throw new Error('Public channel was not created');
    }
    const createdChannel = channel;

    const prepared = await prepareChannelMessage({
      channelId: createdChannel.id,
      senderPublicIdentity: alice.actor.publicIdentity,
      senderMessageId: 401n,
      payload: {
        contentType: 'text/plain',
        body: 'signed channel hello',
      },
      keyPair: alice.keyPair,
    });
    await Promise.resolve(
      alice.conn.reducers.sendChannelMessage({
        agentDbId: alice.actor.id,
        channelId: createdChannel.id,
        senderMessageId: 401n,
        senderSigningKeyVersion: prepared.senderSigningKeyVersion,
        plaintext: prepared.plaintext,
        signature: fromHex(prepared.signature),
        replyToMessageId: undefined,
      })
    );

    let messages: ChannelMessage[] = [];
    await waitFor(async () => {
      messages = await alice.conn.procedures.listPublicChannelMessages({
        channelSlug,
        beforeMessageId: undefined,
        limit: 25,
      });
      return messages.length === 1;
    }, 'public channel message');
    expect(messages[0]).toMatchObject({
      channelId: createdChannel.id,
      senderAgentDbId: alice.actor.id,
      senderMessageId: 401n,
    });

    await expect(
      Promise.resolve(
        alice.conn.reducers.updateChannelMemberReadState({
          agentDbId: alice.actor.id,
          channelId: createdChannel.id,
          lastReadMessageId: messages[0]!.id,
        })
      )
    ).resolves.toBeUndefined();
    await expect(
      Promise.resolve(
        alice.conn.reducers.updateChannelMemberReadState({
          agentDbId: alice.actor.id,
          channelId: createdChannel.id,
          lastReadMessageId: messages[0]!.id + 1n,
        })
      )
    ).rejects.toThrow(/lastReadMessageId/i);
  });

  it('keeps anonymous public channel message reads scoped to Public channels', async () => {
    const privateSlug = `approval-only-${RUN_SUFFIX}`;
    await Promise.resolve(
      alice.conn.reducers.createChannel({
        agentDbId: alice.actor.id,
        slug: privateSlug,
        title: 'Security private flow',
        description: undefined,
        accessMode: { tag: 'ApprovalRequired' },
        discoverable: false,
        defaultPermission: { tag: 'ReadWrite' },
      })
    );

    const anonymous = await connectVisibleClient();
    try {
      await expect(
        anonymous.conn.procedures.lookupPublicChannelBySlug({ slug: privateSlug })
      ).resolves.toBeNull();
      await expect(
        anonymous.conn.procedures.listPublicChannelMessages({
          channelSlug: privateSlug,
          beforeMessageId: undefined,
          limit: 25,
        })
      ).resolves.toEqual([]);
    } finally {
      anonymous.conn.disconnect();
    }
  });

  it('allows only one hidden pre-approval message in pending direct-contact threads', async () => {
    const existingRequestIds = new Set(
      (await listVisibleContactRequests(mallory.conn)).map(request => request.id.toString())
    );
    const publishedAlice = (
      await mallory.conn.procedures.lookupPublishedAgentBySlug({
        slug: alice.actor.slug,
      })
    )[0];
    if (!publishedAlice) {
      throw new Error('Published Alice actor lookup failed');
    }
    const pendingThreadId = generateClientThreadId();
    const firstPrepared = await prepareEncryptedMessage({
      threadId: pendingThreadId,
      senderActorId: mallory.actor.id,
      senderPublicIdentity: mallory.actor.publicIdentity,
      senderMessageId: 201n,
      payload: {
        contentType: 'text/plain',
        body: 'hidden first contact',
      },
      keyPair: mallory.keyPair,
      recipients: [
        actorPublicKeysFromClient(mallory),
        toPublishedActorPublicKeys(publishedAlice),
      ],
      existingSecret: null,
      latestKnownSecretVersion: null,
      rotateSecret: false,
      replyToMessageId: null,
    });

    await Promise.resolve(
      mallory.conn.reducers.requestDirectContact({
        agentDbId: mallory.actor.id,
        otherAgentPublicIdentity: alice.actor.publicIdentity,
        threadId: pendingThreadId,
        title: `pending-hidden-${RUN_SUFFIX}`,
        secretVersion: firstPrepared.secretVersion,
        signingKeyVersion: firstPrepared.signingKeyVersion,
        senderMessageId: 201n,
        ciphertext: fromHex(firstPrepared.ciphertext),
        iv: fromHex(firstPrepared.iv),
        cipherAlgorithm: toCipherAlgorithm(firstPrepared.cipherAlgorithm),
        signature: fromHex(firstPrepared.signature),
        attachedSecretEnvelopes: toReducerEnvelopes(firstPrepared.attachedSecretEnvelopes),
      })
    );

    await waitFor(
      async () =>
        (await listVisibleContactRequests(mallory.conn)).some(
          request =>
            request.requesterAgentDbId === mallory.actor.id &&
            request.targetPublicIdentity === alice.actor.publicIdentity &&
            request.status.tag === 'Pending' &&
            !existingRequestIds.has(request.id.toString())
        ),
      'pending direct-contact request visibility'
    );

    const pendingRequest = (await listVisibleContactRequests(mallory.conn)).find(
      request =>
        request.requesterAgentDbId === mallory.actor.id &&
        request.targetPublicIdentity === alice.actor.publicIdentity &&
        request.status.tag === 'Pending' &&
        !existingRequestIds.has(request.id.toString())
    );
    if (!pendingRequest) {
      throw new Error('Pending direct-contact request did not become visible');
    }

    await waitFor(
      async () =>
        (await listVisibleContactRequests(alice.conn)).some(
          request =>
            request.id === pendingRequest.id &&
            request.targetAgentDbId === alice.actor.id &&
            request.status.tag === 'Pending'
        ),
      'incoming pending direct-contact request visibility'
    );
    await expect(
      alice.conn.procedures.readVisibleThread({
        agentDbId: alice.actor.id,
        threadId: pendingRequest.threadId,
      })
    ).resolves.toBeNull();
    await expect(listThreadMessagesFor(alice, pendingRequest.threadId)).resolves.toHaveLength(0);

    await waitFor(
      async () =>
        (await listVisibleContactRequests(mallory.conn)).some(
          request => request.id === pendingRequest.id && request.status.tag === 'Pending'
        ),
      'pending pre-approval contact request visibility'
    );

    const secondPrepared = await prepareEncryptedMessage({
      threadId: pendingRequest.threadId,
      senderActorId: mallory.actor.id,
      senderPublicIdentity: mallory.actor.publicIdentity,
      senderMessageId: 202n,
      payload: {
        contentType: 'text/plain',
        body: 'hidden second contact',
      },
      keyPair: mallory.keyPair,
      recipients: [
        actorPublicKeysFromClient(mallory),
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
          senderMessageId: 202n,
          ciphertext: fromHex(secondPrepared.ciphertext),
          iv: fromHex(secondPrepared.iv),
          cipherAlgorithm: toCipherAlgorithm(secondPrepared.cipherAlgorithm),
          signature: fromHex(secondPrepared.signature),
          replyToMessageId: undefined,
          attachedSecretEnvelopes: toReducerEnvelopes(secondPrepared.attachedSecretEnvelopes),
        })
      )
    ).rejects.toThrow(/one hidden pre-approval message/i);
  });

  it('blocks membership changes on pending direct-contact threads until requester approval or allowlist', async () => {
    const existingRequestIds = new Set(
      (await listVisibleContactRequests(bob.conn)).map(request => request.id.toString())
    );
    const publishedMallory = (
      await bob.conn.procedures.lookupPublishedAgentBySlug({
        slug: mallory.actor.slug,
      })
    )[0];
    if (!publishedMallory) {
      throw new Error('Published Mallory actor lookup failed');
    }
    const pendingThreadId = generateClientThreadId();
    const firstPrepared = await prepareEncryptedMessage({
      threadId: pendingThreadId,
      senderActorId: bob.actor.id,
      senderPublicIdentity: bob.actor.publicIdentity,
      senderMessageId: 301n,
      payload: {
        contentType: 'text/plain',
        body: 'pending membership contact',
      },
      keyPair: bob.keyPair,
      recipients: [
        actorPublicKeysFromClient(bob),
        toPublishedActorPublicKeys(publishedMallory),
      ],
      existingSecret: null,
      latestKnownSecretVersion: null,
      rotateSecret: false,
      replyToMessageId: null,
    });

    await Promise.resolve(
      bob.conn.reducers.requestDirectContact({
        agentDbId: bob.actor.id,
        otherAgentPublicIdentity: mallory.actor.publicIdentity,
        threadId: pendingThreadId,
        title: `pending-membership-${RUN_SUFFIX}`,
        secretVersion: firstPrepared.secretVersion,
        signingKeyVersion: firstPrepared.signingKeyVersion,
        senderMessageId: 301n,
        ciphertext: fromHex(firstPrepared.ciphertext),
        iv: fromHex(firstPrepared.iv),
        cipherAlgorithm: toCipherAlgorithm(firstPrepared.cipherAlgorithm),
        signature: fromHex(firstPrepared.signature),
        attachedSecretEnvelopes: toReducerEnvelopes(firstPrepared.attachedSecretEnvelopes),
      })
    );

    await waitFor(
      async () =>
        (await listVisibleContactRequests(bob.conn)).some(
          request =>
            request.requesterAgentDbId === bob.actor.id &&
            request.targetPublicIdentity === mallory.actor.publicIdentity &&
            request.status.tag === 'Pending' &&
            !existingRequestIds.has(request.id.toString())
        ),
      'pending direct-contact membership request visibility'
    );

    const pendingRequest = (await listVisibleContactRequests(bob.conn)).find(
      request =>
        request.requesterAgentDbId === bob.actor.id &&
        request.targetPublicIdentity === mallory.actor.publicIdentity &&
        request.status.tag === 'Pending' &&
        !existingRequestIds.has(request.id.toString())
    );
    if (!pendingRequest) {
      throw new Error('Pending direct-contact request was not found for membership test');
    }

    await expect(
      Promise.resolve(
        bob.conn.reducers.addThreadParticipant({
          agentDbId: bob.actor.id,
          threadId: pendingRequest.threadId,
          inviteePublicIdentity: alice.actor.publicIdentity,
        })
      )
    ).rejects.toThrow(/direct thread/i);
  });

  it('allows first-contact group creation without granting direct-thread approval or allowlist side effects', async () => {
    const allowlistCountBefore = (await listVisibleAllowlistEntries(bob.conn)).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;
    const existingThreadIds = new Set(
      (await listVisibleThreads(bob.conn)).map(candidate => candidate.id.toString())
    );

    await Promise.resolve(
      bob.conn.reducers.createThread({
        agentDbId: bob.actor.id,
        kind: { tag: 'Group' },
        otherAgentPublicIdentity: undefined,
        participantPublicIdentities: [mallory.actor.publicIdentity],
        title: `group-first-contact-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      async () => {
        const visibleParticipants = await listVisibleParticipants(bob.conn);
        return (await listVisibleThreads(bob.conn)).some(candidate => {
          if (candidate.kind.tag !== 'Group' || existingThreadIds.has(candidate.id.toString())) {
            return false;
          }
          const participantIds = new Set(
            visibleParticipants
              .filter(participant => participant.threadId === candidate.id && participant.active)
              .map(participant => participant.agentDbId)
          );
          return participantIds.has(bob.actor.id);
        });
      },
      'first-contact group creation visibility'
    );

    const allowlistCountAfter = (await listVisibleAllowlistEntries(bob.conn)).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;

    expect(allowlistCountAfter).toBe(allowlistCountBefore);
    await expect(
      Promise.resolve(
        bob.conn.reducers.createThread({
          agentDbId: bob.actor.id,
          kind: { tag: 'Direct' },
          otherAgentPublicIdentity: mallory.actor.publicIdentity,
          participantPublicIdentities: undefined,
          title: `direct-after-group-${RUN_SUFFIX}`,
        })
      )
    ).rejects.toThrow(/requires approval/i);
  });

  it('lets group admins add new actors without creating direct-thread approval', async () => {
    const allowlistCountBefore = (await listVisibleAllowlistEntries(alice.conn)).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;

    await Promise.resolve(
      alice.conn.reducers.createThread({
        agentDbId: alice.actor.id,
        kind: { tag: 'Group' },
        otherAgentPublicIdentity: undefined,
        participantPublicIdentities: [bob.actor.publicIdentity],
        title: `group-admin-${RUN_SUFFIX}`,
      })
    );

    await waitFor(
      async () => {
        const visibleParticipants = await listVisibleParticipants(alice.conn);
        return (await listVisibleThreads(alice.conn)).some(candidate => {
          if (candidate.kind.tag !== 'Group' || candidate.title !== `group-admin-${RUN_SUFFIX}`) {
            return false;
          }
          const participantIds = new Set(
            visibleParticipants
              .filter(participant => participant.threadId === candidate.id && participant.active)
              .map(participant => participant.agentDbId)
          );
          return participantIds.has(alice.actor.id) && participantIds.has(bob.actor.id);
        });
      },
      'admin-managed group creation visibility'
    );

    const visibleParticipants = await listVisibleParticipants(alice.conn);
    const adminGroup = (await listVisibleThreads(alice.conn)).find(candidate => {
      if (candidate.kind.tag !== 'Group' || candidate.title !== `group-admin-${RUN_SUFFIX}`) {
        return false;
      }
      const participantIds = new Set(
        visibleParticipants
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
        inviteePublicIdentity: mallory.actor.publicIdentity,
      })
    );

    await waitFor(
      async () =>
        (await listVisibleThreadInvites(alice.conn)).some(
          invite =>
            invite.threadId === adminGroup.id &&
            invite.inviteeAgentDbId === mallory.actor.id &&
            invite.status.tag === 'Pending'
        ),
      'group participant invite visibility'
    );

    const allowlistCountAfter = (await listVisibleAllowlistEntries(alice.conn)).filter(entry => {
      return entry.agentPublicIdentity === mallory.actor.publicIdentity;
    }).length;

    expect(allowlistCountAfter).toBe(allowlistCountBefore);
    await expect(
      Promise.resolve(
        bob.conn.reducers.createThread({
          agentDbId: bob.actor.id,
          kind: { tag: 'Direct' },
          otherAgentPublicIdentity: mallory.actor.publicIdentity,
          participantPublicIdentities: undefined,
          title: `direct-after-admin-add-${RUN_SUFFIX}`,
        })
      )
    ).rejects.toThrow(/requires approval/i);
  });

  it('allows rotateAgentKeys with account ownership and no device approval argument', async () => {
    const rotated = await generateAgentKeyPair({
      encryptionKeyVersion: alice.actor.currentKeyBundleVersion + 1,
      signingKeyVersion: alice.actor.currentKeyBundleVersion + 1,
    });

    await expect(
      Promise.resolve(
        alice.conn.reducers.rotateAgentKeys({
          agentDbId: alice.actor.id,
          encryptionPublicKey: rotated.encryption.publicKey,
          keyBundleVersion: rotated.encryption.keyVersion,
          encryptionAlgorithm: toEncryptionAlgorithm(rotated.encryption.algorithm),
          signingPublicKey: rotated.signing.publicKey,
          signingAlgorithm: toSigningAlgorithm(rotated.signing.algorithm),
        })
      )
    ).resolves.toBeUndefined();

    await waitFor(
      async () =>
        (await listOwnedAgents(alice.conn)).some(
          actor =>
            actor.id === alice.actor.id &&
            actor.currentKeyBundleVersion === rotated.encryption.keyVersion
        ),
      'rotated alice key bundle visibility'
    );
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
