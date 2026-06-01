import { createInterface } from 'node:readline/promises';
import open from 'open';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  clearProfileState,
  copyProfileState,
  loadProfile,
  mutateProfile,
  profileStateExists,
  type ProfileOverrides,
  type ResolvedProfile,
} from './config-store';
import { userError } from './errors';
import {
  decodeIdTokenClaims,
  discoverOidcMetadata,
  getOidcScope,
  isStoredOidcSession,
  type OidcDebugLogger,
  requestVerificationEmail,
  refreshStoredSession,
  requestDeviceAuthorization,
  sessionNeedsRefresh,
  validateOidcIdToken,
  waitForDeviceAuthorization,
  type DeviceAuthorizationChallenge,
  type IdTokenClaims,
  type OidcMetadata,
  type StoredOidcSession,
} from './oidc';
import {
  createSecretStore,
  type SecretStore,
} from './secret-store';
import { withPromptOutputSuspended } from './prompts';
import type { TaskReporter } from './command-runtime';
import {
  bootstrapAuthenticatedInbox,
  type BootstrapResult,
  type ConfirmDefaultSlugPrompt,
} from './inbox-bootstrap';
import {
  createPendingRegistrationResult,
  type ConfirmLinkedEmailPrompt,
  type ConfirmPublicDescriptionPrompt,
  type ConfirmRegistrationPrompt,
  type PauseHandler,
  type RegistrationMode,
} from './masumi-inbox-agent';

export type AuthStatusResult = {
  authenticated: boolean;
  expiresAt: string | null;
  issuer: string | null;
  email: string | null;
  subject: string | null;
  sessionId?: string | null;
  jwtId?: string | null;
  grantedScopes: string[];
  profile: string;
  archivedProfile?: string;
  restoredProfile?: string;
};

export type AuthenticatedInboxResult = AuthStatusResult & BootstrapResult;

export type PendingDeviceLoginResult = {
  authenticated: false;
  pending: true;
  profile: string;
  issuer: string;
  clientId: string;
  requestedScopes: string[];
  pollingCode: string;
  deviceCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
  agentRegistration: ReturnType<typeof createPendingRegistrationResult>;
};

export type AuthSessionContext = {
  profile: ResolvedProfile;
  session: StoredOidcSession;
  claims: IdTokenClaims;
};

export type VerificationEmailRequestResult = {
  sent: true;
  email: string;
  issuer: string;
  callbackURL?: string;
};

type PreparedDeviceLogin = {
  profile: ResolvedProfile;
  metadata: OidcMetadata;
  challenge: DeviceAuthorizationChallenge;
  pendingResult: PendingDeviceLoginResult;
};

type PreparedAuthenticatedProfile = {
  profile: ResolvedProfile;
  switchedAccount: boolean;
  archivedProfile: string | null;
  restoredProfile: string | null;
};

type StoredSessionSnapshot = {
  session: StoredOidcSession;
  claims: IdTokenClaims;
};

function defaultSecretStore(): SecretStore {
  return createSecretStore();
}

async function defaultWaitForEnter(url: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await withPromptOutputSuspended(async () => {
    try {
      await readline.question(`Press Enter to open browser:\n${url}\n`);
    } finally {
      readline.close();
    }
  });
}

async function defaultOpenBrowser(url: string): Promise<boolean> {
  try {
    await open(url, {
      wait: false,
    });
    return true;
  } catch {
    return false;
  }
}

