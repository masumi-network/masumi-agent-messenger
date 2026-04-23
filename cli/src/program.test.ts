import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyMasumiRegistrationResult } from '../../shared/inbox-agent-registration';
import type {
  AuthStatusResult,
  AuthenticatedInboxResult,
  PendingDeviceLoginResult,
} from './services/auth';

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
      normalizedEmail: 'agent@example.com',
      displayEmail: 'agent@example.com',
    },
    actor: {
      id: '1',
      slug: 'agent',
      publicIdentity: 'agent',
      displayName: 'Agent',
    },
    agentRegistration: createEmptyMasumiRegistrationResult(),
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
  const logout = vi.fn(async () => ({
    authenticated: false as const,
    cleared: true as const,
    profile: 'default',
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

  const createInboxIdentity = vi.fn(async () => ({
    profile: 'default',
    actor: {
      id: '2',
      slug: 'support-bot',
      publicIdentity: 'support-bot',
      displayName: 'Support Bot',
      keyVersions: {
        encryption: 'enc-v1',
        signing: 'sig-v1',
      },
    },
    registration: createEmptyMasumiRegistrationResult(),
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
    threadSeq: '3',
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
    threadSeq: '3',
  }));
  const countThreadMessages = vi.fn(async (input: { threadId: string; actorSlug?: string }) => ({
    authenticated: true as const,
    connected: true as const,
    profile: 'default',
    actorSlug: input.actorSlug ?? 'agent',
    thread: {
      id: input.threadId,
      kind: 'group',
      label: 'Support Group',
      locked: false,
      archived: false,
      participantCount: 2,
      participants: ['agent', 'support-bot'],
    },
    messageCount: 7,
    lastMessageSeq: '7',
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
      kind: 'direct',
      label: 'Support Bot',
      locked: false,
      archived: false,
    },
    lastReadThreadSeq: '0',
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
    kind: 'direct' as const,
    locked: false,
    participants: ['agent', 'support-bot'],
    invitedParticipants: [],
  }));
  const createGroupThread = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    threadId: '43',
    label: 'Support Group',
    kind: 'group' as const,
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
    throughSeq: '7',
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
  const listContactRequests = vi.fn(async () => ({
    profile: 'default',
    slug: 'agent',
    total: 0,
    requests: [],
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
    kind: 'agent',
    value: 'support-bot',
  }));
  const removeContactAllowlist = vi.fn(async () => ({
    profile: 'default',
    actorSlug: 'agent',
    kind: 'agent',
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
      encryptionKeyVersion: 'enc-v1',
      signingKeyVersion: 'sig-v1',
    },
    publicRoute: {
      agentIdentifier: null,
      linkedEmail: null,
      description: 'Support agent',
      encryptionKeyVersion: 'enc-v1',
      signingKeyVersion: 'sig-v1',
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
  const listPublicChannels = vi.fn(async () => ({
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
    status: 'approved',
  }));
  const rejectChannelJoin = vi.fn(async () => ({
    profile: 'default',
    status: 'rejected',
  }));
  const setChannelMemberPermission = vi.fn(async (input: { slug: string }) => ({
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
      encryptionKeyVersion: 'enc-v1',
      encryptionPublicKey: 'enc-public-key',
      signingKeyVersion: 'sig-v1',
      signingPublicKey: 'sig-public-key',
    },
  ]);
  const lookupPublishedAgentsByEmail = vi.fn(async () => []);
  const connectAuthenticated = vi.fn(async () => ({
    conn: {
      procedures: {
        lookupPublishedAgentBySlug,
        lookupPublishedAgentsByEmail,
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

  vi.doMock('./services/command-runtime', () => ({
    runCommandAction,
  }));

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
      ensureAuthenticatedSession,
      requestVerificationEmailForIssuer,
    };
  });

  vi.doMock('./services/spacetimedb', () => ({
    connectAnonymous,
    connectAuthenticated,
    disconnectConnection,
  }));

  vi.doMock('./services/secret-store', () => ({
    createSecretStore,
  }));

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
      createInboxIdentity,
    };
  });

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
      listContactRequests,
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
    listPublicChannels,
    showPublicChannel,
    readAuthenticatedChannelMessages,
    readPublicChannelMessages,
    rejectChannelJoin,
    removeChannelMember,
    requestChannelJoin,
    sendChannelMessage,
    setChannelMemberPermission,
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
      logout,
      ensureAuthenticatedSession,
      requestVerificationEmailForIssuer,
      createInboxIdentity,
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
      listContactAllowlist,
      addContactAllowlist,
      removeContactAllowlist,
      discoverAgents,
      showDiscoveredAgent,
      listPublicChannels,
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
      setChannelMemberPermission,
      removeChannelMember,
      sendChannelMessage,
      lookupPublishedAgentBySlug,
      lookupPublishedAgentsByEmail,
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
      loadPeerKeyTrustStore,
      unpinPeerKeys,
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
    expect(help).not.toContain('\nthread');
  });

  it('shows the account help', async () => {
    const { buildProgram } = await import('./program');
    const account = buildProgram().commands.find(command => command.name() === 'account');
    const help = account?.helpInformation() ?? '';

    expect(help).toContain('Authenticate and bootstrap or recover your Masumi account');
    expect(help).toContain('verification');
    expect(help).toContain('device');
    expect(help).toContain('backup');
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
    expect(help).toContain('key');
  });

  it('shows the thread help', async () => {
    const { buildProgram } = await import('./program');
    const thread = buildProgram().commands.find(command => command.name() === 'thread');
    const help = thread?.helpInformation() ?? '';

    expect(help).toContain('list');
    expect(help).toContain('show');
    expect(help).toContain('count');
    expect(help).toContain('latest');
    expect(help).toContain('start');
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
    expect(help).toContain('add');
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

  it('parses auth code complete polling codes from --polling-code', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'auth',
      'code',
      'complete',
      '--polling-code',
      'polling-456',
    ]);

    expect(mocks.waitForLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        pollingCode: 'polling-456',
        profileName: 'default',
      })
    );
  });

  it('uses prompt registration for auth code complete in an interactive TTY', async () => {
    const restoreTty = setInteractiveTty(true);

    try {
      const { buildProgram, mocks } = await loadProgramWithMocks();

      await buildProgram().parseAsync([
        'node',
        'masumi-agent-messenger',
        'auth',
        'code',
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

  it('uses automatic auth registration when stdin is not interactive', async () => {
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
        'auth',
        'code',
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

    expect(mocks.createInboxIdentity).toHaveBeenCalledWith(
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

    expect(mocks.createInboxIdentity).toHaveBeenCalledWith(
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
      '--public-join-permission',
      'read_write',
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
        publicJoinPermission: 'read_write',
        discoverable: false,
      })
    );
  });

  it('parses channel add as a create alias', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channel',
      'add',
      'release-room',
      '--agent',
      'deploy-agent',
      '--approval-required',
    ]);

    expect(mocks.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        slug: 'release-room',
        accessMode: 'approval_required',
        publicJoinPermission: 'read',
        discoverable: true,
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
      '--default-join-permission',
      'read_write',
      '--discoverable',
    ]);

    expect(mocks.updateChannelSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        slug: 'release-room',
        accessMode: 'public',
        publicJoinPermission: 'read_write',
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
        direction: 'incoming',
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
      '--permission',
      'read_write',
    ]);

    const call = mocks.approveChannelJoin.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toEqual(
      expect.objectContaining({
        profileName: 'default',
        actorSlug: 'deploy-agent',
        requestId: '42',
        permission: 'read_write',
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

  it('parses the plural channels alias for sending', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'channels',
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

  it('parses inbox request approvals without requiring inbox slug context', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'inbox',
      'request',
      'approve',
      '--request-id',
      '42',
    ]);

    expect(mocks.resolveContactRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: '42',
        action: 'approve',
      })
    );
  });

  it('accepts the request id format printed by inbox request list', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'inbox',
      'request',
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

  it('pins first-contact inbox trust without --force', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'inbox',
      'trust',
      'pin',
      'Support-Bot',
    ]);

    expect(mocks.confirmPeerKeyRotation).toHaveBeenCalledWith(
      'support-bot:public-identity',
      {
        encryptionPublicKey: 'enc-public-key',
        encryptionKeyVersion: 'enc-v1',
        signingPublicKey: 'sig-public-key',
        signingKeyVersion: 'sig-v1',
      }
    );
  });

  it('accepts rotated inbox trust keys without --force', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();
    mocks.loadPeerKeyTrustStore.mockResolvedValueOnce({
      version: 1,
      peers: {
        'support-bot:public-identity': {
          publicIdentity: 'support-bot:public-identity',
          pinnedAt: '2026-04-18T00:00:00.000Z',
          current: {
            encryptionPublicKey: 'old-enc-public-key',
            encryptionKeyVersion: 'old-enc-v1',
            signingPublicKey: 'old-sig-public-key',
            signingKeyVersion: 'old-sig-v1',
          },
          history: [],
        },
      },
    });

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'inbox',
      'trust',
      'pin',
      'Support-Bot',
    ]);

    expect(mocks.confirmPeerKeyRotation).toHaveBeenCalledWith(
      'support-bot:public-identity',
      expect.objectContaining({
        encryptionKeyVersion: 'enc-v1',
        signingKeyVersion: 'sig-v1',
      })
    );
  });

  it('accepts --force for rotated inbox trust keys as compatibility', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();
    mocks.loadPeerKeyTrustStore.mockResolvedValueOnce({
      version: 1,
      peers: {
        'support-bot:public-identity': {
          publicIdentity: 'support-bot:public-identity',
          pinnedAt: '2026-04-18T00:00:00.000Z',
          current: {
            encryptionPublicKey: 'old-enc-public-key',
            encryptionKeyVersion: 'old-enc-v1',
            signingPublicKey: 'old-sig-public-key',
            signingKeyVersion: 'old-sig-v1',
          },
          history: [],
        },
      },
    });

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'inbox',
      'trust',
      'pin',
      '--force',
      'Support-Bot',
    ]);

    expect(mocks.confirmPeerKeyRotation).toHaveBeenCalledWith(
      'support-bot:public-identity',
      expect.objectContaining({
        encryptionKeyVersion: 'enc-v1',
        signingKeyVersion: 'sig-v1',
      })
    );
  });

  it('resets pinned inbox trust by resolved public identity', async () => {
    const { buildProgram, mocks } = await loadProgramWithMocks();

    await buildProgram().parseAsync([
      'node',
      'masumi-agent-messenger',
      '--json',
      'inbox',
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
          databaseName: 'masumi-agent-messenger-3rx0g',
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
});
