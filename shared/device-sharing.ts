import { argon2id } from 'hash-wasm';
import {
  canonicalJsonStringify,
  type ActorIdentity,
  type AgentKeyPair,
  type StoredKeyPair,
} from './agent-crypto';
import {
  DEVICE_VERIFICATION_CODE_ARGON2_ITERATIONS,
  DEVICE_VERIFICATION_CODE_ARGON2_MEMORY_KIB,
  DEVICE_VERIFICATION_CODE_ARGON2_PARALLELISM,
  DEVICE_SHARE_REQUEST_EXPIRY_MS,
  DEVICE_VERIFICATION_CODE_CONTEXT,
} from './device-share-constants';

const DEVICE_ENCRYPTION_ALGORITHM = 'ecdh-p256-device-v1';
const DEVICE_SHARE_CIPHER_ALGORITHM = 'aes-gcm-256-device-share-v1';
const DEVICE_VERIFICATION_CODE_HASH_ALGORITHM = 'sha256-v1';
const DEVICE_VERIFICATION_CODE_BYTES = 6;
const DEVICE_VERIFICATION_CODE_SYMBOLS = 8;
const DEVICE_VERIFICATION_CODE_GROUP_SIZE = 4;

type MatrixEmojiEntry = {
  emoji: string;
  word: string;
};

const MATRIX_SAS_EMOJI_TABLE = [
  { emoji: '🐶', word: 'Dog' },
  { emoji: '🐱', word: 'Cat' },
  { emoji: '🦁', word: 'Lion' },
  { emoji: '🐎', word: 'Horse' },
  { emoji: '🦄', word: 'Unicorn' },
  { emoji: '🐷', word: 'Pig' },
  { emoji: '🐘', word: 'Elephant' },
  { emoji: '🐰', word: 'Rabbit' },
  { emoji: '🐼', word: 'Panda' },
  { emoji: '🐓', word: 'Rooster' },
  { emoji: '🐧', word: 'Penguin' },
  { emoji: '🐢', word: 'Turtle' },
  { emoji: '🐟', word: 'Fish' },
  { emoji: '🐙', word: 'Octopus' },
  { emoji: '🦋', word: 'Butterfly' },
  { emoji: '🌷', word: 'Flower' },
  { emoji: '🌳', word: 'Tree' },
  { emoji: '🌵', word: 'Cactus' },
  { emoji: '🍄', word: 'Mushroom' },
  { emoji: '🌏', word: 'Globe' },
  { emoji: '🌙', word: 'Moon' },
  { emoji: '☁️', word: 'Cloud' },
  { emoji: '🔥', word: 'Fire' },
  { emoji: '🍌', word: 'Banana' },
  { emoji: '🍎', word: 'Apple' },
  { emoji: '🍓', word: 'Strawberry' },
  { emoji: '🌽', word: 'Corn' },
  { emoji: '🍕', word: 'Pizza' },
  { emoji: '🎂', word: 'Cake' },
  { emoji: '❤️', word: 'Heart' },
  { emoji: '😀', word: 'Smiley' },
  { emoji: '🤖', word: 'Robot' },
  { emoji: '🎩', word: 'Hat' },
  { emoji: '👓', word: 'Glasses' },
  { emoji: '🔧', word: 'Spanner' },
  { emoji: '🎅', word: 'Santa' },
  { emoji: '👍', word: 'Thumbs Up' },
  { emoji: '☂️', word: 'Umbrella' },
  { emoji: '⌛', word: 'Hourglass' },
  { emoji: '⏰', word: 'Clock' },
  { emoji: '🎁', word: 'Gift' },
  { emoji: '💡', word: 'Light Bulb' },
  { emoji: '📕', word: 'Book' },
  { emoji: '✏️', word: 'Pencil' },
  { emoji: '📎', word: 'Paperclip' },
  { emoji: '✂️', word: 'Scissors' },
  { emoji: '🔒', word: 'Lock' },
  { emoji: '🔑', word: 'Key' },
  { emoji: '🔨', word: 'Hammer' },
  { emoji: '☎️', word: 'Telephone' },
  { emoji: '🏁', word: 'Flag' },
  { emoji: '🚂', word: 'Train' },
  { emoji: '🚲', word: 'Bicycle' },
  { emoji: '✈️', word: 'Aeroplane' },
  { emoji: '🚀', word: 'Rocket' },
  { emoji: '🏆', word: 'Trophy' },
  { emoji: '⚽', word: 'Ball' },
  { emoji: '🎸', word: 'Guitar' },
  { emoji: '🎺', word: 'Trumpet' },
  { emoji: '🔔', word: 'Bell' },
  { emoji: '⚓', word: 'Anchor' },
  { emoji: '🎧', word: 'Headphones' },
  { emoji: '📁', word: 'Folder' },
  { emoji: '📌', word: 'Pin' },
] as const satisfies readonly MatrixEmojiEntry[];

