export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex encoding');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function parseSerializedJwk(serialized: string): JsonWebKey {
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid serialized key');
  }
  return parsed as JsonWebKey;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(bytes));
  return toHex(new Uint8Array(digest));
}

export async function importEncryptionPublicKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

export async function importEncryptionPrivateKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

export async function importSigningPublicKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

export async function importSigningPrivateKey(serialized: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    parseSerializedJwk(serialized),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
}
