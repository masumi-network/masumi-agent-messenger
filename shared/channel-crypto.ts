import type { AgentKeyPair } from './agent-crypto';
import { canonicalJsonStringify } from './agent-crypto';
import {
  fromHex,
  importSigningPrivateKey,
  importSigningPublicKey,
  sha256Hex,
  toBufferSource,
  toHex,
  utf8,
} from './crypto-utils';
import {
  normalizeEncryptedMessagePayload,
  parseDecryptedMessagePlaintext,
  type EncryptedMessagePayload,
  type JsonLike,
  type ParsedDecryptedMessagePayload,
} from './message-format';
import { ensureSignatureBytes, validateSerializedMessagePlaintext } from './message-limits';

export type ChannelMessageSignatureInput = {
  channelId: bigint;
  senderPublicIdentity: string;
  // Random per-sender opaque id used for replay protection.
  senderMessageId: bigint;
  senderSigningKeyVersion: number;
  plaintext: string;
  replyToMessageId?: bigint | null;
};

export type PreparedChannelMessage = {
  senderSigningKeyVersion: number;
  plaintext: string;
  signature: string;
};

async function signCanonicalPayload(
  privateSigningKey: string,
  payload: unknown
): Promise<string> {
  const key = await importSigningPrivateKey(privateSigningKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toBufferSource(utf8(canonicalJsonStringify(payload)))
  );
  return toHex(ensureSignatureBytes(new Uint8Array(signature)));
}

async function verifyCanonicalPayload(params: {
  publicSigningKey: string;
  payload: unknown;
  signatureHex: string;
}): Promise<boolean> {
  const key = await importSigningPublicKey(params.publicSigningKey);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toBufferSource(fromHex(params.signatureHex)),
    toBufferSource(utf8(canonicalJsonStringify(params.payload)))
  );
}

export async function buildChannelMessageSignaturePayload(
  input: ChannelMessageSignatureInput
): Promise<JsonLike> {
  return {
    channelId: input.channelId.toString(),
    senderPublicIdentity: input.senderPublicIdentity,
    senderMessageId: input.senderMessageId.toString(),
    senderSigningKeyVersion: input.senderSigningKeyVersion,
    replyToMessageId:
      input.replyToMessageId === undefined || input.replyToMessageId === null
        ? null
        : input.replyToMessageId.toString(),
    plaintextHash: await sha256Hex(input.plaintext),
  };
}

export async function signChannelMessage(params: {
  privateSigningKey: string;
  input: ChannelMessageSignatureInput;
}): Promise<string> {
  return signCanonicalPayload(
    params.privateSigningKey,
    await buildChannelMessageSignaturePayload(params.input)
  );
}

export async function verifyChannelMessageSignature(params: {
  input: ChannelMessageSignatureInput;
  signature: string;
  senderSigningPublicKey: string;
}): Promise<boolean> {
  return verifyCanonicalPayload({
    publicSigningKey: params.senderSigningPublicKey,
    payload: await buildChannelMessageSignaturePayload(params.input),
    signatureHex: params.signature,
  });
}

export async function prepareChannelMessage(params: {
  channelId: bigint;
  senderPublicIdentity: string;
  senderMessageId: bigint;
  payload: EncryptedMessagePayload;
  keyPair: AgentKeyPair;
  replyToMessageId?: bigint | null;
}): Promise<PreparedChannelMessage> {
  if (params.senderMessageId === 0n) {
    throw new Error('senderMessageId must not be 0');
  }
  const normalizedPayload = normalizeEncryptedMessagePayload(params.payload);
  const plaintext = validateSerializedMessagePlaintext(
    canonicalJsonStringify(normalizedPayload)
  );
  const input: ChannelMessageSignatureInput = {
    channelId: params.channelId,
    senderPublicIdentity: params.senderPublicIdentity,
    senderMessageId: params.senderMessageId,
    senderSigningKeyVersion: params.keyPair.signing.keyVersion,
    plaintext,
    replyToMessageId: params.replyToMessageId ?? null,
  };

  return {
    senderSigningKeyVersion: params.keyPair.signing.keyVersion,
    plaintext,
    signature: await signChannelMessage({
      privateSigningKey: params.keyPair.signing.privateKey,
      input,
    }),
  };
}

export async function verifySignedChannelMessage(params: {
  input: ChannelMessageSignatureInput;
  signature: string;
  senderSigningPublicKey: string;
}): Promise<ParsedDecryptedMessagePayload> {
  const verified = await verifyChannelMessageSignature({
    input: params.input,
    signature: params.signature,
    senderSigningPublicKey: params.senderSigningPublicKey,
  });
  if (!verified) {
    throw new Error('Channel message signature verification failed');
  }

  return parseDecryptedMessagePlaintext(params.input.plaintext);
}
