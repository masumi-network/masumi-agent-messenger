const MAX_UTF8_BYTES_PER_CHAR = 4;
const AES_GCM_TAG_BYTES = 16;
const AES_GCM_IV_BYTES = 12;
const SENDER_SECRET_BYTES = 32;
const MAX_JSON_ESCAPED_CHARS_PER_CHAR = 6;
const MAX_MESSAGE_ENVELOPE_OVERHEAD_CHARS = 1_024;

export const MAX_MESSAGE_BODY_CHARS = 5_000;
export const MAX_MESSAGE_PLAINTEXT_CHARS = MAX_MESSAGE_BODY_CHARS;
export const MAX_MESSAGE_CONTENT_TYPE_CHARS = 160;
export const MAX_MESSAGE_HEADER_COUNT = 32;
export const MAX_MESSAGE_HEADER_NAME_CHARS = 64;
export const MAX_MESSAGE_HEADER_VALUE_CHARS = 500;
export const MAX_MESSAGE_HEADERS_TOTAL_CHARS = 500;
export const MAX_PUBLIC_MESSAGE_CAPABILITY_COUNT = 32;
export const MAX_MESSAGE_SERIALIZED_PAYLOAD_CHARS =
  (MAX_MESSAGE_BODY_CHARS + MAX_MESSAGE_HEADERS_TOTAL_CHARS + MAX_MESSAGE_CONTENT_TYPE_CHARS) *
    MAX_JSON_ESCAPED_CHARS_PER_CHAR +
  MAX_MESSAGE_ENVELOPE_OVERHEAD_CHARS;

// Ciphertext is stored as hex after AES-GCM encryption. This cap leaves room for
// the JSON envelope, worst-case JSON string escaping, and UTF-8 expansion for the
// supported logical payload budgets.
export const MAX_MESSAGE_CIPHERTEXT_HEX_CHARS =
  (MAX_MESSAGE_SERIALIZED_PAYLOAD_CHARS * MAX_UTF8_BYTES_PER_CHAR + AES_GCM_TAG_BYTES) * 2;

export const MAX_MESSAGE_IV_HEX_CHARS = AES_GCM_IV_BYTES * 2;
export const MAX_MESSAGE_ALGORITHM_CHARS = 64;
export const MAX_MESSAGE_SIGNATURE_HEX_CHARS = 256;
export const MAX_MESSAGE_VERSION_CHARS = 64;
export const MAX_WRAPPED_SECRET_CIPHERTEXT_HEX_CHARS =
  (SENDER_SECRET_BYTES + AES_GCM_TAG_BYTES) * 2;
export const MAX_WRAPPED_SECRET_IV_HEX_CHARS = AES_GCM_IV_BYTES * 2;

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
