import { describe, expect, it } from 'vitest';
import {
  buildLegacyPublicMessageCapabilities,
  buildPublicMessageCapabilities,
  findUnsupportedMessageReasons,
  formatEncryptedMessageBody,
  normalizeEncryptedMessagePayload,
  parseDecryptedMessagePlaintext,
} from '../../../shared/message-format';
import {
  MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGE_HEADERS_TOTAL_CHARS,
} from '../../../shared/message-limits';

describe('message format helpers', () => {
  it('falls back to legacy text/plain for pre-structured plaintext messages', () => {
    const parsed = parseDecryptedMessagePlaintext('hello from the old format');

    expect(parsed.legacyPlaintext).toBe(true);
    expect(parsed.invalidStructuredEnvelopeReason).toBeNull();
    expect(parsed.payload).toEqual({
      contentType: 'text/plain',
      body: 'hello from the old format',
    });
  });

  it('falls back to legacy plaintext for malformed json that merely looks structured', () => {
    const parsed = parseDecryptedMessagePlaintext(
      '{"contentType":"application/json","body":'
    );

    expect(parsed.legacyPlaintext).toBe(true);
    expect(parsed.invalidStructuredEnvelopeReason).toBeNull();
    expect(parsed.payload).toEqual({
      contentType: 'text/plain',
      body: '{"contentType":"application/json","body":',
    });
  });

  it('marks invalid structured envelopes as unsupported instead of treating them as legacy plaintext', () => {
    const parsed = parseDecryptedMessagePlaintext(
      '{"contentType":"text/plain","headers":[{"name":"thread-id","value":"123"}],"body":"hello"}'
    );

    expect(parsed.legacyPlaintext).toBe(false);
    expect(parsed.invalidStructuredEnvelopeReason).toBe(
      'Invalid structured message envelope: Header name `thread-id` is reserved by the message protocol'
    );
  });

  it('falls back to legacy plaintext for partial objects that are missing the full structured shape', () => {
    const parsed = parseDecryptedMessagePlaintext('{"contentType":"application/json"}');

    expect(parsed.legacyPlaintext).toBe(true);
    expect(parsed.invalidStructuredEnvelopeReason).toBeNull();
    expect(parsed.payload).toEqual({
      contentType: 'text/plain',
      body: '{"contentType":"application/json"}',
    });
  });

  it('falls back to legacy plaintext for objects that only contain a body key', () => {
    const parsed = parseDecryptedMessagePlaintext('{"body":"hello"}');

    expect(parsed.legacyPlaintext).toBe(true);
    expect(parsed.invalidStructuredEnvelopeReason).toBeNull();
    expect(parsed.payload).toEqual({
      contentType: 'text/plain',
      body: '{"body":"hello"}',
    });
  });

  it('supports JSON string bodies for json content types', () => {
    const payload = normalizeEncryptedMessagePayload({
      contentType: 'application/json',
      body: 'hello',
    });

    expect(formatEncryptedMessageBody(payload)).toBe('"hello"');
  });

  it('rejects message bodies above the 5k logical body budget', () => {
    expect(() =>
      normalizeEncryptedMessagePayload({
        contentType: 'text/plain',
        body: 'x'.repeat(MAX_MESSAGE_BODY_CHARS + 1),
      })
    ).toThrow(
      `Message body must be ${MAX_MESSAGE_BODY_CHARS.toLocaleString()} characters or fewer`
    );
  });

  it('rejects encrypted headers above the combined 500-character budget', () => {
    expect(() =>
      normalizeEncryptedMessagePayload({
        contentType: 'text/plain',
        headers: [
          {
            name: 'reply-to',
            value: 'x'.repeat(MAX_MESSAGE_HEADERS_TOTAL_CHARS),
          },
        ],
        body: 'hello',
      })
    ).toThrow(
      `Encrypted message headers must total ${MAX_MESSAGE_HEADERS_TOTAL_CHARS.toLocaleString()} characters or fewer`
    );
  });

  it('reports unsupported content types, duplicate headers, and invalid auth prefixes', () => {
    const reasons = findUnsupportedMessageReasons({
      payload: {
        contentType: 'application/json-rpc',
        headers: [
          { name: 'authorization', value: 'Basic abc' },
          { name: 'authorization', value: 'Bearer sk_abc123' },
        ],
        body: { id: 1, jsonrpc: '2.0', method: 'ping' },
      },
      capabilities: buildPublicMessageCapabilities({
        supportedContentTypes: ['application/json'],
        supportedHeaders: ['authorization'],
      }),
    });

    expect(reasons).toEqual([
      'Content type `application/json-rpc` is not advertised by this inbox.',
      'Header `authorization` may only be sent once.',
      'Header `authorization` must start with `Bearer ` or `L402 `.',
    ]);
  });

  it('treats legacy message capabilities as allow-all defaults', () => {
    expect(buildLegacyPublicMessageCapabilities()).toEqual({
      allowAllContentTypes: true,
      allowAllHeaders: true,
      supportedContentTypes: [],
      supportedHeaders: [],
    });
  });

  it('treats allow-all capabilities as a true wildcard for content types and headers', () => {
    const reasons = findUnsupportedMessageReasons({
      payload: {
        contentType: 'application/xml',
        headers: [
          { name: 'authorization', value: 'Basic abc' },
          { name: 'x-anything', value: 'goes' },
        ],
        body: '<ping />',
      },
      capabilities: buildPublicMessageCapabilities({
        allowAllContentTypes: true,
        allowAllHeaders: true,
        supportedContentTypes: ['text/plain'],
        supportedHeaders: ['reply-to'],
      }),
    });

    expect(reasons).toEqual([]);
  });
});
