import { useCallback, useEffect, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/tanstack';
import type { DbConnection } from '@/module_bindings';
import type { Channel, ChannelMessage } from '@/module_bindings/types';
import { deferEffectStateUpdate } from './effect-state';
import { useOidcSessionRecovery } from '@/hooks/use-oidc-session-recovery';
import { isOidcTokenExpiredError } from './session-recovery';

/**
 * Anonymous public-channel viewing.
 *
 * The new schema dropped the public mirror tables (`publicChannel`,
 * `publicRecentChannelMessage`). Channel metadata for an anonymous viewer
 * is resolved by direct slug through a procedure that gates on
 * `channel.accessMode === 'Public'`. There is still no anonymous browsing.
 */

export type PublicChannelRow = Channel;
export type PublicChannelMessageRow = ChannelMessage;

type PublicChannelLookup = {
  channelSlug: string;
  enabled?: boolean;
};

function readPublicChannelMessagesError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unable to load public channel messages';
}

export function usePublicChannelLookup(
  params: PublicChannelLookup
): [PublicChannelRow | null, boolean, string | null] {
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const enabled = params.enabled ?? true;
  const [channel, setChannel] = useState<PublicChannelRow | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !isActive || !connection || !params.channelSlug) {
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
        .lookupPublicChannelBySlug({ slug: params.channelSlug })
        .then(row => {
          if (cancelled) {
            return;
          }
          setChannel(row ?? null);
          setReady(true);
        })
        .catch(lookupError => {
          if (cancelled) {
            return;
          }
          if (!isOidcTokenExpiredError(lookupError)) {
            setChannel(null);
          }
          setReady(false);
          setError(readPublicChannelMessagesError(lookupError));
        });
    });

    return () => {
      cancelled = true;
      cancelStart();
    };
  }, [connection, enabled, isActive, params.channelSlug]);

  const recoveringSession = useOidcSessionRecovery(error);

  return [
    channel,
    recoveringSession ? channel !== null : ready,
    recoveringSession ? null : error,
  ];
}

export function usePublicChannelMessagesLookup(
  params: PublicChannelLookup & { beforeMessageId?: bigint; limit?: bigint }
): [PublicChannelMessageRow[], boolean, string | null, () => void] {
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const enabled = params.enabled ?? true;
  const [messages, setMessages] = useState<PublicChannelMessageRow[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => {
    setReloadToken(token => token + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !isActive || !connection || !params.channelSlug) {
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
          channelSlug: params.channelSlug,
          beforeMessageId: params.beforeMessageId,
          limit: params.limit !== undefined ? Number(params.limit) : 25,
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
          if (!isOidcTokenExpiredError(lookupError)) {
            setMessages([]);
          }
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
    params.beforeMessageId,
    params.channelSlug,
    params.limit,
    reloadToken,
  ]);

  const recoveringSession = useOidcSessionRecovery(error);

  return [
    messages,
    recoveringSession ? messages.length > 0 : ready,
    recoveringSession ? null : error,
    reload,
  ];
}
