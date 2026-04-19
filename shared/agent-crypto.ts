import { normalizeEmail as normalizeSharedEmail, normalizeInboxSlug } from './inbox-slug';
import {
  normalizeEncryptedMessagePayload,
  type EncryptedMessagePayload,
  type JsonLike,
} from './message-format';
import { validateSerializedMessagePlaintext } from './message-limits';

const ENCRYPTION_ALGORITHM = 'ecdh-p256-v1';
const SIGNING_ALGORITHM = 'ecdsa-p256-sha256-v1';
const MESSAGE_CIPHER_ALGORITHM = 'aes-gcm-256-v1';
const ENVELOPE_CIPHER_ALGORITHM = 'aes-gcm-256-wrap-v1';

const senderSecretCache = new Map<string, string>();

export type StoredKeyPair = {
  publicKey: string;
  privateKey: string;
  keyVersion: string;
  algorithm: string;
};

export type AgentKeyPair = {
  encryption: StoredKeyPair;
  signing: StoredKeyPair;
};

export type ActorIdentity = {
  normalizedEmail: string;
  slug: string;
  inboxIdentifier?: string;
};

export type ActorPublicKeys = {
  actorId?: bigint;
  normalizedEmail: string;
  slug: string;
  inboxIdentifier?: string;
  isDefault?: boolean;
  publicIdentity: string;
  displayName?: string | null;
  encryptionPublicKey: string;
  encryptionKeyVersion: string;
  signingPublicKey: string;
  signingKeyVersion: string;
};

export type SecretEnvelopePayload = {
  recipientPublicIdentity: string;
  recipientEncryptionKeyVersion: string;
  senderEncryptionKeyVersion: string;
  signingKeyVersion: string;
  wrappedSecretCiphertext: string;
  wrappedSecretIv: string;
  wrapAlgorithm: string;
  signature: string;
};

export type SenderSecretState = {
  secretVersion: string;
  secretHex: string;
};

export type PreparedEncryptedMessage = {
  secretVersion: string;
  signingKeyVersion: string;
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
  secretVersion: string;
  senderActorId: bigint;
  senderPublicIdentity: string;
  recipientActorId: bigint;
};

export type InboundEncryptedMessage = {
  threadId: bigint;
  senderActorId: bigint;
  senderPublicIdentity: string;
  senderSeq: bigint;
  secretVersion: string;
  signingKeyVersion: string;
  ciphertext: string;
  iv: string;
  cipherAlgorithm: string;
  signature: string;
  replyToMessageId?: bigint;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex encoding');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function secretCacheKey(threadId: bigint, senderPublicIdentity: string, secretVersion: string): string {
  return `${threadId.toString()}:${senderPublicIdentity}:${secretVersion}`;
}

function normalizeVersion(version: string | undefined, prefix: string): string {
  if (!version) return `${prefix}1`;
  const suffix = version.startsWith(prefix) ? version.slice(prefix.length) : '';
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return `${prefix}1`;
  return `${prefix}${parsed}`;
}

export function nextKeyVersion(version: string | undefined, prefix: string): string {
  if (!version) return `${prefix}1`;
  const suffix = version.startsWith(prefix) ? version.slice(prefix.length) : '';
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return `${prefix}1`;
  return `${prefix}${parsed + 1}`;
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

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(bytes));
  return toHex(new Uint8Array(digest));
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return stableStringify(jwk);
}

async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return stableStringify(jwk);
}

function parseSerializedJwk(serialized: string): JsonWebKey {
  const parsed = JSON.parse(serialized) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Invalid serialized key');
  }
  return parsed as JsonWebKey;
}

async function importEncryptionPublicKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function importEncryptionPrivateKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

async function importSigningPublicKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

async function importSigningPrivateKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
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

export async function generateAgentKeyPair(options?: {
  encryptionKeyVersion?: string;
  signingKeyVersion?: string;
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
      keyVersion: normalizeVersion(options?.encryptionKeyVersion, 'enc-v'),
      algorithm: ENCRYPTION_ALGORITHM,
    },
    signing: {
      publicKey: await exportPublicKey(signingKeyPair.publicKey),
      privateKey: await exportPrivateKey(signingKeyPair.privateKey),
      keyVersion: normalizeVersion(options?.signingKeyVersion, 'sig-v'),
      algorithm: SIGNING_ALGORITHM,
    },
  };
}

