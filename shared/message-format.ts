import {
  MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGE_CONTENT_TYPE_CHARS,
  MAX_MESSAGE_HEADER_COUNT,
  MAX_MESSAGE_HEADER_NAME_CHARS,
  MAX_MESSAGE_HEADER_VALUE_CHARS,
  MAX_MESSAGE_HEADERS_TOTAL_CHARS,
  MAX_PUBLIC_MESSAGE_CAPABILITY_COUNT,
} from './message-limits';

export type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { [key: string]: JsonLike };

export type EncryptedMessageHeader = {
  name: string;
  value: string;
};

export type EncryptedMessagePayload = {
  contentType: string;
  headers?: EncryptedMessageHeader[];
  body: string | JsonLike;
};

export type PublicHeaderCapability = {
  name: string;
  required?: boolean;
  allowMultiple?: boolean;
  sensitive?: boolean;
  allowedPrefixes?: string[];
};

export type PublicMessageCapabilities = {
  allowAllContentTypes: boolean;
  allowAllHeaders: boolean;
  supportedContentTypes: string[];
  supportedHeaders: PublicHeaderCapability[];
};

export type ParsedDecryptedMessagePayload = {
  payload: EncryptedMessagePayload;
  legacyPlaintext: boolean;
  invalidStructuredEnvelopeReason: string | null;
};

const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

export const STANDARD_MESSAGE_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'application/json-rpc',
  'application/activity+json',
  'text/bolt11',
  'application/l402',
  'application/x402-payment+json',
] as const;

export const DEFAULT_PUBLIC_MESSAGE_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
] as const;

export const STANDARD_MESSAGE_HEADER_NAMES = [
  'authorization',
  'accept',
  'idempotency-key',
  'reply-to',
  'correlation-id',
  'traceparent',
  'content-language',
] as const;

export const DEFAULT_PUBLIC_MESSAGE_HEADER_NAMES = [
  'reply-to',
  'idempotency-key',
] as const;

export const AUTHORIZATION_ALLOWED_PREFIXES = ['Bearer ', 'L402 '] as const;

export const RESERVED_MESSAGE_HEADER_NAMES = [
  'content-type',
  'thread-id',
  'sender-seq',
  'secret-version',
  'signing-key-version',
  'signature',
  'reply-to-message-id',
] as const;

export const BLOCKED_TRANSPORT_HEADER_NAMES = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: readonly string[]): string[] {
  return Array.from(value);
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

export function normalizeContentType(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutParameters = trimmed.split(';', 1)[0]?.trim() ?? '';
  if (!withoutParameters) {
    throw new Error('Content type is required');
  }
  if (withoutParameters.length > MAX_MESSAGE_CONTENT_TYPE_CHARS) {
    throw new Error(
      `Content type must be ${MAX_MESSAGE_CONTENT_TYPE_CHARS.toLocaleString()} characters or fewer`
    );
  }
  if (!MIME_TYPE_PATTERN.test(withoutParameters)) {
    throw new Error(`Content type \`${value}\` is invalid`);
  }
  return withoutParameters;
}

export function isJsonContentType(contentType: string): boolean {
  const normalized = normalizeContentType(contentType);
  return (
    normalized === 'application/json' ||
    normalized === 'application/json-rpc' ||
    normalized.endsWith('+json')
  );
}

export function normalizeMessageHeaderName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Header name is required');
  }
  if (normalized.length > MAX_MESSAGE_HEADER_NAME_CHARS) {
    throw new Error(
      `Header name must be ${MAX_MESSAGE_HEADER_NAME_CHARS.toLocaleString()} characters or fewer`
    );
  }
  if (normalized.includes('\r') || normalized.includes('\n')) {
    throw new Error(`Header name \`${value}\` is invalid`);
  }
  if (!HEADER_NAME_PATTERN.test(normalized)) {
    throw new Error(`Header name \`${value}\` is invalid`);
  }
  if (
    RESERVED_MESSAGE_HEADER_NAMES.includes(
      normalized as (typeof RESERVED_MESSAGE_HEADER_NAMES)[number]
    )
  ) {
    throw new Error(`Header name \`${normalized}\` is reserved by the message protocol`);
  }
  if (
    BLOCKED_TRANSPORT_HEADER_NAMES.includes(
      normalized as (typeof BLOCKED_TRANSPORT_HEADER_NAMES)[number]
    )
  ) {
    throw new Error(`Header name \`${normalized}\` is not supported in encrypted messages`);
  }

  const isStandard = STANDARD_MESSAGE_HEADER_NAMES.includes(
    normalized as (typeof STANDARD_MESSAGE_HEADER_NAMES)[number]
  );
  const isExtension = normalized.startsWith('x-') || normalized.startsWith('masumi-');
  if (!isStandard && !isExtension) {
    throw new Error(
      `Custom header \`${normalized}\` must start with \`x-\` or \`masumi-\``
    );
  }

  return normalized;
}