type MatrixEmojiSymbol = (typeof MATRIX_SAS_EMOJI_TABLE)[number]['emoji'];

const MATRIX_SAS_EMOJI_BY_SYMBOL = new Map(
  MATRIX_SAS_EMOJI_TABLE.map((entry, index) => [entry.emoji, { entry, index }] as const)
);

export type DeviceKeyPair = StoredKeyPair;

export type SharedActorKeyMaterial = {
  identity: ActorIdentity;
  current: AgentKeyPair | null;
  archived: AgentKeyPair[];
};

export type DeviceKeyShareSnapshot = {
  version: 1;
  normalizedEmail: string;
  createdAt: string;
  actors: SharedActorKeyMaterial[];
};

export type CreatedDeviceShareBundle = {
  sourceEncryptionPublicKey: string;
  sourceEncryptionKeyVersion: string;
  sourceEncryptionAlgorithm: string;
  bundleCiphertext: string;
  bundleIv: string;
  bundleAlgorithm: string;
};

export type ParsedDeviceVerificationCode = {
  canonicalCode: string;
  formattedCode: string;
  symbols: string[];
  words: string[];
  fingerprintHex: string;
};

export type DeviceVerificationCodeParams = {
  serializedPublicKey: string;
  clientCreatedAt: Date | number | string;
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

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return combined;
}

function toUint64Bytes(value: number): Uint8Array {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('clientCreatedAt must be a valid timestamp');
  }

  let remaining = BigInt(Math.trunc(value));
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  return bytes;
}

function readSixBitValue(bytes: Uint8Array, bitOffset: number): number {
  let value = 0;
  for (let bit = 0; bit < 6; bit += 1) {
    const absoluteBit = bitOffset + bit;
    const byteIndex = Math.floor(absoluteBit / 8);
    const bitIndex = 7 - (absoluteBit % 8);
    value = (value << 1) | ((bytes[byteIndex] >> bitIndex) & 0x01);
  }
  return value;
}

function writeSixBitValue(bytes: Uint8Array, bitOffset: number, value: number): void {
  for (let bit = 0; bit < 6; bit += 1) {
    const absoluteBit = bitOffset + bit;
    const byteIndex = Math.floor(absoluteBit / 8);
    const bitIndex = 7 - (absoluteBit % 8);
    const nextBit = (value >> (5 - bit)) & 0x01;
    bytes[byteIndex] |= nextBit << bitIndex;
  }
}

function bytesToSixBitValues(bytes: Uint8Array): number[] {
  const totalBits = bytes.byteLength * 8;
  if (totalBits % 6 !== 0) {
    throw new Error('Device verification code bit length must align to 6-bit Matrix symbols');
  }

  const values: number[] = [];
  for (let bitOffset = 0; bitOffset < totalBits; bitOffset += 6) {
    values.push(readSixBitValue(bytes, bitOffset));
  }
  return values;
}