function toProfileOverrides(params: {
  issuer?: string;
  clientId?: string;
}): ProfileOverrides | undefined {
  const overrides: ProfileOverrides = {};

  if (params.issuer?.trim()) {
    overrides.issuer = params.issuer.trim();
  }

  if (params.clientId?.trim()) {
    overrides.clientId = params.clientId.trim();
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function ensureUserCodeParam(verificationUri: string, userCode: string): string {
  const trimmedUri = verificationUri.trim();

  try {
    const url = new URL(trimmedUri);
    url.searchParams.set('user_code', userCode);
    return url.toString();
  } catch {
    const separator = trimmedUri.includes('?') ? '&' : '?';
    return `${trimmedUri}${separator}user_code=${encodeURIComponent(userCode)}`;
  }
}

function chooseVerificationUrl(challenge: DeviceAuthorizationChallenge): string {
  const verificationUri =
    challenge.verificationUriComplete?.trim() || challenge.verificationUri;
  return ensureUserCodeParam(verificationUri, challenge.userCode);
}

function toAuthStatus(
  profile: ResolvedProfile,
  session: StoredOidcSession | null,
  claims: IdTokenClaims | null,
  accountSwitch?: {
    archivedProfile: string | null;
    restoredProfile: string | null;
  }
): AuthStatusResult {
  return {
    authenticated: Boolean(session && claims),
    expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    issuer: claims?.issuer ?? null,
    email: claims?.email ?? null,
    subject: claims?.subject ?? null,
    sessionId: claims?.sessionId ?? null,
    jwtId: claims?.jwtId ?? null,
    grantedScopes: session?.grantedScopes ?? [],
    profile: profile.name,
    ...(accountSwitch?.archivedProfile
      ? { archivedProfile: accountSwitch.archivedProfile }
      : {}),
    ...(accountSwitch?.restoredProfile
      ? { restoredProfile: accountSwitch.restoredProfile }
      : {}),
  };
}

function toPendingDeviceLoginResult(params: {
  profile: ResolvedProfile;
  metadata: OidcMetadata;
  challenge: DeviceAuthorizationChallenge;
  requestedScope: string;
}): PendingDeviceLoginResult {
  return {
    authenticated: false,
    pending: true,
    profile: params.profile.name,
    issuer: params.metadata.issuer,
    clientId: params.profile.clientId,
    requestedScopes: params.requestedScope.split(/\s+/).filter(Boolean),
    pollingCode: params.challenge.deviceCode,
    deviceCode: params.challenge.userCode,
    verificationUri: chooseVerificationUrl(params.challenge),
    expiresAt: new Date(params.challenge.expiresAt).toISOString(),
    intervalSeconds: params.challenge.intervalSeconds,
    agentRegistration: createPendingRegistrationResult(),
  };
}

function reportDeviceChallenge(
  reporter: TaskReporter,
  result: PendingDeviceLoginResult
): void {
  const verificationUri = result.verificationUri;
  reporter.setBanner?.({
    code: result.deviceCode,
    label: 'Device code',
    verificationUri,
    hint:
      `Enter this device code in browser: ${verificationUri}\n` +
      'Press [C] to copy URL · [U] to copy device code.',
  });
  reporter.verbose?.(`Verification URL: ${verificationUri}`);
  reporter.verbose?.(`Code expires at ${result.expiresAt}`);
}

function createOidcDebugLogger(
  reporter: TaskReporter,
  enabled: boolean | undefined
): OidcDebugLogger | undefined {
  if (!enabled) {
    return undefined;
  }

  return message => {
    reporter.info(`[auth debug] ${new Date().toISOString()} ${message}`);
  };
}

function isAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: string }).code === 'AUTH_REQUIRED'
  );
}

function isOidcIdTokenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('OIDC_ID_TOKEN_')
  );
}

function invalidLocalSessionError(cause?: unknown) {
  return userError(
    'Local OIDC session is invalid. Run `masumi-agent-messenger account login` in an interactive terminal, or use `masumi-agent-messenger account login start` / `masumi-agent-messenger account login complete --polling-code <polling-code>` in automation.',
    {
      code: 'AUTH_REQUIRED',
      cause,
    }
  );
}

function normalizeOptionalEmail(value: string | null | undefined): string | null {
  const normalized = normalizeEmail(value ?? '');
  return normalized || null;
}

function snapshotEmailDiffersFromClaims(
  profile: ResolvedProfile,
  claims: IdTokenClaims
): boolean {
  const snapshotEmail = normalizeOptionalEmail(
    profile.bootstrapSnapshot?.inbox.email ?? profile.bootstrapSnapshot?.email
  );
  const claimsEmail = normalizeOptionalEmail(claims.email);

  return Boolean(snapshotEmail && claimsEmail && snapshotEmail !== claimsEmail);
}

function claimsReferToDifferentAccount(
  previous: IdTokenClaims | null,
  next: IdTokenClaims
): boolean {
  return Boolean(
    previous &&
      (previous.issuer !== next.issuer || previous.subject !== next.subject)
  );
}

