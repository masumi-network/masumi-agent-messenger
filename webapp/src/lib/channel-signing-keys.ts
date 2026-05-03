import type { DbConnection } from '@/module_bindings';

type ChannelSigningKeyMessage = {
  senderAgentDbId: bigint;
  senderSigningKeyVersion: number;
};

function buildChannelSigningKey(agentDbId: bigint, signingKeyVersion: number): string {
  return `${agentDbId.toString()}:${signingKeyVersion}`;
}

export async function resolveChannelMessageSigningKeys(
  connection: DbConnection | null,
  messages: ChannelSigningKeyMessage[]
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (!connection || messages.length === 0) {
    return resolved;
  }

  const requestsByKey = new Map<
    string,
    { agentDbId: bigint; signingKeyVersion: number }
  >();
  for (const message of messages) {
    const key = buildChannelSigningKey(
      message.senderAgentDbId,
      message.senderSigningKeyVersion
    );
    requestsByKey.set(key, {
      agentDbId: message.senderAgentDbId,
      signingKeyVersion: message.senderSigningKeyVersion,
    });
  }

  const rows = await connection.procedures.lookupPublishedAgentSigningKeys({
    requests: Array.from(requestsByKey.values()),
  });
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
    resolved.get(buildChannelSigningKey(message.senderAgentDbId, message.senderSigningKeyVersion)) ??
    null
  );
}