function sixBitValuesToBytes(values: readonly number[]): Uint8Array {
  const totalBits = values.length * 6;
  if (totalBits % 8 !== 0) {
    throw new Error('Device verification code symbol count must align to full bytes');
  }

  const bytes = new Uint8Array(totalBits / 8);
  for (let index = 0; index < values.length; index += 1) {
    writeSixBitValue(bytes, index * 6, values[index]);
  }
  return bytes;
}

function normalizeVersion(version: string | undefined, prefix: string): string {
  if (!version) return `${prefix}1`;
  const suffix = version.startsWith(prefix) ? version.slice(prefix.length) : '';
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return `${prefix}1`;
  return `${prefix}${parsed}`;
}

function normalizeCodeInput(value: string): string {
  return value.replace(/\s+/gu, '');
}

function tokenizeDeviceVerificationCode(compactCode: string): MatrixEmojiSymbol[] {
  const symbols: MatrixEmojiSymbol[] = [];
  let offset = 0;

  while (offset < compactCode.length) {
    const matchedEntry = MATRIX_SAS_EMOJI_TABLE.find(entry =>
      compactCode.startsWith(entry.emoji, offset)
    );

    if (!matchedEntry) {
      throw new Error(
        'Emoji verification code is invalid. Legacy text auth codes are no longer supported.'
      );
    }

    symbols.push(matchedEntry.emoji);
    offset += matchedEntry.emoji.length;
  }

  return symbols;
}

function formatEmojiSymbols(symbols: readonly string[]): string {
  const groups: string[] = [];
  for (let index = 0; index < symbols.length; index += DEVICE_VERIFICATION_CODE_GROUP_SIZE) {
    groups.push(symbols.slice(index, index + DEVICE_VERIFICATION_CODE_GROUP_SIZE).join(''));
  }
  return groups.join(' ');
}

function encodeDeviceVerificationCode(bytes: Uint8Array): string {
  if (bytes.length !== DEVICE_VERIFICATION_CODE_BYTES) {
    throw new Error('Invalid device verification code byte length');
  }

  const symbols = bytesToSixBitValues(bytes).map(value => MATRIX_SAS_EMOJI_TABLE[value].emoji);
  return formatEmojiSymbols(symbols);
}

function decodeDeviceVerificationCode(canonicalCode: string): {
  symbols: MatrixEmojiSymbol[];
  words: string[];
  bytes: Uint8Array;
} {
  const symbols = tokenizeDeviceVerificationCode(canonicalCode);
  const values = symbols.map(symbol => {
    const matched = MATRIX_SAS_EMOJI_BY_SYMBOL.get(symbol);
    if (!matched) {
      throw new Error(
        'Emoji verification code is invalid. Legacy text auth codes are no longer supported.'
      );
    }
    return matched.index;
  });

  return {
    symbols,
    words: symbols.map(symbol => MATRIX_SAS_EMOJI_BY_SYMBOL.get(symbol)?.entry.word ?? ''),
    bytes: sixBitValuesToBytes(values),
  };
}

function toClientCreatedAtMillis(value: Date | number | string): number {
  if (value instanceof Date) {
    const millis = value.getTime();
    if (!Number.isFinite(millis)) {
      throw new Error('clientCreatedAt must be a valid timestamp');
    }
    return millis;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('clientCreatedAt must be a valid timestamp');
    }
    return Math.trunc(value);
  }

  const millis = new Date(value).getTime();
  if (!Number.isFinite(millis)) {
    throw new Error('clientCreatedAt must be a valid timestamp');
  }
  return millis;
}

