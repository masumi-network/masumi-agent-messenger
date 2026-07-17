import { describe, expect, it } from 'vitest';
import { buildScopedSpacetimeUri } from '@/lib/spacetime-connection-scope';

describe('SpacetimeDB connection auth scoping', () => {
  it('uses a stable opaque URI scope per token', () => {
    const first = buildScopedSpacetimeUri(
      'https://maincloud.spacetimedb.com',
      'header.first.signature'
    );
    const repeated = buildScopedSpacetimeUri(
      'https://maincloud.spacetimedb.com',
      'header.first.signature'
    );
    const refreshed = buildScopedSpacetimeUri(
      'https://maincloud.spacetimedb.com',
      'header.refreshed.signature'
    );

    expect(first).toBe(repeated);
    expect(refreshed).not.toBe(first);
    expect(first).not.toContain('header.first.signature');
  });

  it('separates authenticated connections from the anonymous manager key', () => {
    const host = 'https://maincloud.spacetimedb.com';
    const authenticatedUri = buildScopedSpacetimeUri(host, 'id-token');

    expect(authenticatedUri).not.toBe(new URL(host).toString());
  });

  it('does not forward the client-only scope to SDK-relative endpoints', () => {
    const scopedUri = buildScopedSpacetimeUri(
      'https://maincloud.spacetimedb.com',
      'id-token'
    );
    const tokenExchangeUrl = new URL('v1/identity/websocket-token', scopedUri);
    const websocketUrl = new URL(
      'v1/database/masumi-agent-messenger/subscribe',
      scopedUri
    );

    expect(tokenExchangeUrl.searchParams.has('__session')).toBe(false);
    expect(websocketUrl.searchParams.has('__session')).toBe(false);
  });
});
