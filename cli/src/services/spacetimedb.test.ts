import { describe, expect, it, vi } from 'vitest';
import type { DbConnection } from '../../../webapp/src/module_bindings';
import {
  connectAuthenticated,
  disconnectConnection,
  withExistingAuthenticatedConnection,
} from './spacetimedb';

function fakeConnection(): DbConnection {
  return {
    reducers: {
      refreshInboxAuthLease: vi.fn(async () => {}),
    },
    disconnect: vi.fn(),
  } as unknown as DbConnection;
}

describe('borrowed SpacetimeDB connections', () => {
  it('returns the existing authenticated connection inside the borrow scope', async () => {
    const conn = fakeConnection();

    const connected = await withExistingAuthenticatedConnection(
      {
        conn,
        host: 'http://localhost:3000',
        databaseName: 'agentmessenger-dev',
        sessionToken: 'token-1',
      },
      () =>
        connectAuthenticated({
          host: 'http://localhost:3000',
          databaseName: 'agentmessenger-dev',
          sessionToken: 'token-1',
        })
    );

    expect(connected.conn).toBe(conn);
    expect(conn.reducers.refreshInboxAuthLease).toHaveBeenCalledTimes(1);
    expect(conn.disconnect).not.toHaveBeenCalled();
  });

  it('does not disconnect a borrowed connection inside the borrow scope', async () => {
    const conn = fakeConnection();

    await withExistingAuthenticatedConnection(
      {
        conn,
        host: 'http://localhost:3000',
        databaseName: 'agentmessenger-dev',
        sessionToken: 'token-1',
      },
      async () => {
        disconnectConnection(conn);
      }
    );

    expect(conn.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects the same connection outside the borrow scope', () => {
    const conn = fakeConnection();

    disconnectConnection(conn);

    expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });
});