function describeAuthenticatedAccount(
  claims: IdTokenClaims | null,
  fallback: string
): string {
  return normalizeOptionalEmail(claims?.email ?? null) ?? claims?.subject ?? fallback;
}

function decodeStoredSessionSnapshot(
  session: StoredOidcSession | null
): StoredSessionSnapshot | null {
  if (!session) {
    return null;
  }

  try {
    return {
      session,
      claims: decodeIdTokenClaims(session.idToken),
    };
  } catch {
    return null;
  }
}

async function loadStoredSessionSnapshot(params: {
  profileName: string;
  secretStore: SecretStore;
}): Promise<StoredSessionSnapshot | null> {
  try {
    const session = await params.secretStore.getOidcSession(params.profileName);
    return decodeStoredSessionSnapshot(session);
  } catch {
    return null;
  }
}

function buildArchivedProfileName(profileName: string, accountLabel: string): string {
  const accountSlug = normalizeInboxSlug(accountLabel) || 'account';
  return `${profileName}.account.${accountSlug}`;
}

async function archiveProfileSecrets(params: {
  sourceProfileName: string;
  targetProfileName: string;
  secretStore: SecretStore;
  previousSessionSnapshot: StoredSessionSnapshot | null;
  nextClaims: IdTokenClaims;
}): Promise<void> {
  const agentKeyPair = await params.secretStore.getAgentKeyPair(params.sourceProfileName);
  const deviceMaterial = await params.secretStore.getDeviceKeyMaterial(params.sourceProfileName);
  const namespaceVault = await params.secretStore.getNamespaceKeyVault(params.sourceProfileName);

  if (agentKeyPair) {
    await params.secretStore.setAgentKeyPair(params.targetProfileName, agentKeyPair);
  }
  if (deviceMaterial) {
    await params.secretStore.setDeviceKeyMaterial(params.targetProfileName, deviceMaterial);
  }
  if (namespaceVault) {
    await params.secretStore.setNamespaceKeyVault(params.targetProfileName, namespaceVault);
  }
  if (
    params.previousSessionSnapshot &&
    claimsReferToDifferentAccount(params.previousSessionSnapshot.claims, params.nextClaims)
  ) {
    await params.secretStore.setOidcSession(
      params.targetProfileName,
      params.previousSessionSnapshot.session
    );
  }
}

async function restoreProfileSecrets(params: {
  sourceProfileName: string;
  targetProfileName: string;
  secretStore: SecretStore;
}): Promise<void> {
  const agentKeyPair = await params.secretStore.getAgentKeyPair(params.sourceProfileName);
  const deviceMaterial = await params.secretStore.getDeviceKeyMaterial(params.sourceProfileName);
  const namespaceVault = await params.secretStore.getNamespaceKeyVault(params.sourceProfileName);

  if (agentKeyPair) {
    await params.secretStore.setAgentKeyPair(params.targetProfileName, agentKeyPair);
  } else {
    await params.secretStore.deleteAgentKeyPair(params.targetProfileName);
  }

  if (deviceMaterial) {
    await params.secretStore.setDeviceKeyMaterial(params.targetProfileName, deviceMaterial);
  } else {
    await params.secretStore.deleteDeviceKeyMaterial(params.targetProfileName);
  }

  if (namespaceVault) {
    await params.secretStore.setNamespaceKeyVault(params.targetProfileName, namespaceVault);
  } else {
    await params.secretStore.deleteNamespaceKeyVault(params.targetProfileName);
  }
}

