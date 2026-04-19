function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex');
  }

  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  if (!passphrase.trim()) {
    throw new Error('Passphrase is required');
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toBufferSource(salt),
      iterations: 210_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export type EncryptedPassphrasePayload = {
  saltHex: string;
  ivHex: string;
  ciphertextHex: string;
  algorithm: string;
};

export async function encryptJsonWithPassphrase(
  payload: unknown,
  passphrase: string,
  algorithm: string
): Promise<EncryptedPassphrasePayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveAesKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(encoded)
  );

  return {
    saltHex: toHex(salt),
    ivHex: toHex(iv),
    ciphertextHex: toHex(new Uint8Array(ciphertext)),
    algorithm,
  };
}

export async function decryptJsonWithPassphrase<T>(
  payload: EncryptedPassphrasePayload,
  passphrase: string
): Promise<T> {
  const key = await deriveAesKey(passphrase, fromHex(payload.saltHex));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(fromHex(payload.ivHex)) },
    key,
    toBufferSource(fromHex(payload.ciphertextHex))
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
