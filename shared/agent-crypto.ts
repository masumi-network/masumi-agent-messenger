import {
  fromHex,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  sha256Hex,
  toBufferSource,
  toHex,
  utf8,
} from './crypto-utils';
import { normalizeEmail as normalizeSharedEmail, normalizeInboxSlug } from './inbox-slug';
import {
  normalizeEncryptedMessagePayload,
  type EncryptedMessagePayload,
  type JsonLike,
} from './message-format';
import {
  ensureCiphertextBytes,
  ensureMessageIvBytes,
  ensureSignatureBytes,
  ensureWrappedSecretCiphertextBytes,
  ensureWrappedSecretIvBytes,
  validateSerializedMessagePlaintext,
} from './message-limits';

const ENCRYPTION_ALGORITHM = 'ecdh-p256-v1';
const SIGNING_ALGORITHM = 'ecdsa-p256-sha256-v1';
const MESSAGE_CIPHER_ALGORITHM = 'aes-gcm-256-v1';
const ENVELOPE_CIPHER_ALGORITHM = 'aes-gcm-256-wrap-v1';

const senderSecretCache = new Map<string, string>();

type SpacetimeEnumValue = {
  tag: string;
};

export function normalizeMessageCipherAlgorithm(value: string | SpacetimeEnumValue): string {
  const tag = typeof value === 'string' ? value : value.tag;
  if (tag === 'AesGcm256V1') return MESSAGE_CIPHER_ALGORITHM;
  return tag;
}

export function normalizeEnvelopeWrapAlgorithm(value: string | SpacetimeEnumValue): string {
  const tag = typeof value === 'string' ? value : value.tag;
  if (tag === 'EcdhP256AesGcm256V1') return ENVELOPE_CIPHER_ALGORITHM;
  return tag;
}

export type StoredKeyPair = {
  publicKey: string;
  privateKey: string;
  keyVersion: number;
  algorithm: string;
};

export type AgentKeyPair = {
  encryption: StoredKeyPair;
  signing: StoredKeyPair;
};

export type ActorIdentity = {
  email: string;
  slug: string;
  accountIdentifier?: string;
};

export type ActorPublicKeys = {
  actorId?: bigint;
  email: string;
  slug: string;
  accountIdentifier?: string;
  isDefault?: boolean;
  publicIdentity: string;
  displayName?: string | null;
  encryptionPublicKey: string;
  encryptionKeyVersion: number;
  signingPublicKey: string;
  signingKeyVersion: number;
};

export type SecretEnvelopePayload = {
  recipientPublicIdentity: string;
  recipientEncryptionKeyVersion: number;
  senderEncryptionKeyVersion: number;
  signingKeyVersion: number;
  wrappedSecretCiphertext: string;
  wrappedSecretIv: string;
  wrapAlgorithm: string;
  signature: string;
};

export type SenderSecretState = {
  secretVersion: number;
  secretHex: string;
};

export type PreparedEncryptedMessage = {
  secretVersion: number;
  signingKeyVersion: number;
  ciphertext: string;
  iv: string;
  cipherAlgorithm: string;
  signature: string;
  attachedSecretEnvelopes: SecretEnvelopePayload[];
  didRotateSecret: boolean;
  senderSecret: SenderSecretState;
};

export type InboundSecretEnvelope = SecretEnvelopePayload & {
  id: bigint;
  threadId: bigint;
  secretVersion: number;
  senderActorId: bigint;
  senderPublicIdentity: string;
  recipientActorId: bigint;
};

export type InboundEncryptedMessage = {
  threadId: bigint;
  senderActorId: bigint;
  senderPublicIdentity: string;
  // Random per-sender opaque id used for replay protection.
  senderMessageId: bigint;
  secretVersion: number;
  signingKeyVersion: number;
  ciphertext: string;
  iv: string;
  cipherAlgorithm: string;
  signature: string;
  replyToMessageId?: bigint;
};

