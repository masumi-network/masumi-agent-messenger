import { useCallback, useEffect, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/tanstack';
import type { DbConnection } from '@/module_bindings';
import type {
  PublicChannelMirrorRow,
  PublicRecentChannelMessageRow,
} from '@/module_bindings/types';
import { deferEffectStateUpdate } from './effect-state';

type PublicChannelLookup = {
  channelId?: bigint;
  channelSlug?: string;
  enabled?: boolean;
};

function readPublicChannelError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unable to load public channel';
}

function readPublicChannelMessagesError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unable to load public channel messages';
}

export function usePublicChannelLookup(
  params: PublicChannelLookup
): [PublicChannelMirrorRow | null, boolean, string | null] {
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const enabled = params.enabled ?? true;
  const [channel, setChannel] = useState<PublicChannelMirrorRow | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !isActive || !connection) {
      return deferEffectStateUpdate(() => {
        setChannel(null);
        setReady(false);
        setError(null);
      });
    }

    let cancelled = false;
    const cancelStart = deferEffectStateUpdate(() => {
      if (cancelled) {
        return;
      }
      setReady(false);
      setError(null);

      void connection.procedures
        .readPublicChannel({
          channelId: params.channelId,
          channelSlug: params.channelSlug,
        })
        .then(rows => {
          if (cancelled) {
            return;
          }
          setChannel(rows[0] ?? null);
          setReady(true);
        })
        .catch(lookupError => {
          if (cancelled) {
            return;
          }
          setChannel(null);
          setReady(false);
          setError(readPublicChannelError(lookupError));
        });
    });

    return () => {
      cancelled = true;
      cancelStart();
    };
  }, [connection, enabled, isActive, params.channelId, params.channelSlug]);

  return [channel, ready, error];
}

export function usePublicChannelMessagesLookup(
  params: PublicChannelLookup & { beforeChannelSeq?: bigint; limit?: bigint }
): [PublicRecentChannelMessageRow[], boolean, string | null, () => void] {
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const enabled = params.enabled ?? true;
  const [messages, setMessages] = useState<PublicRecentChannelMessageRow[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => {
    setReloadToken(token => token + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !isActive || !connection || (!params.channelId && !params.channelSlug)) {
      return deferEffectStateUpdate(() => {
        setMessages([]);
        setReady(false);
        setError(null);
      });
    }

    let cancelled = false;
    const cancelStart = deferEffectStateUpdate(() => {
      if (cancelled) {
        return;
      }
      setReady(false);
      setError(null);

      void connection.procedures
        .listPublicChannelMessages({
          channelId: params.channelId,
          channelSlug: params.channelSlug,
          beforeChannelSeq: params.beforeChannelSeq,
          limit: params.limit ?? 25n,
        })
        .then(rows => {
          if (cancelled) {
            return;
          }
          setMessages(rows);
          setReady(true);
        })
        .catch(lookupError => {
          if (cancelled) {
            return;
          }
          setMessages([]);
          setReady(false);
          setError(readPublicChannelMessagesError(lookupError));
        });
    });

    return () => {
      cancelled = true;
      cancelStart();
    };
  }, [
    connection,
    enabled,
    isActive,
    params.beforeChannelSeq,
    params.channelId,
    params.channelSlug,
    params.limit,
    reloadToken,
  ]);

  return [messages, ready, error, reload];
}
