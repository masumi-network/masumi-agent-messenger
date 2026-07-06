import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentKeyPair } from '../../shared/agent-crypto';
import { createEmptyMasumiRegistrationResult } from '../../shared/inbox-agent-registration';
import type {
  AuthStatusResult,
  AuthenticatedInboxResult,
  PendingDeviceLoginResult,
} from './services/auth';
import { DEFAULT_SPACETIMEDB_DB_NAME } from './services/config-store';
import type { NamespaceKeyVault } from './services/secret-store';

type CliPackageJson = {
  version: string;
  bin: Record<string, string>;
};

const requirePackageJson = createRequire(import.meta.url);

function readCliPackageJson(): CliPackageJson {
  return requirePackageJson('../package.json') as CliPackageJson;
}

function makeAuthStatus(
  overrides: Partial<AuthStatusResult> = {}
): AuthStatusResult {
  return {
    authenticated: false,
    expiresAt: null,
    issuer: null,
    email: null,
    subject: null,
    grantedScopes: [],
    profile: 'default',
    ...overrides,
  };
}

function makeAgentKeyPair(label: string): AgentKeyPair {
  return {
    encryption: {
      publicKey: `${label}-enc-public`,
      privateKey: `${label}-enc-private`,
      keyVersion: 1,
      algorithm: 'EcdhP256AesGcm256V1',
    },
    signing: {
      publicKey: `${label}-sig-public`,
      privateKey: `${label}-sig-private`,
      keyVersion: 1,
      algorithm: 'EcdsaP256Sha256V1',
    },
  };
}

function makeOwnedAgentImportSummary() {
  return {
    checked: 0,
    imported: 0,
    synced: 0,
    present: 0,
    missing: 0,
    skipped: 0,
    warnings: [],
    successes: [],
    items: [],
  };
}

function makeAuthenticatedInboxResult(
  overrides: Partial<AuthenticatedInboxResult> = {}
): AuthenticatedInboxResult {
  return {
    authenticated: true,
    expiresAt: null,
    issuer: 'https://issuer.example',
    email: 'agent@example.com',
    subject: 'subject-1',
    grantedScopes: ['openid', 'email'],
    connected: true,
    bootstrapped: true,
    inbox: {
      id: '1',
      email: 'agent@example.com',
    },
    actor: {
      id: '1',
      slug: 'agent',
      publicIdentity: 'agent',
      displayName: 'Agent',
    },
    agentRegistration: createEmptyMasumiRegistrationResult(),
    ownedAgentImport: makeOwnedAgentImportSummary(),
    deviceId: 'device-1',
    localKeysReady: true,
    keySource: 'existing_local',
    recoveryRequired: false,
    recoveryReason: null,
    recoveryOptions: [],
    spacetimeIdentity: '0xabc',
    profile: 'default',
    ...overrides,
  };
}

function makePendingDeviceLoginResult(
  overrides: Partial<PendingDeviceLoginResult> = {}
): PendingDeviceLoginResult {
  return {
    authenticated: false,
    pending: true,
    profile: 'default',
    issuer: 'https://issuer.example',
    clientId: 'masumi-spacetime-cli',
    requestedScopes: ['openid', 'email'],
    deviceCode: 'ABCD-EFGH',
    pollingCode: 'polling-code-1',
    verificationUri: 'https://issuer.example/device?user_code=ABCD-EFGH',
    expiresAt: new Date('2026-04-15T10:00:00.000Z').toISOString(),
    intervalSeconds: 5,
    agentRegistration: createEmptyMasumiRegistrationResult(),
    ...overrides,
  };
}

function setInteractiveTty(value: boolean): () => void {
  return setTtyStreams({
    stdin: value,
    stdout: value,
    stderr: value,
  });
}

function setTtyStreams(values: {
  stdin: boolean;
  stdout: boolean;
  stderr: boolean;
}): () => void {
  const streams = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const descriptors = {
    stdin: Object.getOwnPropertyDescriptor(streams.stdin, 'isTTY'),
    stdout: Object.getOwnPropertyDescriptor(streams.stdout, 'isTTY'),
    stderr: Object.getOwnPropertyDescriptor(streams.stderr, 'isTTY'),
  };

  Object.defineProperty(streams.stdin, 'isTTY', {
    configurable: true,
    value: values.stdin,
  });
  Object.defineProperty(streams.stdout, 'isTTY', {
    configurable: true,
    value: values.stdout,
  });
  Object.defineProperty(streams.stderr, 'isTTY', {
    configurable: true,
    value: values.stderr,
  });

  return () => {
    for (const key of ['stdin', 'stdout', 'stderr'] as const) {
      const descriptor = descriptors[key];
      if (descriptor) {
        Object.defineProperty(streams[key], 'isTTY', descriptor);
      } else {
        delete (streams[key] as { isTTY?: boolean }).isTTY;
      }
    }
  };
}