function secretCacheKey(threadId: bigint, senderPublicIdentity: string, secretVersion: number): string {
  return `${threadId.toString()}:${senderPublicIdentity}:${secretVersion}`;
}

export function normalizeKeyVersion(version: number | string | null | undefined): number {
  if (typeof version === 'string') {
    const match = version.trim().match(/(\d+)$/u);
    const parsed = match ? Number.parseInt(match[1], 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
    return 1;
  }

  if (version === undefined || version === null || !Number.isFinite(version) || version < 1) {
    return 1;
  }
  return Math.floor(version);
}

function normalizeVersion(version: number | undefined): number {
  return normalizeKeyVersion(version);
}

export function normalizeAgentKeyPairVersions(keyPair: AgentKeyPair): AgentKeyPair {
  const keyBundleVersion = Math.max(
    normalizeKeyVersion(keyPair.encryption.keyVersion),
    normalizeKeyVersion(keyPair.signing.keyVersion)
  );

  if (
    keyPair.encryption.keyVersion === keyBundleVersion &&
    keyPair.signing.keyVersion === keyBundleVersion
  ) {
    return keyPair;
  }

  return {
    encryption: {
      ...keyPair.encryption,
      keyVersion: keyBundleVersion,
    },
    signing: {
      ...keyPair.signing,
      keyVersion: keyBundleVersion,
    },
  };
}

export function nextKeyVersion(version: number | undefined): number {
  return normalizeVersion(version) + 1;
}

// Returns 1 when no prior version has been seen, otherwise `latest + 1`.
// `nextKeyVersion(undefined)` returns 2 by spec ("next of nothing" is undefined);
// secret rotation needs to start at 1 on the first publish, so use this instead.
export function firstOrNextSecretVersion(latestSeen: number | null | undefined): number {
  if (latestSeen === undefined || latestSeen === null || latestSeen <= 0) {
    return 1;
  }
  return Math.floor(latestSeen) + 1;
}

function normalizeEmail(value: string): string {
  return normalizeSharedEmail(value);
}

function normalizeSlug(value: string): string {
  return normalizeInboxSlug(value);
}

export function actorPublicIdentity(identity: ActorIdentity): string {
  return normalizeSlug(identity.slug);
}

export function actorIdentityKey(identity: ActorIdentity): string {
  return actorPublicIdentity(identity);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): JsonLike {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value as JsonLike;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(item => stableJsonValue(item));
  }

  if (isRecord(value)) {
    const out: { [key: string]: JsonLike } = {};
    for (const key of Object.keys(value).sort()) {
      const recordValue = value[key];
      // Match JSON.stringify semantics: omit undefined object fields.
      if (recordValue === undefined) {
        continue;
      }
      out[key] = stableJsonValue(recordValue);
    }
    return out;
  }

  throw new Error('Unsupported value in canonical JSON payload');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return stableStringify(jwk);
}

async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return stableStringify(jwk);
}

