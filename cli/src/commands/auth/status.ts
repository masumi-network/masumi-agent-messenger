import type { Command } from 'commander';
import { authStatus } from '../../services/auth';
import { loadProfile } from '../../services/config-store';
import { createSecretStore } from '../../services/secret-store';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { bold, dim, green, renderKeyValue, yellow } from '../../services/render';

import type { BootstrapSnapshot } from '../../services/config-store';
import type { AgentKeyPair } from '../../../../shared/agent-crypto';

export function registerAuthStatusCommand(command: Command): void {
  command
    .command('status')
    .description('Show local OIDC session status')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as GlobalOptions;
      await runCommandAction({
        title: 'Masumi auth status',
        options,
        preferPlainReporter: true,
        run: ({ reporter }) =>
          (async () => {
            const status = await authStatus({
              profileName: options.profile,
              reporter,
            });

            const profile = await loadProfile(options.profile);
            const secretStore = createSecretStore();
            const agentKeyPair = await secretStore.getAgentKeyPair(profile.name);
            const namespaceVault = await secretStore.getNamespaceKeyVault(profile.name);

            const snapshot = profile.bootstrapSnapshot;
            const localKeysReady = Boolean(agentKeyPair && namespaceVault);

            // Mirror the recovery inference used in the interactive `masumi-agent-messenger auth` menu.
            const snapshotKeysRequireRecovery = (
              snapshotArg: BootstrapSnapshot | undefined,
              keyPair: AgentKeyPair | null
            ): boolean => {
              if (!snapshotArg || !keyPair) {
                return false;
              }

              if (
                snapshotArg.keyVersions.encryption !== keyPair.encryption.keyVersion ||
                snapshotArg.keyVersions.signing !== keyPair.signing.keyVersion
              ) {
                return true;
              }

              if (!snapshotArg.actorKeys) {
                return false;
              }

              return (
                snapshotArg.actorKeys.encryption.publicKey !== keyPair.encryption.publicKey ||
                snapshotArg.actorKeys.encryption.keyVersion !== keyPair.encryption.keyVersion ||
                snapshotArg.actorKeys.signing.publicKey !== keyPair.signing.publicKey ||
                snapshotArg.actorKeys.signing.keyVersion !== keyPair.signing.keyVersion
              );
            };

            const recoveryRequired =
              status.authenticated && (!localKeysReady || snapshotKeysRequireRecovery(snapshot, agentKeyPair));

            const nextAction = !status.authenticated
              ? 'masumi-agent-messenger auth login'
              : recoveryRequired
                ? 'masumi-agent-messenger auth recover'
                : profile.activeAgentSlug
                  ? 'masumi-agent-messenger thread list'
                  : 'masumi-agent-messenger agent list';

            return {
              ...status,
              profile,
              localKeysReady,
              recoveryRequired,
              nextAction,
            };
          })(),
        toHuman: result => ({
          summary: result.authenticated
            ? result.recoveryRequired
              ? yellow('Recovery needed.')
              : green('Healthy session.')
            : yellow('Not signed in.'),
          details: [
            `Next: ${bold(result.nextAction)}`,
            ...renderKeyValue([
              { key: 'Profile', value: result.profile.name, color: dim },
              { key: 'Issuer', value: result.issuer ?? 'n/a', color: dim },
              {
                key: 'Local keys',
                value: result.localKeysReady ? 'ready' : 'missing',
                color: result.localKeysReady ? green : yellow,
              },
            ]),
          ],
        }),
      });
    });
}
