import { describe, expect, it } from 'vitest';
import {
  readVisibleChannelBySlug,
  waitForVisibleChannelBySlug,
} from '@/lib/channel-creation';
import type { DbConnection } from '@/module_bindings';
import type { Channel } from '@/module_bindings/types';

function connectionWithRows(rows: Channel[]): DbConnection {
  return {
    db: {
      visible_channels: {
        iter: () => rows.values(),
      },
    },
  } as unknown as DbConnection;
}

describe('channel creation visibility', () => {
  it('reads the newly applied channel from the subscribed client cache', () => {
    const channel = { slug: 'release-room' } as Channel;
    const connection = connectionWithRows([channel]);

    expect(readVisibleChannelBySlug(connection, 'release-room')).toBe(channel);
    expect(readVisibleChannelBySlug(connection, 'missing')).toBeNull();
  });

  it('continues only after the created channel is visible', async () => {
    const channel = { slug: 'release-room' } as Channel;
    const connection = connectionWithRows([channel]);

    await expect(
      waitForVisibleChannelBySlug({
        connection,
        slug: 'release-room',
        timeoutMs: 1,
      })
    ).resolves.toBe(channel);
  });
});