export function normalizeMessageHeaderValue(value: string): string {
  if (value.includes('\r') || value.includes('\n')) {
    throw new Error('Header values may not contain line breaks');
  }
  if (!value.trim()) {
    throw new Error('Header value is required');
  }
  if (value.length > MAX_MESSAGE_HEADER_VALUE_CHARS) {
    throw new Error(
      `Header value must be ${MAX_MESSAGE_HEADER_VALUE_CHARS.toLocaleString()} characters or fewer`
    );
  }
  return value;
}

function measureJsonLikeLength(value: JsonLike): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new Error('Message body is required');
  }
  return serialized.length;
}

function measureMessageBodyLength(body: EncryptedMessagePayload['body']): number {
  return typeof body === 'string' ? body.length : measureJsonLikeLength(body);
}

function measureHeaderChars(headers: EncryptedMessageHeader[]): number {
  return headers.reduce((total, header) => total + header.name.length + header.value.length + 2, 0);
}

export function normalizeEncryptedMessagePayload(value: EncryptedMessagePayload): EncryptedMessagePayload {
  const contentType = normalizeContentType(value.contentType);
  const headers = (value.headers ?? []).map(header => ({
    name: normalizeMessageHeaderName(header.name),
    value: normalizeMessageHeaderValue(header.value),
  }));

  if (headers.length > MAX_MESSAGE_HEADER_COUNT) {
    throw new Error(
      `Encrypted messages may include at most ${MAX_MESSAGE_HEADER_COUNT.toLocaleString()} headers`
    );
  }

  if (typeof value.body === 'string') {
    if (!value.body.trim()) {
      throw new Error('Message body is required');
    }
  } else if (value.body === undefined) {
    throw new Error('Message body is required');
  }

  if (!isJsonContentType(contentType) && typeof value.body !== 'string') {
    throw new Error(`Content type \`${contentType}\` requires a text body`);
  }

  const bodyLength = measureMessageBodyLength(value.body);
  if (bodyLength > MAX_MESSAGE_BODY_CHARS) {
    throw new Error(
      `Message body must be ${MAX_MESSAGE_BODY_CHARS.toLocaleString()} characters or fewer`
    );
  }

  const headerChars = measureHeaderChars(headers);
  if (headerChars > MAX_MESSAGE_HEADERS_TOTAL_CHARS) {
    throw new Error(
      `Encrypted message headers must total ${MAX_MESSAGE_HEADERS_TOTAL_CHARS.toLocaleString()} characters or fewer`
    );
  }

  return {
    contentType,
    ...(headers.length > 0 ? { headers } : {}),
    body: value.body,
  };
}

