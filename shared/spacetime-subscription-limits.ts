// Allowlist of SpacetimeDB tables the client may subscribe to over the live
// connection.
//
// This file does NOT cap row counts. SpacetimeDB 2.1 rejects `LIMIT` clauses in
// subscription SQL, so server-side bounded views and paged procedures are the
// only enforcement mechanisms. The allowlist here keeps call sites explicit
// about which tables we subscribe to, and `prepareSpacetimeSubscriptionQuery`
// strips trailing SQL syntax (semicolons, comments) that the SDK's query
// builder may emit — both of which the subscription endpoint rejects.

export const SPACETIME_SUBSCRIBABLE_TABLES = [
  'visible_accounts',
  'visible_account_change_signal',
  'visible_device_share_requests',
  'visible_device_key_bundles',
  'visible_channels',
  'visible_channel_memberships',
] as const;

export type SpacetimeSubscriptionTableName =
  (typeof SPACETIME_SUBSCRIBABLE_TABLES)[number];

const ALLOWED_TABLE_SET: ReadonlySet<string> = new Set(SPACETIME_SUBSCRIBABLE_TABLES);

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

export function isSubscribableTable(
  name: string
): name is SpacetimeSubscriptionTableName {
  return ALLOWED_TABLE_SET.has(name);
}

// Prepare an SDK-builder SQL string for `conn.subscriptionBuilder().subscribe`.
// Asserts the table is in the allowlist and strips trailing SQL syntax that
// the subscription endpoint rejects. Does NOT add a LIMIT — see file header.
export function prepareSpacetimeSubscriptionQuery(
  query: SqlLikeQuery,
  tableName: SpacetimeSubscriptionTableName
): string {
  if (!isSubscribableTable(tableName)) {
    throw new Error(
      `Table ${tableName} is not in the SpacetimeDB subscription allowlist`
    );
  }
  return stripTrailingSqlSyntax(queryToSql(query));
}