async function prepareProfileForAuthenticatedAccount(params: {
  profile: ResolvedProfile;
  claims: IdTokenClaims;
  secretStore: SecretStore;
  reporter?: TaskReporter;
  previousSession?: StoredOidcSession | null;
}): Promise<PreparedAuthenticatedProfile> {
  const previousSessionSnapshot =
    params.previousSession === undefined
      ? await loadStoredSessionSnapshot({
          profileName: params.profile.name,
          secretStore: params.secretStore,
        })
      : decodeStoredSessionSnapshot(params.previousSession);
  const previousClaims = previousSessionSnapshot?.claims ?? null;

  const switchedAccount =
    snapshotEmailDiffersFromClaims(params.profile, params.claims) ||
    claimsReferToDifferentAccount(previousClaims, params.claims);

  if (!switchedAccount) {
    return {
      profile: params.profile,
      switchedAccount: false,
      archivedProfile: null,
      restoredProfile: null,
    };
  }

  const previousLabel =
    normalizeOptionalEmail(
      params.profile.bootstrapSnapshot?.inbox.email ?? params.profile.bootstrapSnapshot?.email
    ) ?? describeAuthenticatedAccount(previousClaims, 'previous account');
  const nextLabel = describeAuthenticatedAccount(params.claims, 'new account');
  const archivedProfileName = buildArchivedProfileName(params.profile.name, previousLabel);
  const restoreProfileName = buildArchivedProfileName(params.profile.name, nextLabel);
  const canRestoreProfile =
    restoreProfileName !== archivedProfileName &&
    await profileStateExists(restoreProfileName);

  params.reporter?.info(
    `Authenticated account changed from ${previousLabel} to ${nextLabel}; archiving the previous local account state in profile ${archivedProfileName}.`
  );
  params.reporter?.verbose?.('Archiving local account secrets before account switch');
  await archiveProfileSecrets({
    sourceProfileName: params.profile.name,
    targetProfileName: archivedProfileName,
    secretStore: params.secretStore,
    previousSessionSnapshot,
    nextClaims: params.claims,
  });
  params.reporter?.verbose?.('Archiving stored profile bootstrap state before account switch');
  await copyProfileState({
    sourceProfileName: params.profile.name,
    targetProfileName: archivedProfileName,
  });

  if (canRestoreProfile) {
    params.reporter?.info(
      `Restoring archived local account state from profile ${restoreProfileName}.`
    );
    params.reporter?.verbose?.('Restoring local account secrets for authenticated account');
    await restoreProfileSecrets({
      sourceProfileName: restoreProfileName,
      targetProfileName: params.profile.name,
      secretStore: params.secretStore,
    });
    params.reporter?.verbose?.('Restoring profile bootstrap state for authenticated account');
    const profile = await copyProfileState({
      sourceProfileName: restoreProfileName,
      targetProfileName: params.profile.name,
    });

    return {
      profile,
      switchedAccount: true,
      archivedProfile: archivedProfileName,
      restoredProfile: restoreProfileName,
    };
  }

  params.reporter?.verbose?.('Resetting active profile agent key bundle for account switch');
  await params.secretStore.deleteAgentKeyPair(params.profile.name);
  params.reporter?.verbose?.('Resetting active profile device key bundle for account switch');
  await params.secretStore.deleteDeviceKeyMaterial(params.profile.name);
  params.reporter?.verbose?.('Resetting active profile namespace key vault for account switch');
  await params.secretStore.deleteNamespaceKeyVault(params.profile.name);
  params.reporter?.verbose?.('Resetting active profile bootstrap state for account switch');
  const profile = await clearProfileState(params.profile.name);

  return {
    profile,
    switchedAccount: true,
    archivedProfile: archivedProfileName,
    restoredProfile: null,
  };
}

async function persistAuthenticatedProfile(
  profileName: string,
  profile: ResolvedProfile,
  session: StoredOidcSession
): Promise<ResolvedProfile> {
  return mutateProfile(profileName, current => ({
    ...current,
    issuer: profile.issuer,
    clientId: profile.clientId,
    lastAuthenticatedAt: new Date(session.createdAt).toISOString(),
  }));
}