async function deriveEnvelopeKey(
  ownPrivateKey: string,
  peerPublicKey: string,
  context: string
): Promise<CryptoKey> {
  const privateKey = await importEncryptionPrivateKey(ownPrivateKey);
  const publicKey = await importEncryptionPublicKey(peerPublicKey);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  const keyMaterial = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBufferSource(utf8(`masumi-envelope:${context}`)),
      info: toBufferSource(utf8(ENVELOPE_CIPHER_ALGORITHM)),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function isLikelyWebCryptoOperationFailure(error: unknown): error is DOMException {
  return (
    error instanceof DOMException &&
    (error.name === 'OperationError' || error.name === 'InvalidAccessError')
  );
}

function rethrowWithDecryptHint(error: unknown, step: string): never {
  if (isLikelyWebCryptoOperationFailure(error)) {
    throw new Error(
      `${step}: key or ciphertext mismatch (${error.name}). Browsers often report this as "The operation failed for an operation-specific reason". ` +
        'Typical causes: the secret envelope was wrapped for a different recipient encryption key, corrupted data, or reading as the wrong actor.'
    );
  }
  throw error instanceof Error ? error : new Error(String(error));
}

async function importSenderSecret(secretHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBufferSource(fromHex(secretHex)), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

async function signCanonicalPayload(
  privateSigningKey: string,
  payload: unknown
): Promise<string> {
  const key = await importSigningPrivateKey(privateSigningKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toBufferSource(utf8(stableStringify(payload)))
  );
  return toHex(new Uint8Array(signature));
}

async function verifyCanonicalPayload(
  publicSigningKey: string,
  payload: unknown,
  signatureHex: string
): Promise<boolean> {
  const key = await importSigningPublicKey(publicSigningKey);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toBufferSource(fromHex(signatureHex)),
    toBufferSource(utf8(stableStringify(payload)))
  );
}

function randomSecretHex(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomSenderMessageId(): bigint {
  // Server rejects `sender_message_id == 0` (see
  // `spacetimedb/src/helpers/messages.rs`). Reroll if `getRandomValues` produces 0
  // so we never round-trip a value the reducer will refuse.
  for (;;) {
    const buf = new BigUint64Array(1);
    crypto.getRandomValues(buf);
    if (buf[0] !== 0n) {
      return buf[0];
    }
  }
}

export async function generateAgentKeyPair(options?: {
  encryptionKeyVersion?: number;
  signingKeyVersion?: number;
}): Promise<AgentKeyPair> {
  const encryptionKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const signingKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  return {
    encryption: {
      publicKey: await exportPublicKey(encryptionKeyPair.publicKey),
      privateKey: await exportPrivateKey(encryptionKeyPair.privateKey),
      keyVersion: normalizeVersion(options?.encryptionKeyVersion),
      algorithm: ENCRYPTION_ALGORITHM,
    },
    signing: {
      publicKey: await exportPublicKey(signingKeyPair.publicKey),
      privateKey: await exportPrivateKey(signingKeyPair.privateKey),
      keyVersion: normalizeVersion(options?.signingKeyVersion),
      algorithm: SIGNING_ALGORITHM,
    },
  };
}

export async function toActorPublicKeys(
  identity: ActorIdentity,
  keyPair: AgentKeyPair,
  options?: {
    actorId?: bigint;
    accountIdentifier?: string;
    isDefault?: boolean;
    displayName?: string | null;
  }
): Promise<ActorPublicKeys> {
  return {
    actorId: options?.actorId,
    email: normalizeEmail(identity.email),
    slug: normalizeSlug(identity.slug),
    accountIdentifier: options?.accountIdentifier?.trim(),
    isDefault: options?.isDefault,
    publicIdentity: actorPublicIdentity(identity),
    displayName: options?.displayName,
    encryptionPublicKey: keyPair.encryption.publicKey,
    encryptionKeyVersion: keyPair.encryption.keyVersion,
    signingPublicKey: keyPair.signing.publicKey,
    signingKeyVersion: keyPair.signing.keyVersion,
  };
}

export function cacheSenderSecret(
  threadId: bigint,
  senderPublicIdentity: string,
  secretVersion: number,
  secretHex: string
): void {
  senderSecretCache.set(secretCacheKey(threadId, senderPublicIdentity, secretVersion), secretHex);
}

export function getCachedSenderSecret(
  threadId: bigint,
  senderPublicIdentity: string,
  secretVersion: number
): SenderSecretState | null {
  const secretHex = senderSecretCache.get(secretCacheKey(threadId, senderPublicIdentity, secretVersion));
  if (!secretHex) return null;
  return { secretVersion, secretHex };
}

async function buildEnvelopeSignaturePayload(
  threadId: bigint,
  secretVersion: number,
  senderPublicIdentity: string,
  recipientPublicIdentity: string,
  senderEncryptionKeyVersion: number,
  recipientEncryptionKeyVersion: number,
  signingKeyVersion: number,
  wrapAlgorithm: string,
  wrappedSecretCiphertext: string,
  wrappedSecretIv: string
): Promise<JsonLike> {
  return {
    threadId: threadId.toString(),
    secretVersion,
    senderPublicIdentity,
    recipientPublicIdentity,
    senderEncryptionKeyVersion,
    recipientEncryptionKeyVersion,
    signingKeyVersion,
    wrapAlgorithm,
    wrappedSecretIv,
    wrappedSecretCiphertextHash: await sha256Hex(wrappedSecretCiphertext),
  };
}

async function buildMessageSignaturePayload(message: InboundEncryptedMessage): Promise<JsonLike> {
  const base: JsonLike = {
    threadId: message.threadId.toString(),
    senderPublicIdentity: message.senderPublicIdentity,
    senderMessageId: message.senderMessageId.toString(),
    secretVersion: message.secretVersion,
    signingKeyVersion: message.signingKeyVersion,
    cipherAlgorithm: message.cipherAlgorithm,
    iv: message.iv,
    replyToMessageId:
      message.replyToMessageId === undefined ? null : message.replyToMessageId.toString(),
    ciphertextHash: await sha256Hex(message.ciphertext),
  };
  return base;
}

async function buildRotationEnvelopes(params: {
  threadId: bigint;
  secretVersion: number;
  senderPublicIdentity: string;
  keyPair: AgentKeyPair;
  recipients: ActorPublicKeys[];
  senderSecretHex: string;
}): Promise<SecretEnvelopePayload[]> {
  const envelopes: SecretEnvelopePayload[] = [];

  for (const recipient of params.recipients) {
    const envelopeKey = await deriveEnvelopeKey(
      params.keyPair.encryption.privateKey,
      recipient.encryptionPublicKey,
      [
        params.threadId.toString(),
        params.secretVersion,
        params.senderPublicIdentity,
        recipient.publicIdentity,
        params.keyPair.encryption.keyVersion,
        recipient.encryptionKeyVersion,
      ].join(':')
    );
    const iv = ensureWrappedSecretIvBytes(crypto.getRandomValues(new Uint8Array(12)));
    const wrappedSecretBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv) },
      envelopeKey,
      toBufferSource(fromHex(params.senderSecretHex))
    );
    const wrappedSecretBytes = ensureWrappedSecretCiphertextBytes(
      new Uint8Array(wrappedSecretBuffer)
    );
    const wrappedSecretCiphertext = toHex(wrappedSecretBytes);
    const wrappedSecretIv = toHex(iv);
    const wrapAlgorithm = ENVELOPE_CIPHER_ALGORITHM;
    const signatureHex = await signCanonicalPayload(
      params.keyPair.signing.privateKey,
      await buildEnvelopeSignaturePayload(
        params.threadId,
        params.secretVersion,
        params.senderPublicIdentity,
        recipient.publicIdentity,
        params.keyPair.encryption.keyVersion,
        recipient.encryptionKeyVersion,
        params.keyPair.signing.keyVersion,
        wrapAlgorithm,
        wrappedSecretCiphertext,
        wrappedSecretIv
      )
    );
    ensureSignatureBytes(fromHex(signatureHex));

    envelopes.push({
      recipientPublicIdentity: recipient.publicIdentity,
      recipientEncryptionKeyVersion: recipient.encryptionKeyVersion,
      senderEncryptionKeyVersion: params.keyPair.encryption.keyVersion,
      signingKeyVersion: params.keyPair.signing.keyVersion,
      wrappedSecretCiphertext,
      wrappedSecretIv,
      wrapAlgorithm,
      signature: signatureHex,
    });
  }

  return envelopes;
}

