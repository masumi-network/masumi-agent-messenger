import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import { getMasumiOidcScopeString } from '../../../shared/masumi-oidc-scopes';
import {
  DEFAULT_OIDC_ISSUER,
  DEFAULT_SPACETIMEDB_DB_NAME,
  DEFAULT_SPACETIMEDB_HOST,
  resolveCliClientId,
} from './env';
import { userError } from './errors';

const CONFIG_VERSION = 1;
const DEFAULT_PROFILE_NAME = 'default';
const CONFIG_DIRECTORY_NAME = 'masumi-agent-messenger';
const LEGACY_SPACETIMEDB_DB_NAME_ALIASES = new Set([
  'agentmessenger',
  'agentmessenger-dev',
  'agent-messenger',
  'agent-messenger-dev',
]);

export { DEFAULT_SPACETIMEDB_DB_NAME, DEFAULT_SPACETIMEDB_HOST } from './env';

const BootstrapSnapshotSchema = z.object({
  email: z.string(),
  spacetimeIdentity: z.string(),
  inbox: z.object({
    id: z.string(),
    normalizedEmail: z.string(),
    displayEmail: z.string(),
  }),
  actor: z.object({
    id: z.string(),
    slug: z.string(),
    publicIdentity: z.string(),
    displayName: z.string().nullable(),
    masumiRegistrationNetwork: z.string().optional(),
    masumiInboxAgentId: z.string().optional(),
    masumiAgentIdentifier: z.string().optional(),
    masumiRegistrationState: z.string().optional(),
  }),
  keyVersions: z.object({
    encryption: z.string(),
    signing: z.string(),
  }),
  actorKeys: z
    .object({
      encryption: z.object({
        publicKey: z.string(),
        keyVersion: z.string(),
      }),
      signing: z.object({
        publicKey: z.string(),
        keyVersion: z.string(),
      }),
    })
    .optional(),
  updatedAt: z.string(),
});

const StoredProfileSchema = z.object({
  issuer: z.string(),
  clientId: z.string(),
  redirectUri: z.string().optional(),
  oidcScope: z.string(),
  activeAgentSlug: z.string().optional(),
  lastAuthenticatedAt: z.string().optional(),
  lastBootstrapAt: z.string().optional(),
  bootstrapSnapshot: BootstrapSnapshotSchema.optional(),
});

const StoredConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  activeProfile: z.string(),
  profiles: z.record(z.string(), StoredProfileSchema),
  onboarding: z
    .object({
      firstRunCoachShownAt: z.string().optional(),
    })
    .optional(),
});

type StoredProfile = z.infer<typeof StoredProfileSchema>;
type StoredConfig = z.infer<typeof StoredConfigSchema>;

export type BootstrapSnapshot = z.infer<typeof BootstrapSnapshotSchema>;

type SpacetimeTarget = {
  spacetimeHost: string;
  spacetimeDbName: string;
};

export type ResolvedProfile = StoredProfile &
  SpacetimeTarget & {
  name: string;
};

export type ProfileOverrides = {
  issuer?: string;
  clientId?: string;
  redirectUri?: string;
  oidcScope?: string;
  spacetimeHost?: string;
  spacetimeDbName?: string;
};

function resolveActiveAgentSlugAfterBootstrap(
  profile: StoredProfile,
  snapshot: BootstrapSnapshot
): string {
  const nextDefaultSlug = normalizeInboxSlug(snapshot.actor.slug) ?? snapshot.actor.slug;
  const storedActiveSlug = normalizeInboxSlug(profile.activeAgentSlug ?? '');
  if (!storedActiveSlug) {
    return nextDefaultSlug;
  }

  const previousDefaultSlug = normalizeInboxSlug(profile.bootstrapSnapshot?.actor.slug ?? '');
  if (previousDefaultSlug && storedActiveSlug === previousDefaultSlug) {
    return nextDefaultSlug;
  }

  return storedActiveSlug;
}

function defaultStoredProfile(): StoredProfile {
  return StoredProfileSchema.parse({
    issuer: process.env.MASUMI_OIDC_ISSUER ?? DEFAULT_OIDC_ISSUER,
    clientId: resolveCliClientId(),
    redirectUri: process.env.MASUMI_OIDC_REDIRECT_URI || undefined,
    oidcScope: getMasumiOidcScopeString(process.env.MASUMI_OIDC_SCOPES),
  });
}