async function prepareDeviceLogin(params: {
  profileName: string;
  issuer?: string;
  clientId?: string;
  reporter: TaskReporter;
  debug?: boolean;
}): Promise<PreparedDeviceLogin> {
  const profile = await loadProfile(params.profileName, toProfileOverrides(params));
  const debug = createOidcDebugLogger(params.reporter, params.debug);
  const requestedScope = getOidcScope(profile.oidcScope);

  params.reporter.verbose?.(`Discovering OIDC issuer ${profile.issuer}`);
  const metadata = await discoverOidcMetadata(profile.issuer);
  params.reporter.verbose?.(`OIDC issuer ready: ${metadata.issuer}`);
  debug?.(`Client ID: ${profile.clientId}`);
  debug?.(`Requested scopes: ${requestedScope}`);
  debug?.(`Token endpoint: ${metadata.token_endpoint}`);
  debug?.(
    `Device authorization endpoint: ${metadata.device_authorization_endpoint ?? 'not advertised'}`
  );

  params.reporter.verbose?.('Requesting device authorization');
  const challenge = await requestDeviceAuthorization({
    metadata,
    clientId: profile.clientId,
    scope: requestedScope,
  });

  const pendingResult = toPendingDeviceLoginResult({
    profile,
    metadata,
    challenge,
    requestedScope,
  });
  debug?.(
    `Device authorization created: device_code=${challenge.userCode}, polling_code=${challenge.deviceCode}, interval=${challenge.intervalSeconds}s, expires_at=${new Date(challenge.expiresAt).toISOString()}`
  );
  reportDeviceChallenge(params.reporter, pendingResult);

  return {
    profile,
    metadata,
    challenge,
    pendingResult,
  };
}

async function persistDeviceSession(params: {
  profile: ResolvedProfile;
  session: StoredOidcSession;
  secretStore?: SecretStore;
  reporter?: TaskReporter;
}): Promise<{
  status: AuthStatusResult;
  profile: ResolvedProfile;
  claims: IdTokenClaims;
}> {
  const claims = decodeIdTokenClaims(params.session.idToken);
  const secretStore = params.secretStore ?? defaultSecretStore();
  const prepared = await prepareProfileForAuthenticatedAccount({
    profile: params.profile,
    claims,
    secretStore,
    reporter: params.reporter,
  });
  await secretStore.setOidcSession(prepared.profile.name, params.session);
  const persistedProfile = await persistAuthenticatedProfile(
    prepared.profile.name,
    prepared.profile,
    params.session
  );

  return {
    status: toAuthStatus(persistedProfile, params.session, claims, {
      archivedProfile: prepared.archivedProfile,
      restoredProfile: prepared.restoredProfile,
    }),
    profile: persistedProfile,
    claims,
  };
}

export function isPendingDeviceLoginResult(
  result: AuthenticatedInboxResult | PendingDeviceLoginResult
): result is PendingDeviceLoginResult {
  return 'pending' in result && result.pending;
}

export async function startLogin(params: {
  profileName: string;
  issuer?: string;
  clientId?: string;
  reporter: TaskReporter;
  debug?: boolean;
}): Promise<PendingDeviceLoginResult> {
  const prepared = await prepareDeviceLogin(params);
  return prepared.pendingResult;
}

export async function waitForLogin(params: {
  profileName: string;
  pollingCode: string;
  issuer?: string;
  clientId?: string;
  reporter: TaskReporter;
  registrationMode?: RegistrationMode;
  desiredLinkedEmailVisibility?: boolean;
  desiredPublicDescription?: string;
  confirmAgentRegistration?: ConfirmRegistrationPrompt;
  confirmDefaultSlug?: ConfirmDefaultSlugPrompt;
  confirmLinkedEmailVisibility?: ConfirmLinkedEmailPrompt;
  confirmPublicDescription?: ConfirmPublicDescriptionPrompt;
  pauseAfterRegistrationBlocked?: PauseHandler;
  sleep?: (ms: number) => Promise<void>;
  secretStore?: SecretStore;
  debug?: boolean;
}): Promise<AuthenticatedInboxResult> {
  const profile = await loadProfile(params.profileName, toProfileOverrides(params));
  const debug = createOidcDebugLogger(params.reporter, params.debug);
  const requestedScope = getOidcScope(profile.oidcScope);

  params.reporter.verbose?.(`Discovering OIDC issuer ${profile.issuer}`);
  const metadata = await discoverOidcMetadata(profile.issuer);
  params.reporter.verbose?.(`OIDC issuer ready: ${metadata.issuer}`);
  debug?.(`Client ID: ${profile.clientId}`);
  debug?.(`Requested scopes: ${requestedScope}`);
  debug?.(`Token endpoint: ${metadata.token_endpoint}`);
  debug?.(
    `Device authorization endpoint: ${metadata.device_authorization_endpoint ?? 'not advertised'}`
  );

  params.reporter.info('Waiting for authorization...');
  const session = await waitForDeviceAuthorization({
    metadata,
    clientId: profile.clientId,
    deviceCode: params.pollingCode,
    sleep: params.sleep,
    debug,
  });

  const persisted = await persistDeviceSession({
    profile,
    session,
    secretStore: params.secretStore,
    reporter: params.reporter,
  });

  params.reporter.verbose?.('Bootstrapping inbox after authentication');
  const bootstrap = await bootstrapAuthenticatedInbox({
    profile: persisted.profile,
    session,
    claims: persisted.claims,
    reporter: params.reporter,
    registrationMode: params.registrationMode,
    desiredLinkedEmailVisibility: params.desiredLinkedEmailVisibility,
    desiredPublicDescription: params.desiredPublicDescription,
    confirmAgentRegistration: params.confirmAgentRegistration,
    confirmDefaultSlug: params.confirmDefaultSlug,
    confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
    confirmPublicDescription: params.confirmPublicDescription,
    pauseAfterRegistrationBlocked: params.pauseAfterRegistrationBlocked,
    secretStore: params.secretStore,
  });

  params.reporter.success(`Authenticated ${persisted.status.email ?? persisted.status.subject ?? persisted.profile.name}`);
  return {
    ...persisted.status,
    ...bootstrap,
  };
}

