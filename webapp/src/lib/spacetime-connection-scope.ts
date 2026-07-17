/**
 * The SpacetimeDB React connection manager keys connections by URI + database name and does
 * not include the auth token. Give each token an opaque URI scope so an anonymous connection
 * or a connection using an expired token cannot be reused for an authenticated session.
 *
 * The SDK resolves its token-exchange and WebSocket endpoints relative to this URI, replacing
 * the query string before making either request. The token itself is never placed in the URI.
 */
export function buildScopedSpacetimeUri(host: string, token: string): string {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const uri = new URL(host);
  uri.searchParams.set('__session', (hash >>> 0).toString(16));
  return uri.toString();
}