export async function prepareEncryptedMessage(params: {
  threadId: bigint;
  senderActorId: bigint;
  senderPublicIdentity: string;
  senderMessageId: bigint;
  payload: EncryptedMessagePayload;
  keyPair: AgentKeyPair;
  recipients: ActorPublicKeys[];
  existingSecret: SenderSecretState | null;
  latestKnownSecretVersion?: number | null;
  rotateSecret: boolean;
  replyToMessageId?: bigint | null;
}): Promise<PreparedEncryptedMessage> {
  if (params.senderMessageId === 0n) {
    throw new Error('senderMessageId must not be 0');
  }
  const normalizedPayload = normalizeEncryptedMessagePayload(params.payload);
  const serializedPlaintext = validateSerializedMessagePlaintext(
    canonicalJsonStringify(normalizedPayload)
  );

  const latestSeenSecretVersion =
    params.existingSecret?.secretVersion ?? params.latestKnownSecretVersion ?? undefined;
  const nextSecretVersion =
    !params.existingSecret || params.rotateSecret
      ? firstOrNextSecretVersion(latestSeenSecretVersion)
      : params.existingSecret.secretVersion;

  let senderSecretHex = params.existingSecret?.secretHex ?? null;
  let attachedSecretEnvelopes: SecretEnvelopePayload[] = [];
  let didRotateSecret = false;

  if (!senderSecretHex || params.rotateSecret) {
    senderSecretHex = randomSecretHex();
    attachedSecretEnvelopes = await buildRotationEnvelopes({
      threadId: params.threadId,
      secretVersion: nextSecretVersion,
      senderPublicIdentity: params.senderPublicIdentity,
      keyPair: params.keyPair,
      recipients: params.recipients,
      senderSecretHex,
    });
    didRotateSecret = true;
  }

  const messageKey = await importSenderSecret(senderSecretHex);
  const iv = ensureMessageIvBytes(crypto.getRandomValues(new Uint8Array(12)));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    messageKey,
    toBufferSource(utf8(serializedPlaintext))
  );
  const ciphertextBytes = ensureCiphertextBytes(new Uint8Array(ciphertextBuffer));
  const ciphertext = toHex(ciphertextBytes);
  const ivHex = toHex(iv);

  const message: InboundEncryptedMessage = {
    threadId: params.threadId,
    senderActorId: params.senderActorId,
    senderPublicIdentity: params.senderPublicIdentity,
    senderMessageId: params.senderMessageId,
    secretVersion: nextSecretVersion,
    signingKeyVersion: params.keyPair.signing.keyVersion,
    ciphertext,
    iv: ivHex,
    cipherAlgorithm: MESSAGE_CIPHER_ALGORITHM,
    signature: '',
    replyToMessageId: params.replyToMessageId ?? undefined,
  };
  const signature = await signCanonicalPayload(
    params.keyPair.signing.privateKey,
    await buildMessageSignaturePayload(message)
  );
  ensureSignatureBytes(fromHex(signature));

  return {
    secretVersion: nextSecretVersion,
    signingKeyVersion: params.keyPair.signing.keyVersion,
    ciphertext,
    iv: ivHex,
    cipherAlgorithm: MESSAGE_CIPHER_ALGORITHM,
    signature,
    attachedSecretEnvelopes,
    didRotateSecret,
    senderSecret: {
      secretVersion: nextSecretVersion,
      secretHex: senderSecretHex,
    },
  };
}

