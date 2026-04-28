import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { authStatus, ensureAuthenticatedSession } from '../services/auth';
import { listOwnedAgents } from '../services/agent-state';
import { runCommandAction, type GlobalOptions } from '../services/command-runtime';
import { loadProfile } from '../services/config-store';
import { listDevices } from '../services/device';
import { discoverAgents } from '../services/discover';
import { userError } from '../services/errors';
import { confirmYesNo, promptChoice } from '../services/prompts';
import {
  ALL_SECRET_KINDS,
  type BackendId,
  createSecretStore,
  inspectSecretSources,
  listCandidateBackends,
  type SecretKind,
  type SecretSourceReport,
} from '../services/secret-store';
import { connectAnonymous, connectAuthenticated, disconnectConnection } from '../services/spacetimedb';
import { bold, cyan, dim, green, red, renderKeyValue, yellow } from '../services/render';

type KeyStorageBackendSummary = {
  id: BackendId;
  label: string;
  available: boolean;
  reason?: string;
  kindsPresent: SecretKind[];
};

type KeyStorageSummary = {
  primary: BackendId;
  backends: KeyStorageBackendSummary[];
  duplicateKinds: SecretKind[];
  conflictKinds: SecretKind[];
};

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
  keyStorage: KeyStorageSummary;
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

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function summarizeKeyStorage(sources: SecretSourceReport[], primary: BackendId): KeyStorageSummary {
  const backends: KeyStorageBackendSummary[] = sources.map(source => ({
    id: source.backendId,
    label: source.label,
    available: source.available,
    reason: source.unavailableReason,
    kindsPresent: ALL_SECRET_KINDS.filter(kind => source.secrets[kind] !== undefined),
  }));

  const duplicateKinds: SecretKind[] = [];
  const conflictKinds: SecretKind[] = [];
  for (const kind of ALL_SECRET_KINDS) {
    const presentValues = sources
      .map(source => source.secrets[kind])
      .filter((value): value is string => value !== undefined);
    if (presentValues.length < 2) continue;
    const allEqual = presentValues.every(value => value === presentValues[0]);
    if (allEqual) {
      duplicateKinds.push(kind);
    } else {
      conflictKinds.push(kind);
    }
  }

  return { primary, backends, duplicateKinds, conflictKinds };
}

export function registerDoctorCommand(program: Command): void {
  const doctor = program
    .command('doctor')
    .description('Check auth, keys, agent, devices, and discovery health');

  doctor.action(async (_options, commandInstance) => {
    const options = commandInstance.optsWithGlobals() as GlobalOptions;
    await runCommandAction<DoctorResult>({
      title: 'Masumi doctor',
      options,
      run: async ({ reporter }) => {
        const profile = await loadProfile(options.profile);
        const secretStore = createSecretStore();
        const [agentKeyPair, namespaceVault, deviceKeyMaterial, sourcesReport] = await Promise.all([
          secretStore.getAgentKeyPair(profile.name),
          secretStore.getNamespaceKeyVault(profile.name),
          secretStore.getDeviceKeyMaterial(profile.name),
          inspectSecretSources(profile.name),
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

        const keyStorage = summarizeKeyStorage(sourcesReport.sources, sourcesReport.primary);
        const localKeysReady = Boolean(agentKeyPair && namespaceVault);
        const nextAction =
          keyStorage.conflictKinds.length > 0
            ? 'masumi-agent-messenger doctor keys'
            : !status.authenticated
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
          keyStorage,
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
            {
              key: 'Key storage primary',
              value: cyan(result.keyStorage.primary),
            },
          ]),
          ...(() => {
            const backendsWithKeys = result.keyStorage.backends.filter(
              b => b.kindsPresent.length > 0
            ).length;
            const multipleBackendsHaveKeys = backendsWithKeys > 1;
            return result.keyStorage.backends
              .filter(backend => {
                if (backend.id === result.keyStorage.primary) return true;
                if (!backend.available) return true;
                return backend.kindsPresent.length > 0;
              })
              .map(backend => {
                const hasKeys = backend.kindsPresent.length > 0;
                const presence = backend.available
                  ? backend.kindsPresent.length === ALL_SECRET_KINDS.length
                    ? hasKeys && multipleBackendsHaveKeys
                      ? yellow('all keys present')
                      : green('all keys present')
                    : backend.kindsPresent.length === 0
                      ? dim('empty')
                      : yellow(
                          `partial (${backend.kindsPresent.length}/${ALL_SECRET_KINDS.length})`
                        )
                  : red(`unavailable${backend.reason ? `: ${backend.reason}` : ''}`);
                const tag = backend.id === result.keyStorage.primary ? cyan('▸') : ' ';
                return `${tag} ${dim('Backend')} ${backend.label}: ${presence}`;
              });
          })(),
          ...(result.keyStorage.backends.filter(b => b.kindsPresent.length > 0).length > 1
            ? [
                yellow(
                  `Warning: keys are stored in more than one backend. Run \`masumi-agent-messenger doctor keys\` to consolidate into the primary backend.`
                ),
              ]
            : []),
          ...(result.keyStorage.duplicateKinds.length > 0
            ? [
                yellow(
                  `Duplicate copies (safe to merge): ${result.keyStorage.duplicateKinds.join(', ')}`
                ),
              ]
            : []),
          ...(result.keyStorage.conflictKinds.length > 0
            ? [
                red(
                  `Conflicting key copies across backends: ${result.keyStorage.conflictKinds.join(
                    ', '
                  )}. Run \`masumi-agent-messenger doctor keys\` to resolve.`
                ),
              ]
            : []),
          ...(result.spacetimeError
            ? [`${dim('SpacetimeDB error:')} ${result.spacetimeError}`]
            : []),
          `${dim('Next:')} ${bold(result.nextAction)}`,
        ],
      }),
    });
  });

  registerDoctorKeysCommand(doctor);
}