export async function login(params: {
  profileName: string;
  issuer?: string;
  clientId?: string;
  reporter: TaskReporter;
  registrationMode?: RegistrationMode;
  desiredLinkedEmailVisibility?: boolean;
  desiredPublicDescription?: string;
  confirmAgentRegistration?: ConfirmRegistrationPrompt;
  confirmDefaultSlug?: ConfirmDefaultSlugPrompt;
  confirmLinkedEmailVisibility?: ConfirmLinkedEmailPrompt;
  confirmPublicDescription?: ConfirmPublicDescriptionPrompt;
  pauseAfterRegistrationBlocked?: PauseHandler;
  waitForEnter?: (url: string) => Promise<void>;
  openBrowser?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  secretStore?: SecretStore;
  debug?: boolean;
}): Promise<AuthenticatedInboxResult> {
  const prepared = await prepareDeviceLogin(params);
  const waitForEnter = params.waitForEnter ?? defaultWaitForEnter;
  const openBrowser = params.openBrowser ?? defaultOpenBrowser;
  const verificationUrl = chooseVerificationUrl(prepared.challenge);
  const debug = createOidcDebugLogger(params.reporter, params.debug);

  debug?.(`Verification URL chosen for the browser step: ${verificationUrl}`);

  if (params.reporter.waitForKeypress) {
    await params.reporter.waitForKeypress('Press Enter to open browser');
  } else {
    await waitForEnter(verificationUrl);
  }

  params.reporter.verbose?.('Opening browser for device authorization');
  const opened = await openBrowser(verificationUrl);
  if (opened) {
    params.reporter.success('Browser opened');
  } else {
    params.reporter.info(`Open this URL manually: ${verificationUrl}`);
  }
  debug?.('Browser step completed; waiting for remote approval and token polling.');

  params.reporter.info('Waiting for authorization...');

  const showCountdown =
    Boolean(params.reporter.setBanner) && Boolean(process.stdout.isTTY && process.stderr.isTTY);

  let countdownInterval: NodeJS.Timeout | undefined;
  let shouldContinueCountdown = true;
  if (showCountdown) {
    countdownInterval = setInterval(() => {
      if (!shouldContinueCountdown) {
        return;
      }
      const remainingMs = prepared.challenge.expiresAt - Date.now();
      const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      params.reporter.setBanner?.({
        code: prepared.pendingResult.deviceCode,
        label: 'Device code',
        verificationUri: verificationUrl,
        hint:
          `Enter this device code in browser: ${verificationUrl}\n` +
          `Expires in ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}. ` +
          'Press [C] to copy URL · [U] to copy device code.',
      });
    }, 1000);
  }

  try {
    const session = await waitForDeviceAuthorization({
      metadata: prepared.metadata,
      clientId: prepared.profile.clientId,
      deviceCode: prepared.challenge.deviceCode,
      intervalSeconds: prepared.challenge.intervalSeconds,
      expiresAt: prepared.challenge.expiresAt,
      sleep: params.sleep,
      debug,
    });

    const persisted = await persistDeviceSession({
      profile: prepared.profile,
      session,
      secretStore: params.secretStore,
      reporter: params.reporter,
    });

    // Prevent any late setInterval tick from re-setting the banner after auth succeeds.
    shouldContinueCountdown = false;

    // Stop countdown immediately after authorization.
    // Otherwise, the interval keeps re-setting the banner during bootstrap.
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = undefined;
    }

    params.reporter.clearBanner?.();
    params.reporter.verbose?.('Bootstrapping inbox after authentication');
    const bootstrap = await bootstrapAuthenticatedInbox({
      profile: persisted.profile,
      session,
      claims: persisted.claims,
      reporter: params.reporter,
      registrationMode: params.registrationMode,
      desiredLinkedEmailVisibility: params.desiredLinkedEmailVisibility,
      desiredPublicDescription: params.desiredPublicDescription,
      confirmAgentRegistration: params.confirmAgentRegistration,
      confirmDefaultSlug: params.confirmDefaultSlug,
      confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
      confirmPublicDescription: params.confirmPublicDescription,
      pauseAfterRegistrationBlocked: params.pauseAfterRegistrationBlocked,
      secretStore: params.secretStore,
    });

    params.reporter.success(`Authenticated ${persisted.status.email ?? persisted.status.subject ?? persisted.profile.name}`);
    return {
      ...persisted.status,
      ...bootstrap,
    };
  } finally {
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
  }
}