async function deriveDeviceVerificationBytes(
  params: DeviceVerificationCodeParams
): Promise<Uint8Array> {
  const input = concatBytes(
    toUint64Bytes(toClientCreatedAtMillis(params.clientCreatedAt)),
    utf8(params.serializedPublicKey)
  );
  const derived = await argon2id({
    password: input,
    salt: utf8(DEVICE_VERIFICATION_CODE_CONTEXT),
    iterations: DEVICE_VERIFICATION_CODE_ARGON2_ITERATIONS,
    memorySize: DEVICE_VERIFICATION_CODE_ARGON2_MEMORY_KIB,
    parallelism: DEVICE_VERIFICATION_CODE_ARGON2_PARALLELISM,
    hashLength: DEVICE_VERIFICATION_CODE_BYTES,
    outputType: 'binary',
  });

  return derived instanceof Uint8Array ? derived : Uint8Array.from(derived);
}

function parseSerializedJwk(serialized: string): JsonWebKey {
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid serialized key');
  }
  return parsed as JsonWebKey;
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return canonicalJsonStringify(jwk);
}

async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return canonicalJsonStringify(jwk);
}

async function importDevicePublicKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function importDevicePrivateKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

async function deriveDeviceShareKey(params: {
  ownPrivateKey: string;
  peerPublicKey: string;
  context: string;
}): Promise<CryptoKey> {
  const privateKey = await importDevicePrivateKey(params.ownPrivateKey);
  const publicKey = await importDevicePublicKey(params.peerPublicKey);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  const keyMaterial = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveKey',
  ]);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBufferSource(utf8(`masumi-device-share:${params.context}`)),
      info: toBufferSource(utf8(DEVICE_SHARE_CIPHER_ALGORITHM)),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function parseDeviceKeyShareSnapshot(parsed: unknown): DeviceKeyShareSnapshot {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid device key share snapshot');
  }

  const snapshot = parsed as Partial<DeviceKeyShareSnapshot>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.normalizedEmail !== 'string' ||
    typeof snapshot.createdAt !== 'string' ||
    !Array.isArray(snapshot.actors)
  ) {
    throw new Error('Invalid device key share snapshot');
  }

  return {
    version: 1,
    normalizedEmail: snapshot.normalizedEmail,
    createdAt: snapshot.createdAt,
    actors: snapshot.actors as SharedActorKeyMaterial[],
  };
}

export function canonicalizeDeviceVerificationCode(code: string): string {
  const compact = normalizeCodeInput(code);
  if (!compact) {
    throw new Error('Device verification code is required');
  }

  const symbols = tokenizeDeviceVerificationCode(compact);
  if (symbols.length !== DEVICE_VERIFICATION_CODE_SYMBOLS) {
    throw new Error(
      `Emoji verification code must contain ${DEVICE_VERIFICATION_CODE_SYMBOLS.toString()} emojis. Legacy text auth codes are no longer supported.`
    );
  }

  return symbols.join('');
}

export function formatDeviceVerificationCode(code: string): string {
  return formatEmojiSymbols(tokenizeDeviceVerificationCode(canonicalizeDeviceVerificationCode(code)));
}

export function parseDeviceVerificationCode(code: string): ParsedDeviceVerificationCode {
  const canonicalCode = canonicalizeDeviceVerificationCode(code);
  const decoded = decodeDeviceVerificationCode(canonicalCode);

  return {
    canonicalCode,
    formattedCode: formatEmojiSymbols(decoded.symbols),
    symbols: decoded.symbols,
    words: decoded.words,
    fingerprintHex: toHex(decoded.bytes),
  };
}

export async function hashDeviceVerificationCode(code: string): Promise<string> {
  const canonicalCode = canonicalizeDeviceVerificationCode(code);
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(utf8(canonicalCode)));
  return `${DEVICE_VERIFICATION_CODE_HASH_ALGORITHM}:${toHex(new Uint8Array(digest))}`;
}

export async function createDeviceVerificationCode(
  params: DeviceVerificationCodeParams
): Promise<string> {
  return encodeDeviceVerificationCode(await deriveDeviceVerificationBytes(params));
}