type DoctorKeysOptions = GlobalOptions & {
  yes?: boolean;
  dryRun?: boolean;
};

type DoctorKeysJsonSecret = {
  present: boolean;
  fingerprint?: string;
};

type DoctorKeysJsonSource = {
  backend: BackendId;
  label: string;
  available: boolean;
  reason?: string;
  secrets: Partial<Record<SecretKind, DoctorKeysJsonSecret>>;
};

type DoctorKeysResult = {
  profile: string;
  primary: BackendId;
  sources: DoctorKeysJsonSource[];
  duplicates: SecretKind[];
  conflicts: SecretKind[];
  resolved: SecretKind[];
  unresolved: SecretKind[];
  dryRun: boolean;
};

function registerDoctorKeysCommand(parent: Command): void {
  parent
    .command('keys')
    .description('Inspect and merge agent keys across all storage backends')
    .option('--yes', 'Auto-resolve safe duplicates without prompting; fail on conflicts')
    .option('--dry-run', 'Report what would be merged without writing')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as DoctorKeysOptions;
      await runCommandAction<DoctorKeysResult>({
        title: 'Masumi doctor keys',
        options,
        run: async ({ reporter }) => {
          const profile = await loadProfile(options.profile);
          const candidates = listCandidateBackends();
          const initial = await inspectSecretSources(profile.name, candidates);

          const duplicates: SecretKind[] = [];
          const conflicts: SecretKind[] = [];
          for (const kind of ALL_SECRET_KINDS) {
            const values = initial.sources
              .map(source => source.secrets[kind])
              .filter((value): value is string => value !== undefined);
            if (values.length < 2) continue;
            if (values.every(value => value === values[0])) {
              duplicates.push(kind);
            } else {
              conflicts.push(kind);
            }
          }

          const resolved: SecretKind[] = [];
          const unresolved: SecretKind[] = [];
          const toResolve = [...duplicates, ...conflicts];

          for (const kind of toResolve) {
            const presentSources = initial.sources.filter(
              source => source.secrets[kind] !== undefined
            );
            const isConflict = conflicts.includes(kind);

            let chosenBackend: BackendId | null = null;

            if (options.json) {
              if (isConflict) {
                unresolved.push(kind);
                continue;
              }
              chosenBackend = initial.primary;
            } else if (options.yes) {
              if (isConflict) {
                reporter.info(
                  `Skipping conflict for \`${kind}\`: --yes only auto-resolves safe duplicates.`
                );
                unresolved.push(kind);
                continue;
              }
              chosenBackend = initial.primary;
            } else {
              reporter.info(
                isConflict
                  ? `Conflict for \`${kind}\`: values differ across backends.`
                  : `Duplicate for \`${kind}\`: same value in multiple backends.`
              );
              for (const source of presentSources) {
                const value = source.secrets[kind]!;
                reporter.info(
                  `  ${source.backendId} (${source.label}): ${value.length} bytes, fingerprint ${fingerprint(value)}`
                );
              }
              const choice = await promptChoice<BackendId | 'skip'>({
                question: `Which backend's value should win for \`${kind}\`?`,
                options: [
                  ...presentSources.map(source => ({
                    value: source.backendId,
                    label: `${source.backendId} (${source.label})`,
                  })),
                  { value: 'skip' as const, label: 'Skip — leave drift in place' },
                ],
                defaultValue: presentSources.find(s => s.backendId === initial.primary)
                  ? initial.primary
                  : presentSources[0]?.backendId,
              });
              if (choice === 'skip') {
                unresolved.push(kind);
                continue;
              }
              chosenBackend = choice as BackendId;
            }

            if (!chosenBackend) {
              unresolved.push(kind);
              continue;
            }

            const winner = presentSources.find(source => source.backendId === chosenBackend);
            if (!winner) {
              unresolved.push(kind);
              continue;
            }
            const winningValue = winner.secrets[kind]!;

            if (options.dryRun) {
              reporter.info(
                `[dry-run] Would write \`${kind}\` from ${winner.backendId} to primary ${initial.primary} and clear other backends.`
              );
              resolved.push(kind);
              continue;
            }

            if (!options.json && !options.yes && isConflict) {
              const confirmed = await confirmYesNo({
                defaultValue: false,
                question: `Overwrite \`${kind}\` in all other backends with the value from ${chosenBackend}?`,
              });
              if (!confirmed) {
                unresolved.push(kind);
                continue;
              }
            }

            const primaryCandidate =
              candidates.find(candidate => candidate.id === initial.primary) ??
              candidates.find(candidate => candidate.id === chosenBackend);
            if (!primaryCandidate) {
              throw userError(`No writable backend found while resolving \`${kind}\`.`, {
                code: 'KEY_STORAGE_NO_PRIMARY',
              });
            }
            await primaryCandidate.backend.set(`${profile.name}:${kind}`, winningValue);
            for (const candidate of candidates) {
              if (candidate.id === primaryCandidate.id) continue;
              try {
                await candidate.backend.delete(`${profile.name}:${kind}`);
              } catch {
                // Best-effort delete; surface in next inspection.
              }
            }
            resolved.push(kind);
            reporter.success(
              `Resolved \`${kind}\` from ${chosenBackend} into primary ${primaryCandidate.id}.`
            );
          }

          const finalReport = options.dryRun
            ? initial
            : await inspectSecretSources(profile.name, candidates);

          const sources: DoctorKeysJsonSource[] = finalReport.sources.map(source => {
            const secrets: Partial<Record<SecretKind, DoctorKeysJsonSecret>> = {};
            for (const kind of ALL_SECRET_KINDS) {
              const value = source.secrets[kind];
              if (value !== undefined) {
                secrets[kind] = { present: true, fingerprint: fingerprint(value) };
              } else {
                secrets[kind] = { present: false };
              }
            }
            return {
              backend: source.backendId,
              label: source.label,
              available: source.available,
              reason: source.unavailableReason,
              secrets,
            };
          });

          return {
            profile: profile.name,
            primary: finalReport.primary,
            sources,
            duplicates,
            conflicts,
            resolved,
            unresolved,
            dryRun: Boolean(options.dryRun),
          };
        },
        toHuman: result => {
          const headerRows = renderKeyValue([
            { key: 'Profile', value: result.profile, color: dim },
            { key: 'Primary backend', value: cyan(result.primary) },
            ...(result.dryRun ? [{ key: 'Mode', value: yellow('dry-run') }] : []),
          ]);
          const backendLines = result.sources.map(source => {
            const presence = source.available
              ? ALL_SECRET_KINDS.filter(kind => source.secrets[kind]?.present)
                  .map(kind => `${kind}=${source.secrets[kind]!.fingerprint}`)
                  .join(', ') || dim('empty')
              : red(`unavailable${source.reason ? `: ${source.reason}` : ''}`);
            const tag = source.backend === result.primary ? cyan('▸') : ' ';
            return `${tag} ${source.backend} (${source.label}): ${presence}`;
          });
          const conflictLines = [
            ...(result.duplicates.length > 0
              ? [yellow(`Duplicates (safe): ${result.duplicates.join(', ')}`)]
              : []),
            ...(result.conflicts.length > 0
              ? [red(`Conflicts: ${result.conflicts.join(', ')}`)]
              : []),
            ...(result.resolved.length > 0
              ? [green(`Resolved: ${result.resolved.join(', ')}`)]
              : []),
            ...(result.unresolved.length > 0
              ? [yellow(`Unresolved: ${result.unresolved.join(', ')}`)]
              : []),
          ];
          const summary =
            result.unresolved.length > 0
              ? yellow(`Key storage drift remains for ${result.unresolved.length} kind(s).`)
              : result.resolved.length > 0
                ? green('Key storage merged into primary backend.')
                : result.duplicates.length === 0 && result.conflicts.length === 0
                  ? green('Key storage is clean across all backends.')
                  : green('Key storage inspection complete.');
          return {
            summary,
            details: [...headerRows, ...backendLines, ...conflictLines],
          };
        },
      });
    });
}