export async function ensureAuthenticatedSession(params: {
  profileName: string;
  reporter?: TaskReporter;
  secretStore?: SecretStore;
}): Promise<AuthSessionContext> {
  let profile = await loadProfile(params.profileName);
  const secretStore = params.secretStore ?? defaultSecretStore();
  let storedSession: StoredOidcSession | null;
  try {
    storedSession = await secretStore.getOidcSession(profile.name);
  } catch (error) {
    if (error instanceof SyntaxError) {
      await secretStore.deleteOidcSession(profile.name);
      throw invalidLocalSessionError(error);
    }
    throw error;
  }

  if (!storedSession) {
    throw userError(
      'No local OIDC session found. Run `masumi-agent-messenger account login` in an interactive terminal, or use `masumi-agent-messenger account login start` / `masumi-agent-messenger account login complete --polling-code <polling-code>` in automation.',
      {
        code: 'AUTH_REQUIRED',
      }
    );
  }
  if (!isStoredOidcSession(storedSession)) {
    await secretStore.deleteOidcSession(profile.name);
    throw invalidLocalSessionError();
  }

  let session = storedSession;
  let claims: IdTokenClaims;
  let metadata: OidcMetadata;
  let refreshedSession = false;
  try {
    metadata = await discoverOidcMetadata(profile.issuer);
    claims = await validateOidcIdToken(session.idToken, metadata, {
      clientId: profile.clientId,
      allowExpired: true,
    });
  } catch (error) {
    if (isOidcIdTokenError(error)) {
      await secretStore.deleteOidcSession(profile.name);
      throw invalidLocalSessionError(error);
    }
    throw error;
  }
  session = {
    ...session,
    expiresAt: claims.expiresAt,
  };

  if (sessionNeedsRefresh(session)) {
    params.reporter?.info('Refreshing OIDC session');
    let refreshed: StoredOidcSession | null;
    try {
      refreshed = await refreshStoredSession({
        session,
        metadata,
        clientId: profile.clientId,
      });
    } catch (error) {
      if (isAuthRequiredError(error)) {
        await secretStore.deleteOidcSession(profile.name);
      }
      throw error;
    }

    if (!refreshed) {
      await secretStore.deleteOidcSession(profile.name);
      throw userError(
        'OIDC session expired. Run `masumi-agent-messenger account login` in an interactive terminal, or use `masumi-agent-messenger account login start` / `masumi-agent-messenger account login complete --polling-code <polling-code>` in automation.',
        {
          code: 'AUTH_REQUIRED',
        }
      );
    }

    await secretStore.setOidcSession(profile.name, refreshed);
    session = refreshed;
    refreshedSession = true;
    try {
      claims = decodeIdTokenClaims(session.idToken);
    } catch (error) {
      if (isOidcIdTokenError(error)) {
        await secretStore.deleteOidcSession(profile.name);
        throw invalidLocalSessionError(error);
      }
      throw error;
    }
  }

  const prepared = await prepareProfileForAuthenticatedAccount({
    profile,
    claims,
    secretStore,
    reporter: params.reporter,
    previousSession: storedSession,
  });
  profile = prepared.profile;

  if (refreshedSession || prepared.switchedAccount) {
    profile = await persistAuthenticatedProfile(profile.name, profile, session);
    if (refreshedSession) {
      params.reporter?.success('OIDC session refreshed');
    }
  }

  return {
    profile,
    session,
    claims,
  };
}