function defaultStoredConfig(): StoredConfig {
  return {
    version: CONFIG_VERSION,
    activeProfile: DEFAULT_PROFILE_NAME,
    profiles: {},
    onboarding: {},
  };
}

function resolveConfigDirectoryForApp(appDirectoryName: string): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, appDirectoryName, 'cli');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appDirectoryName, 'cli');
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, appDirectoryName, 'cli');
  }

  return path.join(os.homedir(), '.config', appDirectoryName, 'cli');
}

export function resolveConfigDirectory(): string {
  return resolveConfigDirectoryForApp(CONFIG_DIRECTORY_NAME);
}

export function resolveConfigFilePath(): string {
  return path.join(resolveConfigDirectory(), 'config.json');
}

function canonicalizeSpacetimeDbName(databaseName: string): string {
  const trimmed = databaseName.trim();
  return LEGACY_SPACETIMEDB_DB_NAME_ALIASES.has(trimmed)
    ? DEFAULT_SPACETIMEDB_DB_NAME
    : trimmed;
}

function resolveSpacetimeTarget(overrides?: ProfileOverrides): SpacetimeTarget {
  return {
    spacetimeHost: overrides?.spacetimeHost?.trim() || DEFAULT_SPACETIMEDB_HOST,
    spacetimeDbName: canonicalizeSpacetimeDbName(
      overrides?.spacetimeDbName?.trim() || DEFAULT_SPACETIMEDB_DB_NAME
    ),
  };
}

function toStoredProfileOverrides(overrides?: ProfileOverrides): Partial<StoredProfile> {
  const storedOverrides: Partial<StoredProfile> = {};

  if (overrides?.issuer !== undefined) {
    storedOverrides.issuer = overrides.issuer;
  }
  if (overrides?.clientId !== undefined) {
    storedOverrides.clientId = overrides.clientId;
  }
  if (overrides?.redirectUri !== undefined) {
    storedOverrides.redirectUri = overrides.redirectUri;
  }
  if (overrides?.oidcScope !== undefined) {
    storedOverrides.oidcScope = overrides.oidcScope;
  }

  return storedOverrides;
}

function parseStoredConfig(raw: string): StoredConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw userError('CLI config is invalid: root value must be an object.', {
      code: 'INVALID_CONFIG',
    });
  }

  const configRecord = parsed as Record<string, unknown>;
  const rawProfiles =
    typeof configRecord.profiles === 'object' &&
    configRecord.profiles !== null &&
    !Array.isArray(configRecord.profiles)
      ? (configRecord.profiles as Record<string, unknown>)
      : {};

  const migratedProfiles = Object.fromEntries(
    Object.entries(rawProfiles).map(([profileName, profileValue]) => {
      const profileRecord =
        typeof profileValue === 'object' &&
        profileValue !== null &&
        !Array.isArray(profileValue)
          ? (profileValue as Partial<StoredProfile>)
          : undefined;

      return [profileName, mergeProfile(profileRecord)];
    })
  );

  return StoredConfigSchema.parse({
    version:
      configRecord.version === CONFIG_VERSION ? CONFIG_VERSION : CONFIG_VERSION,
    activeProfile:
      typeof configRecord.activeProfile === 'string' && configRecord.activeProfile.trim()
        ? configRecord.activeProfile
        : DEFAULT_PROFILE_NAME,
    profiles: migratedProfiles,
    onboarding:
      typeof configRecord.onboarding === 'object' &&
      configRecord.onboarding !== null &&
      !Array.isArray(configRecord.onboarding)
        ? {
            firstRunCoachShownAt:
              typeof (configRecord.onboarding as { firstRunCoachShownAt?: unknown })
                .firstRunCoachShownAt === 'string'
                ? ((configRecord.onboarding as { firstRunCoachShownAt?: unknown })
                    .firstRunCoachShownAt as string)
                : undefined,
          }
        : {},
  });
}

async function readStoredConfig(): Promise<StoredConfig> {
  const configPath = resolveConfigFilePath();

  try {
    const raw = await readFile(configPath, 'utf8');
    return parseStoredConfig(raw);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return defaultStoredConfig();
    }

    if (error instanceof z.ZodError) {
      throw userError(`CLI config is invalid: ${error.issues[0]?.message ?? 'unknown error'}`, {
        code: 'INVALID_CONFIG',
        cause: error,
      });
    }

    throw userError('Unable to read CLI config.', {
      code: 'CONFIG_READ_FAILED',
      cause: error,
    });
  }
}

