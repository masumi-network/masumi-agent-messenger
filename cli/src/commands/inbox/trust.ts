import type { Command } from 'commander';
import { normalizeInboxSlug } from '../../../../shared/inbox-slug';
import { ensureAuthenticatedSession } from '../../services/auth';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { userError } from '../../services/errors';
import {
  confirmPeerKeyRotation,
  listTrustedPeers,
  loadPeerKeyTrustStore,
  unpinPeerKeys,
  type PeerKeyTuple,
} from '../../services/peer-key-trust';
import { resolvePublishedActorLookup } from '../../services/published-actor-lookup';
import {
  bold,
  cyan,
  renderEmptyWithTry,
  renderTable,
  senderColor,
} from '../../services/render';
import {
  connectAuthenticated,
  disconnectConnection,
} from '../../services/spacetimedb';

type TrustListOptions = GlobalOptions;

type TrustMutateOptions = GlobalOptions & {
  force?: boolean;
};

async function resolvePublishedPeer(params: {
  profileName: string;
  target: string;
}): Promise<{ publicIdentity: string; slug: string; tuple: PeerKeyTuple }> {
  const { profile, session } = await ensureAuthenticatedSession(params);
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const lookup = await resolvePublishedActorLookup({
      identifier: params.target,
      lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
      lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
      invalidMessage: 'Peer slug or email is invalid.',
      invalidCode: 'INVALID_PEER_IDENTIFIER',
      notFoundCode: 'PEER_NOT_FOUND',
      fallbackMessage: 'No published inbox actor found for that slug or email.',
    });
    const target = lookup.selected;

    return {
      publicIdentity: target.publicIdentity,
      slug: target.slug,
      tuple: {
        encryptionPublicKey: target.encryptionPublicKey,
        encryptionKeyVersion: target.encryptionKeyVersion,
        signingPublicKey: target.signingPublicKey,
        signingKeyVersion: target.signingKeyVersion,
      },
    };
  } finally {
    disconnectConnection(conn);
  }
}

export function registerInboxTrustCommand(command: Command): void {
  const trust = command
    .command('trust')
    .description('Manage pinned peer key trust (per Signal-style safety numbers)');

  trust
    .command('list')
    .description('List peers with pinned key tuples')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as TrustListOptions;
      await runCommandAction({
        title: 'masumi-agent-messenger inbox trust list',
        options,
        run: async () => {
          const peers = await listTrustedPeers();
          return {
            total: peers.length,
            peers: peers.map(entry => ({
              publicIdentity: entry.publicIdentity,
              pinnedAt: entry.pinnedAt,
              currentEncryptionKeyVersion: entry.current.encryptionKeyVersion,
              currentSigningKeyVersion: entry.current.signingKeyVersion,
              historicalVersions: entry.history.length,
            })),
          };
        },
        toHuman: result => {
          if (result.total === 0) {
            return {
              summary: renderEmptyWithTry(
                'No pinned peers yet.',
                'masumi-agent-messenger inbox trust pin <slug>'
              ),
              details: [],
            };
          }
          return {
            summary: `${bold(String(result.total))} pinned peer${result.total === 1 ? '' : 's'}.`,
            details: renderTable(
              result.peers.map(peer => ({
                publicIdentity: peer.publicIdentity,
                encryption: peer.currentEncryptionKeyVersion,
                signing: peer.currentSigningKeyVersion,
                historical: String(peer.historicalVersions),
                pinned: peer.pinnedAt,
              })),
              [
                { header: 'Peer', key: 'publicIdentity', color: cyan },
                { header: 'Encryption key', key: 'encryption', color: senderColor },
                { header: 'Signing key', key: 'signing', color: senderColor },
                { header: 'History', key: 'historical' },
                { header: 'Pinned at', key: 'pinned' },
              ]
            ),
          };
        },
      });
    });

  trust
    .command('pin <slug>')
    .description('Pin a peer\'s current keys; rotated keys require --force after verification')
    .option('--force', 'Trust rotated peer keys after verifying them out-of-band', false)
    .action(async (slug: string, _options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as TrustMutateOptions;
      const normalized = normalizeInboxSlug(slug);
      if (!normalized) {
        throw userError('Peer slug is invalid.', { code: 'INVALID_PEER_IDENTIFIER' });
      }
      await runCommandAction({
        title: `masumi-agent-messenger inbox trust pin ${normalized}`,
        options,
        run: async () => {
          const resolved = await resolvePublishedPeer({
            profileName: options.profile,
            target: normalized,
          });
          const store = await loadPeerKeyTrustStore();
          const existing = store.peers[resolved.publicIdentity];
          const status: 'first-pin' | 'reconfirmed' | 'unchanged' = !existing
            ? 'first-pin'
            : existing.current.encryptionKeyVersion === resolved.tuple.encryptionKeyVersion &&
              existing.current.signingKeyVersion === resolved.tuple.signingKeyVersion &&
              existing.current.encryptionPublicKey === resolved.tuple.encryptionPublicKey &&
              existing.current.signingPublicKey === resolved.tuple.signingPublicKey
              ? 'unchanged'
              : 'reconfirmed';
          if (status === 'reconfirmed' && !options.force) {
            throw userError(
              `Keys for ${resolved.slug} have rotated. Verify the new keys out-of-band, then run \`masumi-agent-messenger inbox trust pin --force ${resolved.slug}\` to accept them.`,
              { code: 'PEER_KEY_ROTATION_FORCE_REQUIRED' }
            );
          }
          await confirmPeerKeyRotation(resolved.publicIdentity, resolved.tuple);
          return {
            slug: resolved.slug,
            publicIdentity: resolved.publicIdentity,
            encryptionKeyVersion: resolved.tuple.encryptionKeyVersion,
            signingKeyVersion: resolved.tuple.signingKeyVersion,
            status,
          };
        },
        toHuman: result => ({
          summary:
            result.status === 'first-pin'
              ? `Pinned ${bold(result.slug)} keys (encryption ${result.encryptionKeyVersion}, signing ${result.signingKeyVersion}).`
              : result.status === 'reconfirmed'
                ? `Reconfirmed rotated keys for ${bold(result.slug)}.`
                : `${bold(result.slug)} keys were already pinned; no change.`,
          details: [],
        }),
      });
    });

  trust
    .command('reset <slug>')
    .description('Remove a peer from the pinned trust store (forces re-pin on next send)')
    .action(async (slug: string, _options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as TrustListOptions;
      const normalized = normalizeInboxSlug(slug);
      if (!normalized) {
        throw userError('Peer slug is invalid.', { code: 'INVALID_PEER_IDENTIFIER' });
      }
      await runCommandAction({
        title: `masumi-agent-messenger inbox trust reset ${normalized}`,
        options,
        run: async () => {
          const resolved = await resolvePublishedPeer({
            profileName: options.profile,
            target: normalized,
          });
          const removed = await unpinPeerKeys(resolved.publicIdentity);
          return { slug: resolved.slug, removed };
        },
        toHuman: result =>
          result.removed
            ? { summary: `Removed ${bold(result.slug)} from pinned peers.`, details: [] }
            : { summary: `${bold(result.slug)} was not pinned; nothing changed.`, details: [] },
      });
    });
}
