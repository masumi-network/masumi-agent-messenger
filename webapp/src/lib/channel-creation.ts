import type { DbConnection } from '@/module_bindings';
import type { Channel } from '@/module_bindings/types';

export function readVisibleChannelBySlug(
  connection: DbConnection,
  slug: string
): Channel | null {
  return (
    (Array.from(connection.db.visible_channels.iter()) as Channel[]).find(
      channel => channel.slug === slug
    ) ?? null
  );
}

export async function waitForVisibleChannelBySlug(params: {
  connection: DbConnection;
  slug: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<Channel> {
  const timeoutMs = params.timeoutMs ?? 5_000;
  const pollIntervalMs = params.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const channel = readVisibleChannelBySlug(params.connection, params.slug);
    if (channel) {
      return channel;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Channel /${params.slug} was created but did not become visible. Refresh the channel list before trying again.`
      );
    }

    await new Promise(resolve => {
      window.setTimeout(resolve, pollIntervalMs);
    });
  }
}
