// Caps mirrored from `spacetimedb/src/constants.rs`. Server enforces these via
// `helpers::validate::ensure_byte_len[_exact]`; clients pre-validate via
// `ensureByteLen` / `ensureExactByteLen` so we never round-trip a payload the
// reducer will refuse.

export const AES_GCM_IV_BYTES = 12;
export const SIGNATURE_BYTES = 64;
const SENDER_SECRET_BYTES = 32;
const AES_GCM_TAG_BYTES = 16;

export const MAX_MESSAGE_BODY_CHARS = 5_000;
export const MAX_MESSAGE_PLAINTEXT_CHARS = MAX_MESSAGE_BODY_CHARS;
export const MAX_MESSAGE_CONTENT_TYPE_CHARS = 160;
export const MAX_MESSAGE_HEADER_COUNT = 32;
export const MAX_MESSAGE_HEADER_NAME_CHARS = 64;
export const MAX_MESSAGE_HEADER_VALUE_CHARS = 500;
export const MAX_MESSAGE_HEADERS_TOTAL_CHARS = 500;
export const MAX_PUBLIC_MESSAGE_CAPABILITY_COUNT = 32;

// Worst-case serialized canonical-JSON envelope around `body + headers + contentType`,
// allowing for JSON string escaping (×6) and a small framing overhead. Stays well below
// the 144 KiB ciphertext cap below even after UTF-8 expansion + AES-GCM tag.
export const MAX_MESSAGE_SERIALIZED_PAYLOAD_CHARS =
  (MAX_MESSAGE_BODY_CHARS + MAX_MESSAGE_HEADERS_TOTAL_CHARS + MAX_MESSAGE_CONTENT_TYPE_CHARS) *
    6 +
  1_024;

// Raw byte cap on `message.ciphertext`. Must equal the Rust `MAX_MESSAGE_CIPHERTEXT_BYTES`.
export const MAX_MESSAGE_CIPHERTEXT_BYTES = 144 * 1024;

export const MAX_MESSAGE_IV_BYTES = AES_GCM_IV_BYTES;
export const MAX_WRAPPED_SECRET_CIPHERTEXT_BYTES = SENDER_SECRET_BYTES + AES_GCM_TAG_BYTES;
export const MAX_WRAPPED_SECRET_IV_BYTES = AES_GCM_IV_BYTES;

// Raw byte cap on `device_key_bundle.bundle_ciphertext`. Mirrors the Rust constant
// (sized for ~2048 archived agent key versions plus framing).
export const MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES = 3 * 1024 * 1024;

export function validatePlaintextMessage(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Message text is required');
  }
  if (normalized.length > MAX_MESSAGE_PLAINTEXT_CHARS) {
    throw new Error(
      `Message text must be ${MAX_MESSAGE_PLAINTEXT_CHARS.toLocaleString()} characters or fewer`
    );
  }
  return normalized;
}

export function validateSerializedMessagePlaintext(value: string): string {
  if (!value.trim()) {
    throw new Error('Message payload is required');
  }
  if (value.length > MAX_MESSAGE_SERIALIZED_PAYLOAD_CHARS) {
    throw new Error(
      `Message payload must be ${MAX_MESSAGE_SERIALIZED_PAYLOAD_CHARS.toLocaleString()} characters or fewer`
    );
  }
  return value;
}

export function ensureByteLen(value: Uint8Array, max: number, field: string): Uint8Array {
  if (!value || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  if (value.length > max) {
    throw new Error(`${field} must be ${max.toLocaleString()} bytes or fewer`);
  }
  return value;
}

export function ensureExactByteLen(
  value: Uint8Array,
  expected: number,
  field: string
): Uint8Array {
  if (!value || value.length !== expected) {
    throw new Error(`${field} must be exactly ${expected.toLocaleString()} bytes`);
  }
  return value;
}

export function ensureCiphertextBytes(value: Uint8Array): Uint8Array {
  return ensureByteLen(value, MAX_MESSAGE_CIPHERTEXT_BYTES, 'ciphertext');
}

export function ensureMessageIvBytes(value: Uint8Array): Uint8Array {
  return ensureExactByteLen(value, AES_GCM_IV_BYTES, 'iv');
}

export function ensureSignatureBytes(value: Uint8Array, field = 'signature'): Uint8Array {
  return ensureExactByteLen(value, SIGNATURE_BYTES, field);
}

export function ensureWrappedSecretCiphertextBytes(value: Uint8Array): Uint8Array {
  return ensureByteLen(value, MAX_WRAPPED_SECRET_CIPHERTEXT_BYTES, 'wrappedSecretCiphertext');
}

export function ensureWrappedSecretIvBytes(value: Uint8Array): Uint8Array {
  return ensureExactByteLen(value, MAX_WRAPPED_SECRET_IV_BYTES, 'wrappedSecretIv');
}

export function ensureDeviceBundleCiphertextBytes(value: Uint8Array): Uint8Array {
  return ensureByteLen(value, MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES, 'bundleCiphertext');
}

export function ensureDeviceBundleIvBytes(value: Uint8Array): Uint8Array {
  return ensureExactByteLen(value, AES_GCM_IV_BYTES, 'bundleIv');
}