export function parseDecryptedMessagePlaintext(plaintext: string): ParsedDecryptedMessagePayload {
  const trimmed = plaintext.trim();
  const invalidStructuredEnvelope = (reason: string): ParsedDecryptedMessagePayload => ({
    payload: {
      contentType: 'text/plain',
      body: plaintext,
    },
    legacyPlaintext: false,
    invalidStructuredEnvelopeReason: `Invalid structured message envelope: ${reason}`,
  });

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        const hasContentType = Object.prototype.hasOwnProperty.call(parsed, 'contentType');
        const hasBody = Object.prototype.hasOwnProperty.call(parsed, 'body');

        if (hasContentType && hasBody) {
          try {
            return {
              payload: normalizeEncryptedMessagePayload(parsed as EncryptedMessagePayload),
              legacyPlaintext: false,
              invalidStructuredEnvelopeReason: null,
            };
          } catch (error) {
            return invalidStructuredEnvelope(
              error instanceof Error ? error.message : 'Invalid structured message envelope.'
            );
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return {
    payload: {
      contentType: 'text/plain',
      body: plaintext,
    },
    legacyPlaintext: true,
    invalidStructuredEnvelopeReason: null,
  };
}

export function formatEncryptedMessageBody(payload: EncryptedMessagePayload): string {
  if (isJsonContentType(payload.contentType)) {
    return JSON.stringify(payload.body, null, 2);
  }
  return typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
}

export function normalizeSupportedContentTypes(values: readonly string[]): string[] {
  if (values.length > MAX_PUBLIC_MESSAGE_CAPABILITY_COUNT) {
    throw new Error(
      `At most ${MAX_PUBLIC_MESSAGE_CAPABILITY_COUNT.toLocaleString()} public content types may be advertised`
    );
  }
  return dedupePreservingOrder(values.map(value => normalizeContentType(value)));
}

export function normalizeSupportedHeaderNames(values: readonly string[]): string[] {
  if (values.length > MAX_PUBLIC_MESSAGE_CAPABILITY_COUNT) {
    throw new Error(
      `At most ${MAX_PUBLIC_MESSAGE_CAPABILITY_COUNT.toLocaleString()} public headers may be advertised`
    );
  }
  return dedupePreservingOrder(values.map(value => normalizeMessageHeaderName(value)));
}

export function buildPublicHeaderCapability(name: string): PublicHeaderCapability {
  const normalizedName = normalizeMessageHeaderName(name);
  if (normalizedName === 'authorization') {
    return {
      name: normalizedName,
      sensitive: true,
      allowedPrefixes: asStringArray(AUTHORIZATION_ALLOWED_PREFIXES),
    };
  }
  return { name: normalizedName };
}

export function buildPublicMessageCapabilities(params: {
  allowAllContentTypes?: boolean;
  allowAllHeaders?: boolean;
  supportedContentTypes: readonly string[];
  supportedHeaders: readonly string[];
}): PublicMessageCapabilities {
  return {
    allowAllContentTypes: Boolean(params.allowAllContentTypes),
    allowAllHeaders: Boolean(params.allowAllHeaders),
    supportedContentTypes: normalizeSupportedContentTypes(params.supportedContentTypes),
    supportedHeaders: normalizeSupportedHeaderNames(params.supportedHeaders).map(name =>
      buildPublicHeaderCapability(name)
    ),
  };
}

export function buildLegacyPublicMessageCapabilities(): PublicMessageCapabilities {
  return {
    allowAllContentTypes: true,
    allowAllHeaders: true,
    supportedContentTypes: [],
    supportedHeaders: [],
  };
}

export function findUnsupportedMessageReasons(params: {
  payload: EncryptedMessagePayload;
  capabilities: PublicMessageCapabilities;
}): string[] {
  const payload = normalizeEncryptedMessagePayload(params.payload);
  const capabilities = {
    allowAllContentTypes: Boolean(params.capabilities.allowAllContentTypes),
    allowAllHeaders: Boolean(params.capabilities.allowAllHeaders),
    supportedContentTypes: normalizeSupportedContentTypes(params.capabilities.supportedContentTypes),
    supportedHeaders: dedupePreservingOrder(
      params.capabilities.supportedHeaders.map(capability =>
        normalizeMessageHeaderName(capability.name)
      )
    ).map(name => {
      const original = params.capabilities.supportedHeaders.find(
        capability => normalizeMessageHeaderName(capability.name) === name
      );
      return {
        ...original,
        name,
      };
    }),
  } satisfies PublicMessageCapabilities;

  const reasons: string[] = [];
  if (
    !capabilities.allowAllContentTypes &&
    !capabilities.supportedContentTypes.includes(payload.contentType)
  ) {
    reasons.push(`Content type \`${payload.contentType}\` is not advertised by this inbox.`);
  }

  const headersByName = new Map<string, EncryptedMessageHeader[]>();
  for (const header of payload.headers ?? []) {
    const existing = headersByName.get(header.name);
    if (existing) existing.push(header);
    else headersByName.set(header.name, [header]);
  }

  if (!capabilities.allowAllHeaders) {
    for (const [name, headers] of headersByName) {
      const capability = capabilities.supportedHeaders.find(item => item.name === name);
      if (!capability) {
        reasons.push(`Header \`${name}\` is not advertised by this inbox.`);
        continue;
      }
      if (headers.length > 1 && !capability.allowMultiple) {
        reasons.push(`Header \`${name}\` may only be sent once.`);
      }
      if (capability.allowedPrefixes?.length) {
        for (const header of headers) {
          if (!capability.allowedPrefixes.some(prefix => header.value.startsWith(prefix))) {
            reasons.push(
              `Header \`${name}\` must start with ${capability.allowedPrefixes
                .map(prefix => `\`${prefix}\``)
                .join(' or ')}.`
            );
          }
        }
      }
    }

    for (const capability of capabilities.supportedHeaders) {
      if (capability.required && !headersByName.has(capability.name)) {
        reasons.push(`Header \`${capability.name}\` is required by this inbox.`);
      }
    }
  }

  return dedupePreservingOrder(reasons);
}