export async function unwrapSecretEnvelope(params: {
  threadId: bigint;
  senderPublicIdentity: string;
  recipientPublicIdentity: string;
  recipientKeyPair: AgentKeyPair;
  envelope: InboundSecretEnvelope;
  senderEncryptionPublicKey: string;
  envelopeSigningPublicKey: string;
}): Promise<SenderSecretState> {
  const cached = getCachedSenderSecret(
    params.threadId,
    params.senderPublicIdentity,
    params.envelope.secretVersion
  );
  if (cached) return cached;
  if (params.envelope.threadId !== params.threadId) {
    throw new Error('Envelope thread id does not match');
  }
  if (params.envelope.senderPublicIdentity !== params.senderPublicIdentity) {
    throw new Error('Envelope sender does not match');
  }
  if (params.envelope.recipientPublicIdentity !== params.recipientPublicIdentity) {
    throw new Error('Envelope recipient does not match');
  }

  const envelopeVerified = await verifyCanonicalPayload(
    params.envelopeSigningPublicKey,
    await buildEnvelopeSignaturePayload(
      params.threadId,
      params.envelope.secretVersion,
      params.senderPublicIdentity,
      params.recipientPublicIdentity,
      params.envelope.senderEncryptionKeyVersion,
      params.envelope.recipientEncryptionKeyVersion,
      params.envelope.signingKeyVersion,
      params.envelope.wrapAlgorithm,
      params.envelope.wrappedSecretCiphertext,
      params.envelope.wrappedSecretIv
    ),
    params.envelope.signature
  );
  if (!envelopeVerified) {
    throw new Error('Envelope signature verification failed');
  }

  let unwrapKey: CryptoKey;
  try {
    unwrapKey = await deriveEnvelopeKey(
      params.recipientKeyPair.encryption.privateKey,
      params.senderEncryptionPublicKey,
      [
        params.threadId.toString(),
        params.envelope.secretVersion,
        params.senderPublicIdentity,
        params.recipientPublicIdentity,
        params.envelope.senderEncryptionKeyVersion,
        params.envelope.recipientEncryptionKeyVersion,
      ].join(':')
    );
  } catch (error) {
    rethrowWithDecryptHint(
      error,
      'Unwrapping sender secret (ECDH/HKDF): failed to derive envelope key'
    );
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(fromHex(params.envelope.wrappedSecretIv)) },
      unwrapKey,
      toBufferSource(fromHex(params.envelope.wrappedSecretCiphertext))
    );
  } catch (error) {
    rethrowWithDecryptHint(error, 'Unwrapping sender secret (AES-GCM)');
  }
  const secretHex = toHex(new Uint8Array(plaintext));
  cacheSenderSecret(
    params.threadId,
    params.senderPublicIdentity,
    params.envelope.secretVersion,
    secretHex
  );
  return {
    secretVersion: params.envelope.secretVersion,
    secretHex,
  };
}

