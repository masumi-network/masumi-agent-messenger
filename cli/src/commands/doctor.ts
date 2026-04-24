import type { Command } from 'commander';
import { authStatus, ensureAuthenticatedSession } from '../services/auth';
import { listOwnedAgents } from '../services/agent-state';
import { runCommandAction, type GlobalOptions } from '../services/command-runtime';
import { loadProfile } from '../services/config-store';
import { listDevices } from '../services/device';
import { discoverAgents } from '../services/discover';
import { createSecretStore } from '../services/secret-store';
import { connectAnonymous, connectAuthenticated, disconnectConnection } from '../services/spacetimedb';
import { bold, cyan, dim, green, red, renderKeyValue, yellow } from '../services/render';

type DoctorResult = {
  profile: string;
  spacetimeHost: string;
  spacetimeDbName: string;
  authenticated: boolean;
  activeAgent: string | null;
  localKeys: {
    agentKeyPair: boolean;
    namespaceVault: boolean;
    deviceKeyMaterial: boolean;
  };
  devices: {
    total: number;
    pendingRequests: number;
  };
  spacetimeConnected: boolean;
  spacetimeError: string | null;
  discoveryReachable: boolean | null;
  nextAction: string;
};

function yesNo(value: boolean): string {
  return value ? green('yes') : yellow('no');
}

function yesNoSkipped(value: boolean | null): string {
  if (value === null) {
    return dim('skipped');
  }

  return value ? green('yes') : red('no');
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message.trim()
  ) {
    return (error as { message: string }).message;
  }

  return String(error);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check auth, keys, agent, devices, and discovery health')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as GlobalOptions;
      await runCommandAction<DoctorResult>({
        title: 'Masumi doctor',
        options,
        run: async ({ reporter }) => {
          const profile = await loadProfile(options.profile);
          const secretStore = createSecretStore();
          const [agentKeyPair, namespaceVault, deviceKeyMaterial] = await Promise.all([
            secretStore.getAgentKeyPair(profile.name),
            secretStore.getNamespaceKeyVault(profile.name),
            secretStore.getDeviceKeyMaterial(profile.name),
          ]);
          const status = await authStatus({
            profileName: options.profile,
            reporter,
            secretStore,
          });

          let totalDevices = 0;
          let pendingRequests = 0;
          let activeAgent: string | null = profile.activeAgentSlug ?? null;
          let spacetimeConnected: boolean;
          let spacetimeError: string | null = null;
          let discoveryReachable: boolean | null = null;

          try {
            if (status.authenticated) {
              const auth = await ensureAuthenticatedSession({
                profileName: options.profile,
                reporter,
                secretStore,
              });
              const { conn } = await connectAuthenticated({
                host: auth.profile.spacetimeHost,
                databaseName: auth.profile.spacetimeDbName,
                sessionToken: auth.session.idToken,
              });
              disconnectConnection(conn);
            } else {
              const { conn } = await connectAnonymous({
                host: profile.spacetimeHost,
                databaseName: profile.spacetimeDbName,
              });
              disconnectConnection(conn);
            }
            spacetimeConnected = true;
          } catch (error) {
            spacetimeConnected = false;
            spacetimeError = describeError(error);
          }

          if (status.authenticated) {
            try {
              const agents = await listOwnedAgents({
                profileName: options.profile,
                reporter,
              });
              activeAgent = agents.activeAgentSlug;
            } catch {
              // Keep last known active agent.
            }

            try {
              const devices = await listDevices({
                profileName: options.profile,
                reporter,
              });
              totalDevices = devices.devices.length;
              pendingRequests = devices.devices.reduce((sum, device) => {
                return sum + device.pendingRequestCount;
              }, 0);
            } catch {
              // Doctor should still render partial health.
            }

            try {
              await discoverAgents({
                profileName: options.profile,
                reporter,
                page: 1,
                limit: 1,
              });
              discoveryReachable = true;
            } catch {
              discoveryReachable = false;
            }
          }

          const localKeysReady = Boolean(agentKeyPair && namespaceVault);
          const nextAction = !status.authenticated
            ? 'masumi-agent-messenger account login'
            : !localKeysReady
              ? 'masumi-agent-messenger account recover'
              : !activeAgent
                ? 'masumi-agent-messenger agent list'
                : 'masumi-agent-messenger thread list';

          return {
            profile: profile.name,
            spacetimeHost: profile.spacetimeHost,
            spacetimeDbName: profile.spacetimeDbName,
            authenticated: status.authenticated,
            activeAgent,
            localKeys: {
              agentKeyPair: Boolean(agentKeyPair),
              namespaceVault: Boolean(namespaceVault),
              deviceKeyMaterial: Boolean(deviceKeyMaterial),
            },
            devices: {
              total: totalDevices,
              pendingRequests,
            },
            spacetimeConnected,
            spacetimeError,
            discoveryReachable,
            nextAction,
          };
        },
        toHuman: result => ({
          summary: result.authenticated
            ? green('Doctor check completed.')
            : yellow('Doctor check completed. Session not authenticated.'),
          details: [
            ...renderKeyValue([
              { key: 'Profile', value: result.profile, color: dim },
              { key: 'SpacetimeDB host', value: result.spacetimeHost, color: dim },
              { key: 'SpacetimeDB db', value: result.spacetimeDbName, color: dim },
              { key: 'Authenticated', value: yesNo(result.authenticated) },
              {
                key: 'SpacetimeDB websocket',
                value: yesNoSkipped(result.spacetimeConnected),
              },
              { key: 'Active agent', value: result.activeAgent ?? 'none', color: cyan },
              { key: 'Agent keypair', value: yesNo(result.localKeys.agentKeyPair) },
              { key: 'Namespace vault', value: yesNo(result.localKeys.namespaceVault) },
              { key: 'Device key material', value: yesNo(result.localKeys.deviceKeyMaterial) },
              { key: 'Devices', value: String(result.devices.total) },
              { key: 'Pending device requests', value: String(result.devices.pendingRequests) },
              {
                key: 'Masumi registry',
                value:
                  result.discoveryReachable === null
                    ? dim('skipped')
                    : yesNo(result.discoveryReachable),
              },
            ]),
            ...(result.spacetimeError
              ? [`${dim('SpacetimeDB error:')} ${result.spacetimeError}`]
              : []),
            `${dim('Next:')} ${bold(result.nextAction)}`,
          ],
        }),
      });
    });
}