export async function toActorPublicKeys(
  identity: ActorIdentity,
  keyPair: AgentKeyPair,
  options?: {
    actorId?: bigint;
    inboxIdentifier?: string;
    isDefault?: boolean;
    displayName?: string | null;
  }
): Promise<ActorPublicKeys> {
  return {
    actorId: options?.actorId,
    normalizedEmail: normalizeEmail(identity.normalizedEmail),
    slug: normalizeSlug(identity.slug),
    inboxIdentifier: options?.inboxIdentifier?.trim(),
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
  secretVersion: string,
  secretHex: string
): void {
  senderSecretCache.set(secretCacheKey(threadId, senderPublicIdentity, secretVersion), secretHex);
}

export function getCachedSenderSecret(
  threadId: bigint,
  senderPublicIdentity: string,
  secretVersion: string
): SenderSecretState | null {
  const secretHex = senderSecretCache.get(secretCacheKey(threadId, senderPublicIdentity, secretVersion));
  if (!secretHex) return null;
  return { secretVersion, secretHex };
}

async function buildEnvelopeSignaturePayload(
  threadId: bigint,
  secretVersion: string,
  senderPublicIdentity: string,
  recipientPublicIdentity: string,
  senderEncryptionKeyVersion: string,
  recipientEncryptionKeyVersion: string,
  signingKeyVersion: string,
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
  return {
    threadId: message.threadId.toString(),
    senderPublicIdentity: message.senderPublicIdentity,
    senderSeq: message.senderSeq.toString(),
    secretVersion: message.secretVersion,
    signingKeyVersion: message.signingKeyVersion,
    cipherAlgorithm: message.cipherAlgorithm,
    iv: message.iv,
    replyToMessageId:
      message.replyToMessageId === undefined ? null : message.replyToMessageId.toString(),
    ciphertextHash: await sha256Hex(message.ciphertext),
  };
}

async function buildRotationEnvelopes(params: {
  threadId: bigint;
  secretVersion: string;
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
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedSecret = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv) },
      envelopeKey,
      toBufferSource(fromHex(params.senderSecretHex))
    );
    const wrappedSecretCiphertext = toHex(new Uint8Array(wrappedSecret));
    const wrappedSecretIv = toHex(iv);
    const wrapAlgorithm = ENVELOPE_CIPHER_ALGORITHM;
    const signature = await signCanonicalPayload(
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

    envelopes.push({
      recipientPublicIdentity: recipient.publicIdentity,
      recipientEncryptionKeyVersion: recipient.encryptionKeyVersion,
      senderEncryptionKeyVersion: params.keyPair.encryption.keyVersion,
      signingKeyVersion: params.keyPair.signing.keyVersion,
      wrappedSecretCiphertext,
      wrappedSecretIv,
      wrapAlgorithm,
      signature,
    });
  }

  return envelopes;
}

export async function prepareEncryptedMessage(params: {
  threadId: bigint;
  senderActorId: bigint;
  senderPublicIdentity: string;
  senderSeq: bigint;
  payload: EncryptedMessagePayload;
  keyPair: AgentKeyPair;
  recipients: ActorPublicKeys[];
  existingSecret: SenderSecretState | null;
  latestKnownSecretVersion?: string | null;
  rotateSecret: boolean;
  replyToMessageId?: bigint | null;
}): Promise<PreparedEncryptedMessage> {
  const normalizedPayload = normalizeEncryptedMessagePayload(params.payload);
  const serializedPlaintext = validateSerializedMessagePlaintext(
    canonicalJsonStringify(normalizedPayload)
  );

  const baseSecretVersion =
    params.existingSecret?.secretVersion ?? params.latestKnownSecretVersion ?? undefined;
  const nextSecretVersion =
    !params.existingSecret || params.rotateSecret
      ? nextKeyVersion(baseSecretVersion, 'secret-v')
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
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    messageKey,
    toBufferSource(utf8(serializedPlaintext))
  );
  const ciphertext = toHex(new Uint8Array(ciphertextBuffer));
  const ivHex = toHex(iv);

  const message: InboundEncryptedMessage = {
    threadId: params.threadId,
    senderActorId: params.senderActorId,
    senderPublicIdentity: params.senderPublicIdentity,
    senderSeq: params.senderSeq,
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
