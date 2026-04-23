import type { DbConnection } from '@/module_bindings';
import { LEGACY_CHANNEL_SENDER_SIGNING_PUBLIC_KEY } from '../../../shared/message-limits';

type ChannelSigningKeyMessage = {
  senderAgentDbId: bigint;
  senderSigningKeyVersion: string;
  senderSigningPublicKey: string;
};

type PublishedAgentSigningKeyLookupRow = {
  agentDbId: bigint;
  signingKeyVersion: string;
  signingPublicKey: string;
};

function buildChannelSigningKey(agentDbId: bigint, signingKeyVersion: string): string {
  return `${agentDbId.toString()}:${signingKeyVersion}`;
}

export function readStoredChannelSigningPublicKey(value: string): string | null {
  const normalized = value.trim();
  if (normalized === LEGACY_CHANNEL_SENDER_SIGNING_PUBLIC_KEY) {
    return null;
  }
  return normalized ? normalized : null;
}

export async function resolveChannelMessageSigningKeys(
  connection: DbConnection | null,
  messages: ChannelSigningKeyMessage[]
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (!connection) {
    return resolved;
  }

  const requests = Array.from(
    new Map(
      messages
        .filter(message => !readStoredChannelSigningPublicKey(message.senderSigningPublicKey))
        .map(message => [
          buildChannelSigningKey(message.senderAgentDbId, message.senderSigningKeyVersion),
          {
            agentDbId: message.senderAgentDbId,
            signingKeyVersion: message.senderSigningKeyVersion,
          },
        ])
    ).values()
  );

  if (requests.length === 0) {
    return resolved;
  }

  const rows =
    (await connection.procedures.lookupPublishedAgentSigningKeys({
      requests,
    })) as PublishedAgentSigningKeyLookupRow[];

  for (const row of rows) {
    resolved.set(
      buildChannelSigningKey(row.agentDbId, row.signingKeyVersion),
      row.signingPublicKey
    );
  }

  return resolved;
}

export function getChannelMessageSigningPublicKey(
  message: ChannelSigningKeyMessage,
  resolved: ReadonlyMap<string, string>
): string | null {
  return (
    readStoredChannelSigningPublicKey(message.senderSigningPublicKey) ??
    resolved.get(buildChannelSigningKey(message.senderAgentDbId, message.senderSigningKeyVersion)) ??
    null
  );
}