async function loadProgramWithMocks(params: {
  authStatusResult?: AuthStatusResult;
  loginResult?: AuthenticatedInboxResult | PendingDeviceLoginResult;
  waitResult?: AuthenticatedInboxResult;
} = {}) {
  vi.resetModules();

  const runRootShell = vi.fn(async () => {});
  const runCommandAction = vi.fn(async (action: {
    run: (context: {
      reporter: {
        info(text: string): void;
        success(text: string): void;
        verbose(text: string): void;
        setBanner(): void;
        clearBanner(): void;
        waitForKeypress(message: string): Promise<void>;
      };
    }) => Promise<unknown>;
  }) =>
    action.run({
      reporter: {
        info() {},
        success() {},
        verbose() {},
        setBanner() {},
        clearBanner() {},
        waitForKeypress: async () => {},
      },
    })
  );

  const authStatus = vi.fn(async () => params.authStatusResult ?? makeAuthStatus());
  const login = vi.fn(async () => params.loginResult ?? makeAuthenticatedInboxResult());
  const startLogin = vi.fn(async () => makePendingDeviceLoginResult());
  const waitForLogin = vi.fn(async () => params.waitResult ?? makeAuthenticatedInboxResult());
  const bootstrapInbox = vi.fn(async () => makeAuthenticatedInboxResult());
  const inboxStatus = vi.fn(async () => ({
    authenticated: true,
    connected: true,
    inbox: {
      id: '1',
      email: 'agent@example.com',
    },
    actor: {
      id: '1',
      slug: 'agent',
      publicIdentity: 'agent',
      displayName: 'Agent',
    },
    agentRegistration: createEmptyMasumiRegistrationResult(),
    keyVersions: {
      encryption: 1,
      signing: 1,
    },
    profile: 'default',
  }));
  const promptText = vi.fn(async (input: { defaultValue?: string }) => input.defaultValue ?? 'prompt-value');
  const promptMultiline = vi.fn(async () => '');
  const promptSecret = vi.fn(async () => 'secret');
  const confirmYesNo = vi.fn(async () => true);
  const promptChoice = vi.fn(async (input: { defaultValue?: string }) => input.defaultValue ?? 'device_share');
  const waitForEnterMessage = vi.fn(async () => {});
  const logout = vi.fn(async () => ({
    authenticated: false as const,
    cleared: true as const,
    profile: 'default',
  }));
  const removeLocalKeys = vi.fn(async () => ({
    profile: 'default',
    removedAgentKeys: 1,
    removedNamespaceVault: true,
    removedDeviceKeyMaterial: true,
  }));
  const listDevices = vi.fn(async () => ({
    profile: 'default',
    devices: [],
  }));
  const ensureAuthenticatedSession = vi.fn(async () => ({
    profile: {
      name: 'default',
      spacetimeHost: 'ws://localhost:3000',
      spacetimeDbName: 'agentmessenger-dev',
    },
    session: {
      idToken: 'id-token',
    },
  }));
  const requestVerificationEmailForIssuer = vi.fn(async () => ({
    sent: true as const,
    email: 'agent@example.com',
    issuer: 'https://issuer.example',
    callbackURL: null,
  }));

  const createAgent = vi.fn(async () => ({
    profile: 'default',
    actor: {
      id: '2',
      slug: 'support-bot',
      publicIdentity: 'support-bot',
      displayName: 'Support Bot',
      keyVersions: {
        encryption: 1,
        signing: 1,
      },
    },
    registration: createEmptyMasumiRegistrationResult(),
  }));
  const syncOwnedSaasInboxAgents = vi.fn(async () => ({
    profile: 'default',
    import: makeOwnedAgentImportSummary(),
  }));
  const rotateInboxKeys = vi.fn(async (input: {
    actorSlug?: string;
    shareDeviceIds?: string[];
    revokeDeviceIds?: string[];
  }) => ({
    profile: 'default',
    actor: {
      slug: input.actorSlug ?? 'agent',
    },
    sharedDeviceIds: input.shareDeviceIds ?? [],
    revokedDeviceIds: input.revokeDeviceIds ?? [],
  }));
  const resolveRotationDeviceSelection = vi.fn(async (input: {
    explicitShareDeviceIds?: string[];
    explicitRevokeDeviceIds?: string[];
  }) => ({
    shareDeviceIds: input.explicitShareDeviceIds ?? [],
    revokeDeviceIds: input.explicitRevokeDeviceIds ?? [],
  }));

  const resolvePreferredAgentSlug = vi.fn(
    async (_profileName: string, explicitAgentSlug?: string | null) =>
      explicitAgentSlug ?? 'agent'
  );
  const useOwnedAgent = vi.fn(async ({ actorSlug }: { actorSlug: string }) => ({
    profile: 'default',
    activeAgentSlug: actorSlug,
    agent: {
      slug: actorSlug,
      publicIdentity: actorSlug,
      managed: true,
    },
  }));
  const listOwnedAgents = vi.fn(async () => ({
    profile: 'default',
    activeAgentSlug: 'agent',
    agents: [],
  }));
  const getOwnedAgentProfile = vi.fn(async () => ({
    profile: 'default',
    activeAgentSlug: 'agent',
    agent: {
      slug: 'agent',
      displayName: 'Agent',
      publicIdentity: 'agent',
      isDefault: true,
      isActive: true,
      managed: true,
      verified: true,
      publicDescription: null,
      publicLinkedEmailEnabled: false,
      registrationNetwork: null,
      agentIdentifier: null,
      registrationState: null,
      messageCapabilities: {
        allowAllContentTypes: true,
        allowAllHeaders: true,
        supportedContentTypes: [],
        supportedHeaders: [],
      },
    },
  }));
  const updateOwnedAgentProfile = vi.fn(async () => ({
    profile: 'default',
    activeAgentSlug: 'agent',
    agent: {
      slug: 'agent',
      displayName: 'Agent',
      publicDescription: null,
      publicLinkedEmailEnabled: false,
    },
  }));
  const updateOwnedAgentMessageCapabilities = vi.fn(async () => ({
    profile: 'default',
    activeAgentSlug: 'agent',
    agent: {
      slug: 'agent',
      messageCapabilities: {
        allowAllContentTypes: true,
        allowAllHeaders: true,
        supportedContentTypes: [],
        supportedHeaders: [],
      },
    },
  }));

  const sendMessageToSlug = vi.fn(async (input: { to: string; message: string }) => ({
    sent: true as const,
    approvalRequired: false,
    profile: 'default',
    selectionMode: 'latest' as const,
    to: {
      slug: input.to,
      publicIdentity: input.to,
      displayName: 'Support Bot',
    },
    threadId: '42',
    messageId: '100',
    createdDirectThread: true,
    targetLookup: {
      input: input.to,
      inputKind: 'slug' as const,
      matchedActors: [],
      selected: {
        slug: input.to,
        publicIdentity: input.to,
        displayName: 'Support Bot',
        isDefault: true,
      },
    },
  }));
  const sendMessageToThread = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '42',
    label: 'Support Bot',
    messageId: '100',
  }));
  const countThreadMessages = vi.fn(async (input: { threadId: string; actorSlug?: string }) => ({
    authenticated: true as const,
    connected: true as const,
    profile: 'default',
    actorSlug: input.actorSlug ?? 'agent',
    thread: {
      id: input.threadId,
      kind: { tag: 'Group' as const },
      label: 'Support Group',
      locked: false,
      archived: false,
      participantCount: 2,
      participants: ['agent', 'support-bot'],
    },
    messageCount: 7,
    lastMessageAt: '2026-04-15T10:00:00.000Z',
  }));
  const listThreads = vi.fn(async () => ({
    authenticated: true as const,
    connected: true as const,
    profile: 'default',
    actorSlug: 'agent',
    includeArchived: false,
    totalThreads: 0,
    threads: [],
  }));
  const readThreadHistory = vi.fn(async () => ({
    authenticated: true as const,
    connected: true as const,
    profile: 'default',
    actorSlug: 'agent',
    thread: {
      id: '42',
      kind: { tag: 'Direct' as const },
      label: 'Support Bot',
      locked: false,
      archived: false,
    },
    lastReadMessageId: '0',
    totalMessages: 0,
    messages: [],
  }));
  const paginateThreadHistory = vi.fn(
    (history: Awaited<ReturnType<typeof readThreadHistory>>) => ({
      ...history,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      hasPrevious: false,
      hasNext: false,
      nextPage: null,
      previousPage: null,
    })
  );
  const createDirectThread = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '42',
    label: 'Support Bot',
    kind: { tag: 'Direct' as const } as const,
    locked: false,
    participants: ['agent', 'support-bot'],
    invitedParticipants: [],
  }));
  const createGroupThread = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '43',
    label: 'Support Group',
    kind: { tag: 'Group' as const } as const,
    locked: false,
    participants: ['agent', 'support-bot'],
    invitedParticipants: [],
  }));
  const addThreadParticipant = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '43',
    label: 'Support Group',
    participant: 'support-bot',
    action: 'added' as const,
    participants: ['agent', 'support-bot'],
    invitedParticipants: [],
  }));
  const removeThreadParticipant = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '43',
    label: 'Support Group',
    participant: 'support-bot',
    action: 'removed' as const,
    participants: ['agent'],
    invitedParticipants: [],
  }));
  const markThreadRead = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '42',
    label: 'Support Bot',
    throughMessageId: '7',
  }));
  const setThreadArchived = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '42',
    label: 'Support Bot',
    archived: true,
  }));
  const deleteThread = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '42',
    label: 'Support Bot',
  }));

  const resolveContactRequest = vi.fn(async (input: { requestId: string; action: string }) => ({
    profile: 'default',
    requestId: input.requestId,
    action: input.action,
    slug: 'support-bot',
  }));
  const resolveThreadInvite = vi.fn(async (input: { inviteId: string; action: string }) => ({
    profile: 'default',
    inviteId: input.inviteId,
    action: input.action,
    slug: 'support-bot',
    threadId: '42',
  }));
  const listContactRequests = vi.fn(async () => ({
    profile: 'default',
    slug: 'agent',
    total: 0,
    requests: [],
  }));
  const listThreadInvites = vi.fn(async () => ({
    profile: 'default',
    slug: 'agent',
    total: 0,
    invites: [],
  }));
  const listContactAllowlist = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    total: 0,
    entries: [],
  }));
  const addContactAllowlist = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    kind: { tag: 'Agent' as const },
    value: 'support-bot',
  }));
  const removeContactAllowlist = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    kind: { tag: 'Agent' as const },
    value: 'support-bot',
  }));

  const discoverAgents = vi.fn(async (input: { query?: string }) => ({
    profile: 'default',
    agentSlug: 'agent',
    query: input.query ?? null,
    total: 0,
    results: [],
  }));
  const showDiscoveredAgent = vi.fn(async (input: { identifier: string }) => ({
    profile: 'default',
    agentSlug: 'agent',
    identifier: input.identifier,
    matchedActors: [
      {
        slug: 'support-bot',
        displayName: 'Support Bot',
        publicIdentity: 'support-bot',
        isDefault: true,
        agentIdentifier: null,
      },
    ],
    selected: {
      slug: 'support-bot',
      displayName: 'Support Bot',
      publicIdentity: 'support-bot',
      isDefault: true,
      agentIdentifier: null,
      encryptionKeyVersion: 1,
      signingKeyVersion: 1,
    },
    publicRoute: {
      agentIdentifier: null,
      linkedEmail: null,
      description: 'Support agent',
      encryptionKeyVersion: 1,
      signingKeyVersion: 1,
      allowAllContentTypes: true,
      allowAllHeaders: true,
      supportedContentTypes: [],
      supportedHeaders: [],
      contactPolicy: {
        mode: 'approval_required',
        allowlistScope: 'agent',
        allowlistKinds: ['agent'],
        messagePreviewVisibleBeforeApproval: false,
      },
    },
  }));
  const listDiscoverableChannels = vi.fn(async () => ({
    profile: 'default',
    channels: [],
  }));
  const showPublicChannel = vi.fn(async () => ({
    profile: 'default',
    channel: null,
  }));
  const readPublicChannelMessages = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    anonymous: true,
    cappedToRecent: true,
    messages: [],
  }));
  const readAuthenticatedChannelMessages = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    anonymous: false,
    cappedToRecent: false,
    messages: [],
  }));
  const listChannelMembers = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    members: [],
  }));
  const createChannel = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    status: 'created',
  }));
  const updateChannelSettings = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    channelId: '1',
    status: 'settings-updated',
  }));
  const joinPublicChannel = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    status: 'joined',
  }));
  const requestChannelJoin = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    status: 'requested',
  }));
  const listChannelJoinRequests = vi.fn(async () => ({
    profile: 'default',
    requests: [],
  }));
  const approveChannelJoin = vi.fn(async (_input: { requestId: string }) => ({
    profile: 'default',
    channelId: '1',
    status: { tag: 'Approved' as const },
  }));
  const rejectChannelJoin = vi.fn(async () => ({
    profile: 'default',
    status: { tag: 'Rejected' as const },
  }));
  const updateChannelMemberPermission = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    channelId: '1',
    status: 'permission-updated',
  }));
  const removeChannelMember = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    channelId: '1',
    status: 'member-removed',
  }));
  const sendChannelMessage = vi.fn(async (input: { slug: string }) => ({
    profile: 'default',
    slug: input.slug,
    channelId: '1',
    status: 'sent',
  }));
  const lookupPublishedAgentBySlug = vi.fn(async (input: { slug: string }) => [
    {
      slug: input.slug,
      publicIdentity: `${input.slug}:public-identity`,
      isDefault: true,
      displayName: 'Support Bot',
      encryptionKeyVersion: 1,
      encryptionPublicKey: 'enc-public-key',
      signingKeyVersion: 1,
      signingPublicKey: 'sig-public-key',
    },
  ]);
  const lookupPublishedAgentsByEmailPage = vi.fn(async () => []);
  const connectAuthenticated = vi.fn(async () => ({
    conn: {
      procedures: {
        lookupPublishedAgentBySlug,
        lookupPublishedAgentsByEmailPage,
      },
    },
    identityHex: '0xabc',
  }));
  const connectAnonymous = vi.fn(async () => ({
    conn: {},
    identityHex: '0xanonymous',
  }));
  const disconnectConnection = vi.fn();
  const getAgentKeyPair = vi.fn(async () => null);
  const getNamespaceKeyVault = vi.fn(async () => null);
  const getDeviceKeyMaterial = vi.fn(async () => null);
  const createSecretStore = vi.fn(() => ({
    getAgentKeyPair,
    getNamespaceKeyVault,
    getDeviceKeyMaterial,
  }));
  const confirmPeerKeyRotation = vi.fn(async () => {});
  const autoPinPeerIfUnknown = vi.fn(async () => ({ status: 'matches' as const }));
  const comparePinnedPeer = vi.fn(async () => ({ status: 'matches' as const }));
  const isInboundSignatureTrusted = vi.fn(async () => true);
  const listTrustedPeers = vi.fn(async () => []);
  const loadPeerKeyTrustStore = vi.fn(async () => ({
    version: 1 as const,
    peers: {},
  }));
  const unpinPeerKeys = vi.fn(async () => true);
  const confirmCurrentImportedRotationKey = vi.fn(async () => ({
    profile: 'default',
    slug: 'support-bot',
    publicIdentity: 'support-bot:public-identity',
    previousStatus: 'pending' as const,
    confirmedAt: '2026-04-18T00:00:00.000Z',
    encryptionKeyVersion: 1,
    signingKeyVersion: 1,
  }));

  vi.doMock('./services/command-runtime', () => ({
    runCommandAction,
  }));

  vi.doMock('./services/prompts', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/prompts')>();
    return {
      ...actual,
      confirmYesNo,
      promptChoice,
      promptMultiline,
      promptSecret,
      promptText,
      waitForEnterMessage,
    };
  });

  vi.doMock('./commands/root-shell', () => ({
    runRootShell,
  }));

  vi.doMock('./services/auth', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/auth')>();
    return {
      ...actual,
      authStatus,
      login,
      startLogin,
      waitForLogin,
      logout,
      removeLocalKeys,
      ensureAuthenticatedSession,
      requestVerificationEmailForIssuer,
    };
  });

  vi.doMock('./services/inbox', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/inbox')>();
    return {
      ...actual,
      bootstrapInbox,
      inboxStatus,
    };
  });

  vi.doMock('./services/imported-rotation-key-confirmation', () => ({
    confirmCurrentImportedRotationKey,
  }));

  vi.doMock('./services/device', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/device')>();
    return {
      ...actual,
      listDevices,
    };
  });

  vi.doMock('./services/spacetimedb', () => ({
    connectAnonymous,
    connectAuthenticated,
    disconnectConnection,
  }));

  vi.doMock('./services/secret-store', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/secret-store')>();
    return {
      ...actual,
      createSecretStore,
    };
  });

  vi.doMock('./services/peer-key-trust', () => ({
    autoPinPeerIfUnknown,
    comparePinnedPeer,
    confirmPeerKeyRotation,
    isInboundSignatureTrusted,
    listTrustedPeers,
    loadPeerKeyTrustStore,
    unpinPeerKeys,
  }));

  vi.doMock('./services/inbox-management', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/inbox-management')>();
    return {
      ...actual,
      createAgent,
      syncOwnedSaasInboxAgents,
      rotateInboxKeys,
    };
  });

  vi.doMock('./services/key-rotation-device-selection', () => ({
    resolveRotationDeviceSelection,
  }));

  vi.doMock('./services/agent-state', () => ({
    resolvePreferredAgentSlug,
    useOwnedAgent,
    listOwnedAgents,
    getOwnedAgentProfile,
    updateOwnedAgentProfile,
    updateOwnedAgentMessageCapabilities,
  }));

  vi.doMock('./services/send-message', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/send-message')>();
    return {
      ...actual,
      sendMessageToSlug,
      sendMessageToThread,
    };
  });

  vi.doMock('./services/thread', () => ({
    addThreadParticipant,
    countThreadMessages,
    createDirectThread,
    createGroupThread,
    deleteThread,
    listThreads,
    markThreadRead,
    paginateThreadHistory,
    readThreadHistory,
    removeThreadParticipant,
    setThreadArchived,
  }));

  vi.doMock('./services/contact-management', async importOriginal => {
    const actual = await importOriginal<typeof import('./services/contact-management')>();
    return {
      ...actual,
      resolveContactRequest,
      resolveThreadInvite,
      listContactRequests,
      listThreadInvites,
      listContactAllowlist,
      addContactAllowlist,
      removeContactAllowlist,
    };
  });

  vi.doMock('./services/discover', () => ({
    discoverAgents,
    showDiscoveredAgent,
  }));

  vi.doMock('./services/channel', () => ({
    approveChannelJoin,
    createChannel,
    updateChannelSettings,
    joinPublicChannel,
    listChannelJoinRequests,
    listChannelMembers,
    listDiscoverableChannels,
    showPublicChannel,
    readAuthenticatedChannelMessages,
    readPublicChannelMessages,
    rejectChannelJoin,
    removeChannelMember,
    requestChannelJoin,
    sendChannelMessage,
    updateChannelMemberPermission,
  }));

  const programModule = await import('./program');
  return {
    buildProgram: programModule.buildProgram,
    mocks: {
      runRootShell,
      runCommandAction,
      authStatus,
      login,
      startLogin,
      waitForLogin,
      bootstrapInbox,
      inboxStatus,
      promptText,
      promptMultiline,
      promptSecret,
      confirmYesNo,
      promptChoice,
      waitForEnterMessage,
      logout,
      removeLocalKeys,
      listDevices,
      ensureAuthenticatedSession,
      requestVerificationEmailForIssuer,
      createAgent,
      syncOwnedSaasInboxAgents,
      rotateInboxKeys,
      resolveRotationDeviceSelection,
      resolvePreferredAgentSlug,
      useOwnedAgent,
      listOwnedAgents,
      getOwnedAgentProfile,
      updateOwnedAgentMessageCapabilities,
      countThreadMessages,
      listThreads,
      sendMessageToSlug,
      sendMessageToThread,
      resolveContactRequest,
      resolveThreadInvite,
      listThreadInvites,
      listContactAllowlist,
      addContactAllowlist,
      removeContactAllowlist,
      discoverAgents,
      showDiscoveredAgent,
      listDiscoverableChannels,
      showPublicChannel,
      readPublicChannelMessages,
      readAuthenticatedChannelMessages,
      listChannelMembers,
      createChannel,
      updateChannelSettings,
      joinPublicChannel,
      requestChannelJoin,
      listChannelJoinRequests,
      approveChannelJoin,
      rejectChannelJoin,
      updateChannelMemberPermission,
      removeChannelMember,
      sendChannelMessage,
      lookupPublishedAgentBySlug,
      lookupPublishedAgentsByEmailPage,
      connectAnonymous,
      connectAuthenticated,
      disconnectConnection,
      createSecretStore,
      getAgentKeyPair,
      getNamespaceKeyVault,
      getDeviceKeyMaterial,
      autoPinPeerIfUnknown,
      comparePinnedPeer,
      confirmPeerKeyRotation,
      isInboundSignatureTrusted,
      listTrustedPeers,
      loadPeerKeyTrustStore,
      unpinPeerKeys,
      confirmCurrentImportedRotationKey,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('CLI help', () => {
  it('uses package metadata for the binary name and version', async () => {
    const { buildProgram } = await import('./program');
    const packageJson = readCliPackageJson();
    const binNames = Object.keys(packageJson.bin);
    const program = buildProgram();

    expect(binNames).toHaveLength(1);
    expect(program.name()).toBe(binNames[0]);
    expect(program.version()).toBe(packageJson.version);
  });

  it('supports lowercase -v for the version', async () => {
    const { runProgram } = await import('./program');
    const packageJson = readCliPackageJson();
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runProgram(['node', 'masumi-agent-messenger', '-v']);

    expect(stdoutWrite).toHaveBeenCalledWith(`${packageJson.version}\n`);
  });

  it('shows only the canonical top-level command families', async () => {
    const { buildProgram } = await import('./program');
    const help = buildProgram().helpInformation();

    expect(help).toContain('masumi-agent-messenger CLI for account, agent, thread, channel, and discovery');
    expect(help).toContain('workflows');
    expect(help).toContain('account');
    expect(help).toContain('agent');
    expect(help).toContain('thread');
    expect(help).toContain('channel');
    expect(help).toContain('discover');
    expect(help).not.toContain('\nauth');
    expect(help).not.toContain('\ninbox');
  });

  it('shows the account help', async () => {
    const { buildProgram } = await import('./program');
    const account = buildProgram().commands.find(command => command.name() === 'account');
    const help = account?.helpInformation() ?? '';

    expect(help).toContain('Authenticate interactively with a browser login URL/code');
    expect(help).toContain('verification');
    expect(help).toContain('device');
    expect(help).toContain('backup');
    expect(help).toContain('keys');
    expect(help).toContain('sync');
    expect(help).toContain('recover');
    expect(help).toContain('logout');
  });

  it('shows the agent help', async () => {
    const { buildProgram } = await import('./program');
    const agent = buildProgram().commands.find(command => command.name() === 'agent');
    const help = agent?.helpInformation() ?? '';

    expect(help).toContain('list');
    expect(help).toContain('create');
    expect(help).toContain('use');
    expect(help).toContain('show');
    expect(help).toContain('update');
    expect(help).toContain('message');
    expect(help).toContain('network');
    expect(help).toContain('allowlist');
    expect(help).toContain('trust');
    expect(help).toContain('key');
  });

  it('shows the thread help', async () => {
    const { buildProgram } = await import('./program');
    const thread = buildProgram().commands.find(command => command.name() === 'thread');
    const help = thread?.helpInformation() ?? '';

    expect(help).toContain('list');
    expect(help).toContain('show');
    expect(help).toContain('count');
    expect(help).toContain('unread');
    expect(help).toContain('start');
    expect(help).toContain('send');
    expect(help).toContain('reply');
    expect(help).toContain('group');
    expect(help).toContain('participant');
    expect(help).toContain('approval');
    expect(help).toContain('restore');
    expect(help).toContain('delete');
  });

  it('shows the discover help', async () => {
    const { buildProgram } = await import('./program');
    const discover = buildProgram().commands.find(command => command.name() === 'discover');
    const help = discover?.helpInformation() ?? '';

    expect(help).toContain('search');
    expect(help).toContain('show');
  });

  it('shows the channel help', async () => {
    const { buildProgram } = await import('./program');
    const channel = buildProgram().commands.find(command => command.name() === 'channel');
    const help = channel?.helpInformation() ?? '';

    expect(help).toContain('list');
    expect(help).toContain('show');
    expect(help).toContain('messages');
    expect(help).toContain('create');
    expect(help).not.toContain(' add ');
    expect(help).toContain('join');
    expect(help).toContain('request');
    expect(help).toContain('approvals');
    expect(help).toContain('send');
    expect(help).toContain('members');
  });
});

describe('CLI command parsing', () => {
  it('parses account login complete polling codes from --polling-code', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'account',
      'login',
      'complete',
      '--polling-code',
      'polling-123',
    ]);

    expect(mocks.waitForLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        pollingCode: 'polling-123',
        profileName: 'default',
      })
    );
  });

  it('parses account login start device-code flow', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'account',
      'login',
      'start',
    ]);

    expect(mocks.startLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
      })
    );
  });

  it('uses prompt registration for account login complete in an interactive TTY', async () => {
    const restoreTty = setInteractiveTty(true);

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks();

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'account',
        'login',
        'complete',
        '--polling-code',
        'polling-interactive',
      ]);

      expect(mocks.waitForLogin).toHaveBeenCalledWith(
        expect.objectContaining({
          pollingCode: 'polling-interactive',
          registrationMode: 'prompt',
        })
      );
    } finally {
      restoreTty();
    }
  });

  it('uses automatic account registration when stdin is not interactive', async () => {
    const restoreTty = setTtyStreams({
      stdin: false,
      stdout: true,
      stderr: true,
    });

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks();

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'account',
        'login',
        'complete',
        '--polling-code',
        'polling-noninteractive',
      ]);

      expect(mocks.waitForLogin).toHaveBeenCalledWith(
        expect.objectContaining({
          pollingCode: 'polling-noninteractive',
          registrationMode: 'auto',
        })
      );
    } finally {
      restoreTty();
    }
  });

  it('preserves automatic account registration with global flags', async () => {
    const restoreTty = setTtyStreams({
      stdin: false,
      stdout: true,
      stderr: true,
    });

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks();

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'account',
        'login',
        'complete',
        '--polling-code',
        'account-noninteractive',
      ]);

      expect(mocks.waitForLogin).toHaveBeenCalledWith(
        expect.objectContaining({
          pollingCode: 'account-noninteractive',
          registrationMode: 'auto',
        })
      );
    } finally {
      restoreTty();
    }
  });

  it('requires --polling-code for account login complete', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await expect(
      buildProgram().parseAsync(['node', 'masumi-agent-messenger', '--json', 'account', 'login', 'complete'])
    ).rejects.toMatchObject({
      message: 'Polling code is required.',
      code: 'POLLING_CODE_REQUIRED',
    });
    expect(mocks.waitForLogin).not.toHaveBeenCalled();
  });

  it('parses account status --live as the live inbox status replacement', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'account',
      'status',
      '--live',
      '--public-description',
      'Live status profile',
    ]);

    expect(mocks.inboxStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        registrationMode: 'auto',
        desiredLinkedEmailVisibility: true,
        desiredPublicDescription: 'Live status profile',
      })
    );
    expect(mocks.authStatus).not.toHaveBeenCalled();
  });

  it('returns an automation-safe login next action from account status JSON', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-agent-status-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks({
        authStatusResult: makeAuthStatus({ profile: 'ci' }),
      });

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'account',
        'status',
        '--profile',
        'ci',
        '--json',
      ]);

      await expect(mocks.runCommandAction.mock.results[0]?.value).resolves.toMatchObject({
        authenticated: false,
        profile: 'ci',
        readiness: {
          state: 'needs_login',
          readyForMessaging: false,
          missing: ['session'],
        },
        nextAction: 'masumi-agent-messenger account login start --profile ci --json',
      });
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns non-interactive recovery guidance from account status JSON', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-agent-status-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks({
        authStatusResult: makeAuthStatus({
          authenticated: true,
          email: 'agent@example.com',
          subject: 'subject-1',
        }),
      });

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'account',
        'status',
        '--json',
      ]);

      await expect(mocks.runCommandAction.mock.results[0]?.value).resolves.toMatchObject({
        authenticated: true,
        localKeysReady: false,
        recoveryRequired: true,
        recoveryReason: 'missing',
        recoveryOptions: ['device_share', 'backup_import', 'rotate'],
        readiness: {
          state: 'needs_key_recovery',
          readyForMessaging: false,
          missing: ['agent_key_pair', 'namespace_vault'],
          keyRecovery: {
            preferred: ['device_share', 'backup_import'],
            destructiveFallback: 'key_reset',
            resetLosesOldMessages: true,
          },
        },
        nextAction: 'masumi-agent-messenger account device request --json',
      });
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses active-agent namespace keys for account status readiness', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-agent-status-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { saveActiveAgentSlug } = await import('./services/config-store');
      await saveActiveAgentSlug('default', 'support-bot');

      const activeKeyPair = makeAgentKeyPair('support-bot');
      const namespaceVault: NamespaceKeyVault = {
        version: 1,
        email: 'agent@example.com',
        actors: [
          {
            identity: {
              email: 'agent@example.com',
              slug: 'support-bot',
            },
            current: activeKeyPair,
            archived: [],
          },
        ],
      };

      const { buildProgram, mocks } = await loadProgramWithMocks({
        authStatusResult: makeAuthStatus({
          authenticated: true,
          email: 'agent@example.com',
          subject: 'subject-1',
        }),
      });
      mocks.getNamespaceKeyVault.mockResolvedValue(namespaceVault as never);

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'account',
        'status',
        '--json',
      ]);

      await expect(mocks.runCommandAction.mock.results[0]?.value).resolves.toMatchObject({
        authenticated: true,
        activeAgentSlug: 'support-bot',
        localKeysReady: true,
        recoveryRequired: false,
        recoveryReason: null,
        recoveryOptions: [],
        readiness: {
          state: 'ready',
          readyForMessaging: true,
          missing: [],
        },
        nextAction: 'masumi-agent-messenger thread list --agent support-bot --json',
      });
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves account sync display-name bootstrap input', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'account',
      'sync',
      '--display-name',
      'Default Agent',
    ]);

    expect(mocks.bootstrapInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        displayName: 'Default Agent',
        registrationMode: 'auto',
      })
    );
  });

  it('preserves the interactive account sync default slug prompt', async () => {
    const restoreTty = setInteractiveTty(true);

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks();

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'account',
        'sync',
      ]);

      type BootstrapCall = {
        confirmDefaultSlug?: (params: {
          email: string;
          suggestedSlug: string;
        }) => Promise<string | { slug: string; publicDescription?: string | null }>;
        registrationMode?: string;
      };
      const bootstrapCalls = mocks.bootstrapInbox.mock.calls as unknown as Array<[BootstrapCall]>;
      const bootstrapCall = bootstrapCalls[0]?.[0];
      expect(bootstrapCall).toEqual(expect.objectContaining({
        registrationMode: 'prompt',
        confirmDefaultSlug: expect.any(Function),
      }));

      mocks.promptText.mockResolvedValueOnce('custom-agent');
      mocks.promptMultiline.mockResolvedValueOnce('Custom public description');
      const result = await bootstrapCall?.confirmDefaultSlug?.({
        email: 'agent@example.com',
        suggestedSlug: 'agent',
      });

      expect(mocks.promptText).toHaveBeenCalledWith({
        question: 'Public agent slug for agent@example.com',
        defaultValue: 'agent',
      });
      expect(mocks.promptMultiline).toHaveBeenCalledWith({
        question: 'Public description for /custom-agent (optional).',
        doneMessage: 'Press Enter on an empty line to skip or finish.',
      });
      expect(result).toEqual({
        slug: 'custom-agent',
        publicDescription: 'Custom public description',
      });
    } finally {
      restoreTty();
    }
  });

  it('parses account keys confirm with an explicit slug', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'account',
      'keys',
      'confirm',
      '--slug',
      'support-bot',
    ]);

    expect(mocks.confirmCurrentImportedRotationKey).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'support-bot',
      })
    );
  });

  it('parses account keys confirm with the active agent by default', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'account',
      'keys',
      'confirm',
    ]);

    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', undefined);
    expect(mocks.confirmCurrentImportedRotationKey).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'agent',
      })
    );
  });

  it('parses account keys remove with non-interactive confirmation', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'account',
      'keys',
      'remove',
      '--yes',
    ]);

    expect(mocks.removeLocalKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
      })
    );
  });

  it('parses agent create positional slugs', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'create',
      'support-bot',
      '--display-name',
      'Support Bot',
    ]);

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'support-bot',
        displayName: 'Support Bot',
        profileName: 'default',
        registrationMode: 'auto',
      })
    );
  });

  it('allows explicitly skipping managed registration during agent create', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'create',
      'support-bot',
      '--skip-agent-registration',
    ]);

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'support-bot',
        profileName: 'default',
        registrationMode: 'skip',
      })
    );
  });

  it('parses agent use and persists the chosen agent context', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync(['node', 'masumi-agent-messenger', '--json', 'agent', 'use', 'support-bot']);

    expect(mocks.useOwnedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'support-bot',
        profileName: 'default',
      })
    );
  });

  it('parses agent show in json mode', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'show',
      'support-bot',
    ]);

    expect(mocks.getOwnedAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'support-bot',
        profileName: 'default',
      })
    );
    expect(mocks.runCommandAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Masumi agent show',
        options: expect.objectContaining({
          json: true,
        }),
      })
    );
  });

  it('parses agent show in human mode', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      'agent',
      'show',
      '--agent',
      'support-bot',
    ]);

    expect(mocks.getOwnedAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'support-bot',
        profileName: 'default',
      })
    );
    expect(mocks.runCommandAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Masumi agent show',
        options: expect.objectContaining({
          json: false,
        }),
      })
    );
  });

  it('parses agent show with the active agent by default', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'show',
    ]);

    expect(mocks.resolvePreferredAgentSlug).not.toHaveBeenCalled();
    expect(mocks.getOwnedAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: undefined,
        profileName: 'default',
      })
    );
  });

  it('parses thread start positional arguments', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'start',
      'support-bot',
      'hello',
      'there',
    ]);

    expect(mocks.sendMessageToSlug).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support-bot',
        message: 'hello there',
        actorSlug: 'agent',
        profileName: 'default',
      })
    );
  });

  it('parses thread send positional targets with explicit agent context', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'send',
      'support-bot',
      'hello',
      'there',
      '--agent',
      'deploy-agent',
    ]);

    expect(mocks.sendMessageToSlug).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support-bot',
        message: 'hello there',
        actorSlug: 'deploy-agent',
        profileName: 'default',
      })
    );
  });

  it('parses thread send --to, --message, content type, and headers', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'send',
      '--to',
      'support@example.com',
      '--message',
      '{"ok":true}',
      '--content-type',
      'application/json',
      '--header',
      'X-Workflow: deploy',
      '--header',
      'X-Trace: 123',
      '--force-unsupported',
    ]);

    expect(mocks.sendMessageToSlug).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support@example.com',
        message: '{"ok":true}',
        actorSlug: 'agent',
        contentType: 'application/json',
        headerLines: ['X-Workflow: deploy', 'X-Trace: 123'],
        forceUnsupported: true,
      })
    );
  });

  it('parses thread send --thread-id with a validated target', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'send',
      'support-bot',
      'validated',
      '--thread-id',
      '42',
      '--title',
      'Support',
      '--new',
    ]);

    expect(mocks.sendMessageToSlug).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support-bot',
        message: 'validated',
        threadId: '42',
        title: 'Support',
        createNew: true,
      })
    );
    expect(mocks.sendMessageToThread).not.toHaveBeenCalled();
  });

  it('parses thread send --thread-id without a target as a direct thread send', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'send',
      '--thread-id',
      '42',
      '--message',
      'reply by id',
      '--agent',
      'deploy-agent',
    ]);

    expect(mocks.sendMessageToThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: '42',
        message: 'reply by id',
        actorSlug: 'deploy-agent',
        profileName: 'default',
      })
    );
    expect(mocks.sendMessageToSlug).not.toHaveBeenCalled();
  });

  it('parses thread count with explicit agent context', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'count',
      '42',
      '--agent',
      'support-bot',
    ]);

    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', 'support-bot');
    expect(mocks.countThreadMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'support-bot',
        threadId: '42',
      })
    );
    expect(mocks.runCommandAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Masumi thread count',
        options: expect.objectContaining({
          json: true,
        }),
      })
    );
  });

  it('parses thread approval actions with explicit agent context', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'approval',
      'approve',
      '42',
      '--agent',
      'support-bot',
    ]);

    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', 'support-bot');
    expect(mocks.resolveContactRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: '42',
        action: 'approve',
        actorSlug: 'support-bot',
      })
    );
  });

  it('parses channel create options', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'create',
      'release-room',
      '--agent',
      'deploy-agent',
      '--title',
      'Release Room',
      '--description',
      'Deployment handoffs',
      '--approval-required',
      '--no-discoverable',
    ]);

    expect(mocks.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        slug: 'release-room',
        title: 'Release Room',
        description: 'Deployment handoffs',
        accessMode: 'approval_required',
        discoverable: false,
      })
    );
  });

  it('parses channel update settings', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'update',
      'release-room',
      '--agent',
      'deploy-agent',
      '--public',
      '--discoverable',
    ]);

    expect(mocks.updateChannelSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        slug: 'release-room',
        accessMode: 'public',
        discoverable: true,
      })
    );
  });

  it('parses channel approvals scoped to an administered channel', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'approvals',
      'release-room',
      '--agent',
      'deploy-agent',
      '--all',
    ]);

    expect(mocks.listChannelJoinRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        slug: 'release-room',
        includeResolved: true,
        requireAdmin: true,
      })
    );
  });

  it('parses channel approvals without secret material', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'approve',
      '42',
      '--agent',
      'deploy-agent',
    ]);

    const call = mocks.approveChannelJoin.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toEqual(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        requestId: '42',
      })
    );
    expect(call).not.toHaveProperty('secretEnvelope');
  });

  it('does not prompt for channel approve permission in json mode', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'approve',
      '42',
      '--agent',
      'deploy-agent',
    ]);

    expect(mocks.approveChannelJoin).toHaveBeenCalledWith(
      expect.not.objectContaining({
        selectPermission: expect.any(Function),
      })
    );
  });

  it('parses channel send', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'send',
      'release-room',
      'ship',
      'it',
      '--agent',
      'deploy-agent',
      '--content-type',
      'text/plain',
    ]);

    expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        slug: 'release-room',
        message: 'ship it',
        contentType: 'text/plain',
      })
    );
  });

  it('parses channel send with the active agent by default', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'send',
      'release-room',
      'ship',
      'it',
    ]);

    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', undefined);
    expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'agent',
        slug: 'release-room',
        message: 'ship it',
      })
    );
  });

  it('parses channel requests with the active agent by default', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'requests',
      '--incoming',
    ]);

    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', undefined);
    expect(mocks.listChannelJoinRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'agent',
        direction: 'incoming',
      })
    );
  });

  it('parses thread approval contact requests with active agent context', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'approval',
      'approve',
      '--request-id',
      '42',
    ]);

    expect(mocks.resolveContactRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: '42',
        action: 'approve',
        actorSlug: 'agent',
      })
    );
    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', undefined);
  });

  it('accepts the request id format printed by thread approval list', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'thread',
      'approval',
      'reject',
      '--request-id',
      '#42',
    ]);

    expect(mocks.resolveContactRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: '#42',
        action: 'reject',
      })
    );
  });

  it('parses discover show targets', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'discover',
      'show',
      'support-bot',
    ]);

    expect(mocks.showDiscoveredAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'support-bot',
        actorSlug: 'agent',
        profileName: 'default',
      })
    );
    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', undefined);
  });

  it('parses discover search with the active agent by default', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'discover',
      'search',
      'support',
    ]);

    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', undefined);
    expect(mocks.discoverAgents).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'agent',
        query: 'support',
        profileName: 'default',
      })
    );
  });

  it('parses agent message allow-all', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'message',
      'allow-all',
      'support-bot',
    ]);

    expect(mocks.updateOwnedAgentMessageCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'support-bot',
        allowAllContentTypes: true,
        allowAllHeaders: true,
        supportedContentTypes: [],
        supportedHeaders: [],
        profileName: 'default',
      })
    );
  });

  it('parses agent message content-type add with the active agent by default', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'message',
      'content-type',
      'add',
      'application/json',
    ]);

    expect(mocks.resolvePreferredAgentSlug).toHaveBeenCalledWith('default', undefined);
    expect(mocks.getOwnedAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'agent',
        profileName: 'default',
      })
    );
    expect(mocks.updateOwnedAgentMessageCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'agent',
        supportedContentTypes: ['application/json'],
        profileName: 'default',
      })
    );
  });

  it('requires an explicit agent slug for agent key reset', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await expect(
      buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        '--json',
        'agent',
        'key',
        'reset',
      ])
    ).rejects.toMatchObject({
      code: 'AGENT_KEY_RESET_SLUG_REQUIRED',
    });

    expect(mocks.resolvePreferredAgentSlug).not.toHaveBeenCalled();
    expect(mocks.rotateInboxKeys).not.toHaveBeenCalled();
  });

  it('parses agent key reset with an explicit slug', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'key',
      'reset',
      'support-bot',
      '--share-device',
      'device-a',
      '--revoke-device',
      'device-b',
    ]);

    expect(mocks.resolveRotationDeviceSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        explicitShareDeviceIds: ['device-a'],
        explicitRevokeDeviceIds: ['device-b'],
      })
    );
    expect(mocks.rotateInboxKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'support-bot',
        shareDeviceIds: ['device-a'],
        revokeDeviceIds: ['device-b'],
      })
    );
  });

  it('parses agent key reset with an explicit --agent selector', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'key',
      'reset',
      '--agent',
      'support-bot',
    ]);

    expect(mocks.rotateInboxKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSlug: 'support-bot',
      })
    );
  });

  it('lists pinned agent trust entries', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'trust',
      'list',
    ]);

    expect(mocks.listTrustedPeers).toHaveBeenCalledTimes(1);
  });

  it('pins first-contact agent trust without --force', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'trust',
      'pin',
      'Support-Bot',
    ]);

    expect(mocks.confirmPeerKeyRotation).toHaveBeenCalledWith(
      'support-bot:public-identity',
      {
        encryptionPublicKey: 'enc-public-key',
        encryptionKeyVersion: 1,
        signingPublicKey: 'sig-public-key',
        signingKeyVersion: 1,
      }
    );
  });

  it('accepts rotated agent trust keys without --force', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();
    mocks.loadPeerKeyTrustStore.mockResolvedValueOnce({
      version: 1,
      peers: {
        'support-bot:public-identity': {
          publicIdentity: 'support-bot:public-identity',
          pinnedAt: '2026-04-18T00:00:00.000Z',
          current: {
            encryptionPublicKey: 'old-enc-public-key',
            encryptionKeyVersion: 0,
            signingPublicKey: 'old-sig-public-key',
            signingKeyVersion: 0,
          },
          history: [],
        },
      },
    });

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'trust',
      'pin',
      'Support-Bot',
    ]);

    expect(mocks.confirmPeerKeyRotation).toHaveBeenCalledWith(
      'support-bot:public-identity',
      expect.objectContaining({
        encryptionKeyVersion: 1,
        signingKeyVersion: 1,
      })
    );
  });

  it('resets pinned agent trust by resolved public identity', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'agent',
      'trust',
      'reset',
      'Support-Bot',
    ]);

    expect(mocks.lookupPublishedAgentBySlug).toHaveBeenCalledWith({
      slug: 'support-bot',
    });
    expect(mocks.unpinPeerKeys).toHaveBeenCalledWith('support-bot:public-identity');
    expect(mocks.disconnectConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects removed legacy command paths and options', async () => {
    const { buildProgram } = await loadProgramWithMocks();
    const removedArgv = [
      ['node', 'masumi-agent-messenger', 'auth', 'login'],
      ['node', 'masumi-agent-messenger', 'auth', 'code', 'start'],
      [
        'node',
        'masumi-agent-messenger',
        'auth',
        'code',
        'complete',
        '--polling-code',
        'polling-code',
      ],
      ['node', 'masumi-agent-messenger', 'auth', 'resend-verification'],
      ['node', 'masumi-agent-messenger', 'auth', 'sync'],
      ['node', 'masumi-agent-messenger', 'auth', 'recover'],
      ['node', 'masumi-agent-messenger', 'auth', 'status'],
      ['node', 'masumi-agent-messenger', 'auth', 'logout'],
      ['node', 'masumi-agent-messenger', 'auth', 'device', 'request'],
      ['node', 'masumi-agent-messenger', 'auth', 'device', 'claim'],
      ['node', 'masumi-agent-messenger', 'auth', 'device', 'approve'],
      ['node', 'masumi-agent-messenger', 'auth', 'device', 'list'],
      ['node', 'masumi-agent-messenger', 'auth', 'device', 'revoke'],
      ['node', 'masumi-agent-messenger', 'auth', 'backup', 'export'],
      ['node', 'masumi-agent-messenger', 'auth', 'backup', 'import'],
      ['node', 'masumi-agent-messenger', 'auth', 'keys', 'confirm', '--slug', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'auth', 'keys-remove'],
      ['node', 'masumi-agent-messenger', 'auth', 'rotate'],
      ['node', 'masumi-agent-messenger', 'inbox', 'create', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'inbox', 'list'],
      ['node', 'masumi-agent-messenger', 'inbox', 'status'],
      ['node', 'masumi-agent-messenger', 'inbox', 'bootstrap'],
      ['node', 'masumi-agent-messenger', 'inbox', 'send', 'support-bot', 'hi'],
      ['node', 'masumi-agent-messenger', 'inbox', 'latest'],
      ['node', 'masumi-agent-messenger', 'inbox', 'agent', 'register'],
      ['node', 'masumi-agent-messenger', 'inbox', 'agent', 'deregister'],
      ['node', 'masumi-agent-messenger', 'inbox', 'public', 'show'],
      ['node', 'masumi-agent-messenger', 'inbox', 'public', 'set'],
      ['node', 'masumi-agent-messenger', 'inbox', 'request', 'list'],
      ['node', 'masumi-agent-messenger', 'inbox', 'request', 'approve', '--request-id', '42'],
      ['node', 'masumi-agent-messenger', 'inbox', 'request', 'reject', '--request-id', '42'],
      ['node', 'masumi-agent-messenger', 'inbox', 'allowlist', 'list'],
      ['node', 'masumi-agent-messenger', 'inbox', 'allowlist', 'add', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'inbox', 'allowlist', 'remove', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'inbox', 'trust', 'list'],
      ['node', 'masumi-agent-messenger', 'inbox', 'trust', 'pin', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'inbox', 'trust', 'reset', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'inbox', 'lookup', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'inbox', 'rotate'],
      ['node', 'masumi-agent-messenger', 'agent', 'key', 'rotate', 'support-bot'],
      ['node', 'masumi-agent-messenger', 'thread', 'latest'],
      ['node', 'masumi-agent-messenger', 'channels', 'list'],
      ['node', 'masumi-agent-messenger', 'channels', 'send', 'release-room', 'hi'],
      ['node', 'masumi-agent-messenger', 'channel', 'add', 'release-room'],
      [
        'node',
        'masumi-agent-messenger',
        'channel',
        'create',
        'release-room',
        '--default-join-permission',
        'read_write',
      ],
      [
        'node',
        'masumi-agent-messenger',
        'channel',
        'update',
        'release-room',
        '--default-join-permission',
        'read_write',
      ],
      [
        'node',
        'masumi-agent-messenger',
        'agent',
        'trust',
        'pin',
        '--force',
        'support-bot',
      ],
    ];

    const prepareForRejectedParse = (program: Command): void => {
      program.exitOverride();
      program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      for (const child of program.commands) {
        prepareForRejectedParse(child);
      }
    };

    for (const argv of removedArgv) {
      const program = buildProgram();
      prepareForRejectedParse(program);
      await expect(program.parseAsync(argv)).rejects.toMatchObject({
        code: expect.stringMatching(/^commander\./),
      });
    }
  });
});