export async function decryptMessage(params: {
  recipientKeyPair: AgentKeyPair;
  recipientPublicIdentity: string;
  message: InboundEncryptedMessage;
  envelope: InboundSecretEnvelope;
  senderEncryptionPublicKey: string;
  messageSigningPublicKey: string;
  envelopeSigningPublicKey: string;
}): Promise<string> {
  if (params.message.secretVersion !== params.envelope.secretVersion) {
    throw new Error('Message secretVersion does not match the envelope');
  }

  const verified = await verifyCanonicalPayload(
    params.messageSigningPublicKey,
    await buildMessageSignaturePayload(params.message),
    params.message.signature
  );
  if (!verified) {
    throw new Error('Message signature verification failed');
  }

  const senderSecret = await unwrapSecretEnvelope({
    threadId: params.message.threadId,
    senderPublicIdentity: params.message.senderPublicIdentity,
    recipientPublicIdentity: params.recipientPublicIdentity,
    recipientKeyPair: params.recipientKeyPair,
    envelope: params.envelope,
    senderEncryptionPublicKey: params.senderEncryptionPublicKey,
    envelopeSigningPublicKey: params.envelopeSigningPublicKey,
  });

  const messageKey = await importSenderSecret(senderSecret.secretHex);
  let messagePlain: ArrayBuffer;
  try {
    messagePlain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(fromHex(params.message.iv)) },
      messageKey,
      toBufferSource(fromHex(params.message.ciphertext))
    );
  } catch (error) {
    rethrowWithDecryptHint(error, 'Decrypting message body (AES-GCM)');
  }
  return new TextDecoder().decode(messagePlain);
}

export async function demoFingerprintSerializedPublicKey(serialized: string): Promise<string> {
  const digest = await sha256Hex(serialized);
  return `${digest.slice(0, 12)}...${digest.slice(-8)}`;
}

export function demoTruncateSharedSecretHex(secretHex: string): string {
  if (secretHex.length <= 16) return secretHex;
  return `${secretHex.slice(0, 10)}...${secretHex.slice(-6)}`;
}
