export const SPACETIME_SUBSCRIPTION_LIMITS = {
  publicRecentChannelMessages: 25,
  visibleAgents: 250,
  visibleInboxes: 1,
  visibleThreadParticipants: 1250,
  visibleThreadReadStates: 1250,
  visibleThreadSecretEnvelopes: 31250,
  visibleThreads: 25,
  visibleContactRequests: 250,
  visibleThreadInvites: 250,
  visibleContactAllowlistEntries: 500,
  visibleDevices: 100,
  visibleDeviceShareRequests: 100,
  visibleDeviceKeyBundles: 100,
  visibleChannels: 250,
  visibleChannelMemberships: 250,
  visibleChannelJoinRequests: 250,
} as const;

export type SpacetimeSubscriptionTableName =
  keyof typeof SPACETIME_SUBSCRIPTION_LIMITS;

type SqlLikeQuery = string | { toSql(): string };

function queryToSql(query: SqlLikeQuery): string {
  return typeof query === 'string' ? query : query.toSql();
}

function stripTrailingSqlSyntax(value: string): string {
  let sql = value.trim();
  let previous = '';
  while (sql !== previous) {
    previous = sql;
    sql = sql
      .replace(/;\s*$/, '')
      .replace(/\s*--[^\r\n]*(?:\r?\n)?\s*$/, '')
      .replace(/\s*\/\*[\s\S]*?\*\/\s*$/, '')
      .trim();
  }
  return sql;
}

export function spacetimeSubscriptionLimitFor(
  tableName: SpacetimeSubscriptionTableName
): number {
  return SPACETIME_SUBSCRIPTION_LIMITS[tableName];
}

export function limitSpacetimeSubscriptionQuery(
  query: SqlLikeQuery,
  tableName: SpacetimeSubscriptionTableName
): string {
  const sql = stripTrailingSqlSyntax(queryToSql(query));
  // SpacetimeDB 2.1 rejects `LIMIT` in live subscription SQL even though the
  // SDK query builder can emit arbitrary SQL. Keep the table allowlist wired
  // here so call sites stay explicit, but subscribe with the supported query.
  void spacetimeSubscriptionLimitFor(tableName);
  return sql;
}