export async function verifyDeviceVerificationCodeMatchesPublicKey(
  params: DeviceVerificationCodeParams & {
    code: string;
  }
): Promise<boolean> {
  const canonicalCode = canonicalizeDeviceVerificationCode(params.code);
  const expectedCode = await createDeviceVerificationCode({
    serializedPublicKey: params.serializedPublicKey,
    clientCreatedAt: params.clientCreatedAt,
  });
  return canonicalCode === canonicalizeDeviceVerificationCode(expectedCode);
}

export async function generateDeviceKeyPair(options?: {
  keyVersion?: string;
}): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  return {
    publicKey: await exportPublicKey(keyPair.publicKey),
    privateKey: await exportPrivateKey(keyPair.privateKey),
    keyVersion: normalizeVersion(options?.keyVersion, 'device-enc-v'),
    algorithm: DEVICE_ENCRYPTION_ALGORITHM,
  };
}

export async function createDeviceShareBundle(params: {
  sourceKeyPair: DeviceKeyPair;
  targetPublicKey: string;
  context: string;
  snapshot: DeviceKeyShareSnapshot;
}): Promise<CreatedDeviceShareBundle> {
  const shareKey = await deriveDeviceShareKey({
    ownPrivateKey: params.sourceKeyPair.privateKey,
    peerPublicKey: params.targetPublicKey,
    context: params.context,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    shareKey,
    toBufferSource(utf8(canonicalJsonStringify(params.snapshot)))
  );

  return {
    sourceEncryptionPublicKey: params.sourceKeyPair.publicKey,
    sourceEncryptionKeyVersion: params.sourceKeyPair.keyVersion,
    sourceEncryptionAlgorithm: params.sourceKeyPair.algorithm,
    bundleCiphertext: toHex(new Uint8Array(ciphertext)),
    bundleIv: toHex(iv),
    bundleAlgorithm: DEVICE_SHARE_CIPHER_ALGORITHM,
  };
}

export function buildDeviceShareContext(normalizedEmail: string, deviceId: string): string {
  return `${normalizedEmail}:${deviceId}`;
}

export function deviceShareRequestExpiresAt(clientCreatedAt: Date | number | string): Date {
  return new Date(toClientCreatedAtMillis(clientCreatedAt) + DEVICE_SHARE_REQUEST_EXPIRY_MS);
}

export async function decryptDeviceShareBundle(params: {
  recipientKeyPair: DeviceKeyPair;
  sourceEncryptionPublicKey: string;
  bundleCiphertext: string;
  bundleIv: string;
  bundleAlgorithm: string;
  context: string;
}): Promise<DeviceKeyShareSnapshot> {
  if (params.bundleAlgorithm !== DEVICE_SHARE_CIPHER_ALGORITHM) {
    throw new Error(`Unsupported device share algorithm: ${params.bundleAlgorithm}`);
  }

  const shareKey = await deriveDeviceShareKey({
    ownPrivateKey: params.recipientKeyPair.privateKey,
    peerPublicKey: params.sourceEncryptionPublicKey,
    context: params.context,
  });
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(fromHex(params.bundleIv)) },
    shareKey,
    toBufferSource(fromHex(params.bundleCiphertext))
  );

  return parseDeviceKeyShareSnapshot(
    JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext)))
  );
}

export function countSharedActors(snapshot: DeviceKeyShareSnapshot): bigint {
  return BigInt(snapshot.actors.length);
}

export function countSharedKeyVersions(snapshot: DeviceKeyShareSnapshot): bigint {
  return snapshot.actors.reduce((count, actor) => {
    const actorCount = actor.current ? 1 : 0;
    return count + BigInt(actorCount + actor.archived.length);
  }, 0n);
}

export function hasSharedPrivateKeyMaterial(snapshot: DeviceKeyShareSnapshot): boolean {
  return countSharedKeyVersions(snapshot) > 0n;
}