export async function authStatus(params: {
  profileName: string;
  reporter?: TaskReporter;
  secretStore?: SecretStore;
}): Promise<AuthStatusResult> {
  const profile = await loadProfile(params.profileName);

  try {
    const { session, claims, profile: ensuredProfile } = await ensureAuthenticatedSession(params);
    return toAuthStatus(ensuredProfile, session, claims);
  } catch (error) {
    if (isAuthRequiredError(error)) {
      return toAuthStatus(profile, null, null);
    }
    throw error;
  }
}

export async function requestVerificationEmailForIssuer(params: {
  profileName: string;
  issuer?: string;
  email: string;
  callbackURL?: string;
  reporter: TaskReporter;
}): Promise<VerificationEmailRequestResult> {
  const profile = await loadProfile(params.profileName, toProfileOverrides(params));

  params.reporter.verbose?.(`Discovering OIDC issuer ${profile.issuer}`);
  const metadata = await discoverOidcMetadata(profile.issuer);
  params.reporter.verbose?.(`OIDC issuer ready: ${metadata.issuer}`);
  params.reporter.info(`Requesting verification email for ${params.email}`);

  await requestVerificationEmail({
    metadata,
    email: params.email,
    callbackURL: params.callbackURL,
  });

  params.reporter.success('Verification email requested');

  return {
    sent: true,
    email: params.email,
    issuer: metadata.issuer,
    callbackURL: params.callbackURL,
  };
}

export async function logout(params: {
  profileName: string;
  reporter?: TaskReporter;
  secretStore?: SecretStore;
}): Promise<{
  authenticated: false;
  cleared: true;
  profile: string;
}> {
  const profile = await loadProfile(params.profileName);
  const secretStore = params.secretStore ?? defaultSecretStore();

  params.reporter?.verbose?.('Clearing local OIDC session');
  await secretStore.deleteOidcSession(profile.name);
  params.reporter?.success('Local auth session cleared');

  return {
    authenticated: false,
    cleared: true,
    profile: profile.name,
  };
}

export async function removeLocalKeys(params: {
  profileName: string;
  reporter?: TaskReporter;
  secretStore?: SecretStore;
}): Promise<{
  authenticated: false;
  removedKeys: true;
  clearedProfileState: true;
  profile: string;
}> {
  const profile = await loadProfile(params.profileName);
  const secretStore = params.secretStore ?? defaultSecretStore();

  params.reporter?.verbose?.('Clearing local agent key bundle');
  await secretStore.deleteAgentKeyPair(profile.name);
  params.reporter?.verbose?.('Clearing local device key bundle');
  await secretStore.deleteDeviceKeyMaterial(profile.name);
  params.reporter?.verbose?.('Clearing local namespace key vault');
  await secretStore.deleteNamespaceKeyVault(profile.name);

  params.reporter?.verbose?.('Clearing stored profile bootstrap state');
  await clearProfileState(profile.name);

  params.reporter?.verbose?.('Signing out after key removal');
  await secretStore.deleteOidcSession(profile.name);

  params.reporter?.success('Local keys removed');

  return {
    authenticated: false,
    removedKeys: true,
    clearedProfileState: true,
    profile: profile.name,
  };
}