async function writeStoredConfig(config: StoredConfig): Promise<void> {
  const configPath = resolveConfigFilePath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function normalizeProfileName(profileName: string | undefined): string {
  const normalized = profileName?.trim() || DEFAULT_PROFILE_NAME;
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw userError(
      'Profile names may use letters, numbers, dots, underscores, and dashes only.',
      { code: 'INVALID_PROFILE_NAME' }
    );
  }
  return normalized;
}

function mergeProfile(
  profile: Partial<StoredProfile> | undefined,
  overrides?: ProfileOverrides
): StoredProfile {
  const storedOverrides = toStoredProfileOverrides(overrides);

  const merged = {
    ...defaultStoredProfile(),
    ...profile,
    ...storedOverrides,
  };
  // Baked issuer always wins over stored config so deployment changes propagate automatically.
  // An explicit --issuer flag (storedOverrides.issuer) still takes precedence.
  if (!storedOverrides.issuer) {
    merged.issuer = DEFAULT_OIDC_ISSUER;
  }
  merged.oidcScope = getMasumiOidcScopeString(merged.oidcScope);
  return StoredProfileSchema.parse(merged);
}

export async function loadProfile(
  profileName: string | undefined,
  overrides?: ProfileOverrides
): Promise<ResolvedProfile> {
  const normalizedProfileName = normalizeProfileName(profileName);
  const config = await readStoredConfig();
  const mergedProfile = mergeProfile(config.profiles[normalizedProfileName], overrides);

  config.activeProfile = normalizedProfileName;
  config.profiles[normalizedProfileName] = mergedProfile;
  await writeStoredConfig(config);

  return {
    name: normalizedProfileName,
    ...mergedProfile,
    ...resolveSpacetimeTarget(overrides),
  };
}

export async function mutateProfile(
  profileName: string | undefined,
  mutate: (profile: StoredProfile) => StoredProfile
): Promise<ResolvedProfile> {
  const normalizedProfileName = normalizeProfileName(profileName);
  const config = await readStoredConfig();
  const nextProfile = StoredProfileSchema.parse(
    mutate(mergeProfile(config.profiles[normalizedProfileName]))
  );

  config.activeProfile = normalizedProfileName;
  config.profiles[normalizedProfileName] = nextProfile;
  await writeStoredConfig(config);

  return {
    name: normalizedProfileName,
    ...nextProfile,
    ...resolveSpacetimeTarget(),
  };
}

export async function saveBootstrapSnapshot(
  profileName: string | undefined,
  snapshot: BootstrapSnapshot
): Promise<ResolvedProfile> {
  return mutateProfile(profileName, profile => ({
    ...profile,
    activeAgentSlug: resolveActiveAgentSlugAfterBootstrap(profile, snapshot),
    bootstrapSnapshot: BootstrapSnapshotSchema.parse(snapshot),
    lastBootstrapAt: snapshot.updatedAt,
  }));
}

export async function clearProfileState(profileName: string | undefined): Promise<ResolvedProfile> {
  return mutateProfile(profileName, profile => ({
    ...profile,
    activeAgentSlug: undefined,
    lastAuthenticatedAt: undefined,
    lastBootstrapAt: undefined,
    bootstrapSnapshot: undefined,
  }));
}

export async function saveActiveAgentSlug(
  profileName: string | undefined,
  activeAgentSlug: string | undefined
): Promise<ResolvedProfile> {
  return mutateProfile(profileName, profile => ({
    ...profile,
    activeAgentSlug: activeAgentSlug?.trim() || undefined,
  }));
}

export async function shouldShowFirstRunCoach(): Promise<boolean> {
  const config = await readStoredConfig();
  return !config.onboarding?.firstRunCoachShownAt;
}

export async function markFirstRunCoachShown(): Promise<void> {
  const config = await readStoredConfig();
  config.onboarding = {
    ...(config.onboarding ?? {}),
    firstRunCoachShownAt: new Date().toISOString(),
  };
  await writeStoredConfig(config);
}