describe('CLI root action', () => {
  it('launches the persistent root shell for bare masumi-agent-messenger in interactive mode', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-agent-messenger-root-'));
    const restoreTty = setInteractiveTty(true);
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks();
      await buildProgram().parseAsync(['node', 'masumi-agent-messenger']);

      expect(mocks.runRootShell).toHaveBeenCalledWith(
        expect.objectContaining({
          json: false,
          profile: 'default',
        })
      );
    } finally {
      restoreTty();
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('shows help instead of launching the root shell in json mode', async () => {
    const restoreTty = setInteractiveTty(true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks();
      await buildProgram().parseAsync(['node', 'masumi-agent-messenger', '--json']);

      expect(mocks.runRootShell).not.toHaveBeenCalled();
      expect(stdoutWrite).toHaveBeenCalled();
    } finally {
      restoreTty();
    }
  });
});

describe('CLI doctor', () => {
  it('treats an empty secret store as first-run unauthenticated and still checks SpacetimeDB', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-agent-messenger-doctor-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks({
        authStatusResult: makeAuthStatus({ authenticated: false }),
      });

      await buildProgram().parseAsync(['node', 'masumi-agent-messenger', 'doctor']);

      expect(mocks.createSecretStore).toHaveBeenCalledTimes(1);
      expect(mocks.getAgentKeyPair).toHaveBeenCalledWith('default');
      expect(mocks.getNamespaceKeyVault).toHaveBeenCalledWith('default');
      expect(mocks.getDeviceKeyMaterial).toHaveBeenCalledWith('default');
      expect(mocks.authStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          profileName: 'default',
        })
      );
      expect(mocks.connectAnonymous).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseName: DEFAULT_SPACETIMEDB_DB_NAME,
        })
      );
      expect(mocks.ensureAuthenticatedSession).not.toHaveBeenCalled();
      expect(mocks.connectAuthenticated).not.toHaveBeenCalled();
      expect(mocks.listOwnedAgents).not.toHaveBeenCalled();
      expect(mocks.discoverAgents).not.toHaveBeenCalled();
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an automation-safe login next action from doctor JSON', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-agent-messenger-doctor-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks({
        authStatusResult: makeAuthStatus({ authenticated: false }),
      });

      await buildProgram().parseAsync(['node', 'masumi-agent-messenger', 'doctor', '--json']);

      await expect(mocks.runCommandAction.mock.results[0]?.value).resolves.toMatchObject({
        authenticated: false,
        readiness: {
          state: 'needs_login',
          readyForMessaging: false,
          missing: ['session'],
        },
        nextAction: 'masumi-agent-messenger account login start --json',
      });
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns non-interactive key recovery guidance from doctor JSON', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-agent-messenger-doctor-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks({
        authStatusResult: makeAuthStatus({
          authenticated: true,
          email: 'agent@example.com',
          subject: 'subject-1',
        }),
      });

      await buildProgram().parseAsync(['node', 'masumi-agent-messenger', 'doctor', '--json']);

      await expect(mocks.runCommandAction.mock.results[0]?.value).resolves.toMatchObject({
        authenticated: true,
        localKeys: {
          agentKeyPair: false,
          namespaceVault: false,
        },
        readiness: {
          state: 'needs_key_recovery',
          readyForMessaging: false,
          missing: ['agent_key_pair', 'namespace_vault'],
          keyRecovery: {
            preferred: ['device_share', 'backup_import'],
            destructiveFallback: 'key_reset',
            resetLosesOldMessages: true,
          },
        },
        nextAction: 'masumi-agent-messenger account device request --json',
      });
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
