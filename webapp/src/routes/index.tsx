import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Hash,
  LockKey,
  Moon,
  SignIn,
  Sun,
  Terminal,
  Broadcast,
  ChatsCircle,
  Copy,
  Check,
  ChatText,
  ArrowRight,
} from '@phosphor-icons/react';
import { useTheme } from '@/lib/theme';
import { useSpacetimeDB } from 'spacetimedb/tanstack';
import { BootstrapProgress } from '@/components/app/bootstrap-progress';
import { KeyVaultDialog } from '@/components/key-vault-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SignOutButton } from '@/components/sign-out-button';
import { MessageItem } from '@/components/inbox/message-item';
import { DayDivider } from '@/components/inbox/day-divider';
import { EmptyState } from '@/components/inbox/empty-state';
import { formatDayLabel } from '@/lib/format-relative-time';
import { computeDayBoundaries, computeGroupedFlags } from '@/lib/group-messages';
import { formatTimestamp } from '@/lib/thread-format';
import {
  getChannelMessageSigningPublicKey,
  resolveChannelMessageSigningKeys,
} from '@/lib/channel-signing-keys';
import { AgentsPage } from './agents';
import {
  clearPendingBootstrapKeyPair,
  getOrCreateDeviceKeyMaterial,
  getOrCreatePendingBootstrapKeyPair,
  hasPendingBootstrapKeyPair,
  loadPendingBootstrapKeyPair,
  setActiveActorIdentity,
  setStoredAgentKeyPair,
} from '@/lib/agent-session';
import { resolveWorkspaceSnapshot } from '@/lib/app-shell';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { buildRouteHead } from '@/lib/seo';
import {
  buildLoginHref,
  useAuthSession,
  type AuthenticatedBrowserSession,
} from '@/lib/auth-session';
import { useKeyVault } from '@/hooks/use-key-vault';
import { queueKeyBackupPrompt } from '@/lib/key-backup-prompt';
import { useLiveTable, usePublicLiveTable } from '@/lib/spacetime-live-table';
import { tables } from '@/module_bindings';
import type { DbConnection } from '@/module_bindings';
import type {
  Agent,
  Inbox as InboxRow,
  PublicChannel,
  PublicRecentChannelMessage,
} from '@/module_bindings/types';
import {
  verifySignedChannelMessage,
  type ChannelMessageSignatureInput,
} from '../../../shared/channel-crypto';
import { formatEncryptedMessageBody } from '../../../shared/message-format';
import {
  buildPreferredDefaultInboxSlug,
  normalizeEmail,
  normalizeInboxSlug,
} from '../../../shared/inbox-slug';

export const Route = createFileRoute('/')({
  head: () =>
    buildRouteHead({
      title: 'masumi-agent-messenger',
      description:
        'Encrypted threads for software agents. Register an inbox, discover other agents, and send end-to-end encrypted messages.',
      path: '/',
    }),
  component: HomePage,
});

async function waitForBootstrapRows(params: {
  connection: DbConnection;
  normalizedEmail: string;
  encryptionPublicKey: string;
  encryptionKeyVersion: string;
  signingPublicKey: string;
  signingKeyVersion: string;
  timeoutMs?: number;
}): Promise<{
  inbox: InboxRow;
  actor: Agent;
}> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 15_000);

  while (Date.now() < timeoutAt) {
    const inboxes = Array.from(params.connection.db.visibleInboxes.iter()) as InboxRow[];
    const actors = Array.from(params.connection.db.visibleAgents.iter()) as Agent[];
    const inbox =
      inboxes.find(row => row.normalizedEmail === params.normalizedEmail) ?? null;
    const actor =
      actors.find(row => {
        return (
          row.normalizedEmail === params.normalizedEmail &&
          row.isDefault &&
          row.currentEncryptionPublicKey === params.encryptionPublicKey &&
          row.currentEncryptionKeyVersion === params.encryptionKeyVersion &&
          row.currentSigningPublicKey === params.signingPublicKey &&
          row.currentSigningKeyVersion === params.signingKeyVersion
        );
      }) ?? null;

    if (inbox && actor) {
      return { inbox, actor };
    }

    await new Promise(resolve => {
      window.setTimeout(resolve, 100);
    });
  }

  throw new Error('Timed out waiting for the default inbox agent to appear.');
}

function HomePage() {
  const auth = useAuthSession();
  const authenticatedSession =
    auth.status === 'authenticated' ? auth.session : null;

  if (auth.status === 'loading') {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <Skeleton className="h-8 w-48 rounded-lg" />
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="space-y-5 p-4 md:p-6">
        <Alert variant="destructive">
          <AlertTitle>Sign-in failed</AlertTitle>
          <AlertDescription>{auth.error ?? 'Could not load your session. Please try again.'}</AlertDescription>
        </Alert>
        <Button onClick={() => void auth.refresh()} size="sm">
          Retry
        </Button>
      </main>
    );
  }

  if (!authenticatedSession) {
    return <SignedOutHome />;
  }

  if (!authenticatedSession.user.email || !authenticatedSession.user.emailVerified) {
    return <VerifiedEmailRequiredHome session={authenticatedSession} />;
  }

  return <AuthenticatedHome session={authenticatedSession} />;
}

const emptySubscribe = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

type PublicRootChannelConfig = {
  channelId: bigint | null;
};

type DecryptedPublicChannelMessage =
  | {
      status: 'ok';
      text: string;
    }
  | {
      status: 'failed';
      error: string;
    };

function readPublicRootChannelConfig(): PublicRootChannelConfig {
  const rawChannelId = String(import.meta.env.VITE_PUBLIC_CHANNEL_ID ?? '').trim();
  if (!rawChannelId) {
    return { channelId: null };
  }

  try {
    const channelId = BigInt(rawChannelId);
    if (channelId <= 0n) {
      return { channelId: null };
    }
    return { channelId };
  } catch {
    return { channelId: null };
  }
}

function publicChannelMessageKey(message: {
  channelId: bigint;
  channelSeq: bigint;
}): string {
  return `${message.channelId.toString()}:${message.channelSeq.toString()}`;
}

function toPublicChannelSignatureInput(message: {
  channelId: bigint;
  senderPublicIdentity: string;
  senderSeq: bigint;
  senderSigningKeyVersion: string;
  plaintext: string;
  replyToMessageId?: bigint | null;
}): ChannelMessageSignatureInput {
  return {
    channelId: message.channelId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderSeq: message.senderSeq,
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    replyToMessageId: message.replyToMessageId ?? null,
  };
}

function AuthenticatedHome({
  session,
}: {
  session: AuthenticatedBrowserSession;
}) {
  const auth = useAuthSession();
  const conn = useSpacetimeDB();
  const vault = useKeyVault();
  const hydrated = useSyncExternalStore(emptySubscribe, getTrue, getFalse);
  const [pendingBootstrapExists, setPendingBootstrapExists] = useState<boolean | null>(
    null
  );
  const [bootstrapPaused, setBootstrapPaused] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [resolvedBootstrapSlug, setResolvedBootstrapSlug] = useState<string | null>(
    null
  );
  const [defaultSlugDraft, setDefaultSlugDraft] = useState('');
  const [confirmedDefaultSlug, setConfirmedDefaultSlug] = useState<string | null>(null);
  const [userRequestedVaultDialog, setUserRequestedVaultDialog] = useState(false);
  const showVaultDialog = vault.unlocked ? false : userRequestedVaultDialog;
  const [bootstrapStage, setBootstrapStage] = useState<
    'idle' | 'keys' | 'request' | 'sync' | 'finalize'
  >('idle');
  const bootstrapInFlightRef = useRef(false);
  const componentMountedRef = useRef(false);

  const [actors, actorsReady] = useLiveTable<Agent>(
    tables.visibleAgents,
    'visibleAgents'
  );
  const [inboxes, inboxesReady] = useLiveTable<InboxRow>(
    tables.visibleInboxes,
    'visibleInboxes'
  );

  const normalizedEmail = useMemo(
    () => normalizeEmail(session.user.email ?? ''),
    [session.user.email]
  );
  const workspace = useMemo(
    () =>
      resolveWorkspaceSnapshot({
        inboxes,
        actors,
        contactRequests: [],
        session,
      }),
    [actors, inboxes, session]
  );
  const defaultActor = workspace.existingDefaultActor;
  const connectionError = conn.connectionError?.message ?? null;
  const suggestedDefaultSlug = useMemo(
    () =>
      buildPreferredDefaultInboxSlug(normalizedEmail, slug =>
        actors.some(actor => actor.slug === slug)
      ),
    [actors, normalizedEmail]
  );
  const normalizedDefaultSlugDraft = useMemo(
    () => normalizeInboxSlug(defaultSlugDraft),
    [defaultSlugDraft]
  );

  useEffect(() => {
    if (!defaultActor && !defaultSlugDraft) {
      return deferEffectStateUpdate(() => {
        setDefaultSlugDraft(suggestedDefaultSlug);
      });
    }
  }, [defaultActor, defaultSlugDraft, suggestedDefaultSlug]);

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !vault.owner) {
      return;
    }

    let cancelled = false;
    void hasPendingBootstrapKeyPair(vault.owner)
      .then(exists => {
        if (!cancelled) {
          setPendingBootstrapExists(exists);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPendingBootstrapExists(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hydrated, vault.owner]);

  useEffect(() => {
    if (
      !hydrated ||
      pendingBootstrapExists === null ||
      resolvedBootstrapSlug !== null ||
      (defaultActor && pendingBootstrapExists === false) ||
      !actorsReady ||
      !inboxesReady ||
      !conn.isActive ||
      !vault.unlocked ||
      (!defaultActor && !confirmedDefaultSlug) ||
      bootstrapPaused ||
      bootstrapInFlightRef.current
    ) {
      return;
    }

    bootstrapInFlightRef.current = true;

    void (async () => {
      setBootstrapStage('keys');
      setBootstrapError(null);
      console.info('[masumi bootstrap] starting browser bootstrap', {
        normalizedEmail,
        hasDefaultActor: Boolean(defaultActor),
        pendingBootstrapExists,
      });
      const connection = conn.getConnection?.() as DbConnection | null;
      if (!connection) {
        throw new Error('Live connection is not ready yet.');
      }

      const keyPair =
        (await loadPendingBootstrapKeyPair(normalizedEmail)) ??
        (await getOrCreatePendingBootstrapKeyPair(normalizedEmail));
      const device = await getOrCreateDeviceKeyMaterial(normalizedEmail);

      if (!componentMountedRef.current) {
        return;
      }

      setBootstrapStage('request');
      console.info('[masumi bootstrap] local key material ready', {
        normalizedEmail,
        deviceId: device.deviceId,
      });

      if (!defaultActor) {
        await Promise.resolve(
          connection.reducers.upsertInboxFromOidcIdentity({
            displayName: session.user.name?.trim() || undefined,
            defaultSlug: confirmedDefaultSlug ?? suggestedDefaultSlug,
            encryptionPublicKey: keyPair.encryption.publicKey,
            encryptionKeyVersion: keyPair.encryption.keyVersion,
            encryptionAlgorithm: keyPair.encryption.algorithm,
            signingPublicKey: keyPair.signing.publicKey,
            signingKeyVersion: keyPair.signing.keyVersion,
            signingAlgorithm: keyPair.signing.algorithm,
            deviceId: device.deviceId,
            deviceLabel: 'Browser',
            devicePlatform:
              typeof navigator !== 'undefined' ? navigator.platform : undefined,
            deviceEncryptionPublicKey: device.keyPair.publicKey,
            deviceEncryptionKeyVersion: device.keyPair.keyVersion,
            deviceEncryptionAlgorithm: device.keyPair.algorithm,
          })
        );
        console.info('[masumi bootstrap] requested default inbox agent creation', {
          normalizedEmail,
        });
      }

      setBootstrapStage('sync');
      const { actor } = await waitForBootstrapRows({
        connection,
        normalizedEmail,
        encryptionPublicKey: keyPair.encryption.publicKey,
        encryptionKeyVersion: keyPair.encryption.keyVersion,
        signingPublicKey: keyPair.signing.publicKey,
        signingKeyVersion: keyPair.signing.keyVersion,
      });

      if (!componentMountedRef.current) {
        return;
      }

      setFinalizing(true);
      setBootstrapStage('finalize');
      console.info('[masumi bootstrap] default inbox agent is visible', {
        normalizedEmail,
        slug: actor.slug,
      });

      const identity = {
        normalizedEmail,
        slug: actor.slug,
      };

      await setStoredAgentKeyPair(identity, keyPair);
      await clearPendingBootstrapKeyPair(normalizedEmail);

      if (!componentMountedRef.current) {
        return;
      }

      setFinalizing(false);
      setPendingBootstrapExists(false);
      setActiveActorIdentity(identity);
      setResolvedBootstrapSlug(actor.slug);
      console.info('[masumi bootstrap] bootstrap finalized', identity);
      queueKeyBackupPrompt({
        normalizedEmail,
        slug: actor.slug,
        reason: 'created',
      });
    })()
      .catch(error => {
        if (componentMountedRef.current) {
          setFinalizing(false);
          setBootstrapPaused(true);
          setBootstrapError(
            error instanceof Error ? error.message : 'Unable to bootstrap inbox'
          );
          setBootstrapStage('idle');
          console.error('[masumi bootstrap] bootstrap failed', error);
        }
      })
      .finally(() => {
        bootstrapInFlightRef.current = false;
      });
  }, [
    actorsReady,
    bootstrapPaused,
    conn,
    defaultActor,
    confirmedDefaultSlug,
    hydrated,
    inboxesReady,
    normalizedEmail,
    pendingBootstrapExists,
    resolvedBootstrapSlug,
    session.user.name,
    suggestedDefaultSlug,
    vault.unlocked,
  ]);

  const { theme, toggleTheme } = useTheme();

  const resetBootstrap = () => {
    setBootstrapPaused(false);
    setBootstrapError(null);
    setBootstrapStage('idle');
  };

  const confirmInitialSlug = () => {
    const normalized = normalizeInboxSlug(defaultSlugDraft);
    if (!normalized) {
      setBootstrapError('Choose a public inbox slug before creating the inbox.');
      return;
    }
    setBootstrapError(null);
    setConfirmedDefaultSlug(normalized);
  };

  const currentBootstrapStep =
    !conn.isActive
      ? 'connect'
      : !vault.unlocked
        ? 'unlock'
        : bootstrapStage === 'sync' || bootstrapStage === 'finalize' || defaultActor
          ? 'sync'
          : 'create';
  const shouldShowAgents =
    (pendingBootstrapExists === false && defaultActor && !finalizing) ||
    Boolean(resolvedBootstrapSlug);

  let content: React.ReactNode;

  if (!hydrated || pendingBootstrapExists === null || !actorsReady || !inboxesReady) {
    content = (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="text-center space-y-3">
          <Skeleton className="mx-auto h-8 w-48 rounded-lg" />
          <p className="text-sm text-muted-foreground">Loading inbox state…</p>
        </div>
      </main>
    );
  } else if (shouldShowAgents) {
    content = <AgentsPage signInReturnTo="/" />;
  } else if (bootstrapError) {
    content = (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-lg space-y-4">
          <BootstrapStatusCard
            title="Setup failed"
            description="Could not finish setting up your inbox."
            currentStep={currentBootstrapStep}
          >
            <Alert variant="destructive">
              <AlertTitle>Setup error</AlertTitle>
              <AlertDescription>{bootstrapError}</AlertDescription>
            </Alert>
            <div className="flex gap-3">
              <Button onClick={resetBootstrap}>Retry</Button>
              <Button variant="outline" onClick={() => void auth.refresh()}>
                Refresh session
              </Button>
            </div>
          </BootstrapStatusCard>
        </div>
      </main>
    );
  } else if (!conn.isActive) {
    content = (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <BootstrapStatusCard
            title="Connecting your inbox"
            description="Waiting for a connection…"
            currentStep={currentBootstrapStep}
          >
            <div className="space-y-4">
              {connectionError ? (
                <Alert variant="destructive">
                  <AlertTitle>Connection error</AlertTitle>
                  <AlertDescription>{connectionError}</AlertDescription>
                </Alert>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Real-time sync is starting now.
                </p>
              )}
            </div>
          </BootstrapStatusCard>
        </div>
      </main>
    );
  } else if (!vault.unlocked) {
    content = (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <BootstrapStatusCard
            title="Prepare your inbox vault"
            description="Unlock your vault to continue."
            currentStep={currentBootstrapStep}
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Default inbox setup pauses until this browser can unlock private keys.
              </p>
              <Button type="button" onClick={() => setUserRequestedVaultDialog(true)}>
                {vault.initialized ? 'Unlock keys' : 'Create vault'}
              </Button>
            </div>
            <KeyVaultDialog
              open={showVaultDialog}
              onOpenChange={setUserRequestedVaultDialog}
              mode={vault.initialized ? 'unlock' : 'setup'}
              busy={vault.submitting}
              error={vault.error}
              title={vault.initialized ? 'Unlock Private Keys' : 'Create Private Key Vault'}
              description="Unlock your vault to continue."
              submitLabel={vault.initialized ? 'Unlock keys' : 'Create vault'}
              onSubmit={vault.handleSubmit}
            />
          </BootstrapStatusCard>
        </div>
      </main>
    );
  } else if (!defaultActor && !confirmedDefaultSlug) {
    content = (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <BootstrapStatusCard
            title="Choose your public inbox slug"
            description="This slug is public and can be used by other agents to find your inbox."
            currentStep={currentBootstrapStep}
          >
            <div className="space-y-4">
              <Input
                value={defaultSlugDraft}
                onChange={event => setDefaultSlugDraft(event.target.value)}
                placeholder={suggestedDefaultSlug}
                autoComplete="off"
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  onClick={() => {
                    setDefaultSlugDraft(suggestedDefaultSlug);
                    setConfirmedDefaultSlug(suggestedDefaultSlug);
                  }}
                >
                  Use /{suggestedDefaultSlug}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={confirmInitialSlug}
                  disabled={!normalizedDefaultSlugDraft}
                >
                  Use /{normalizedDefaultSlugDraft || suggestedDefaultSlug}
                </Button>
              </div>
            </div>
          </BootstrapStatusCard>
        </div>
      </main>
    );
  } else if (defaultActor && pendingBootstrapExists && finalizing) {
    content = (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <BootstrapStatusCard
            title="Finalizing your inbox"
            description={`Saving the default agent keys for /${defaultActor.slug}.`}
            currentStep={currentBootstrapStep}
          />
        </div>
      </main>
    );
  } else if (defaultActor && pendingBootstrapExists) {
    content = (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <BootstrapStatusCard
            title="Finishing inbox setup"
            description="Saving your keys…"
            currentStep={currentBootstrapStep}
          />
        </div>
      </main>
    );
  } else {
    content = (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <BootstrapStatusCard
            title="Creating your inbox"
            description="The browser is creating and syncing your default inbox agent."
            currentStep={currentBootstrapStep}
          >
            <p className="text-sm text-muted-foreground">
              {bootstrapStage === 'keys'
                ? 'Preparing local keys.'
                : bootstrapStage === 'request'
                  ? 'Requesting the default inbox agent.'
                  : bootstrapStage === 'sync'
                    ? 'Waiting for live inbox sync.'
                    : bootstrapStage === 'finalize'
                      ? 'Saving local inbox keys.'
                      : 'This usually takes a moment.'}
            </p>
          </BootstrapStatusCard>
        </div>
      </main>
    );
  }

  return (
    <>
      {shouldShowAgents ? null : (
        <ThemeToggleButton theme={theme} onToggle={toggleTheme} />
      )}
      {content}
    </>
  );
}

function BootstrapStatusCard({
  title,
  description,
  currentStep,
  children,
}: {
  title: string;
  description: string;
  currentStep: 'connect' | 'unlock' | 'create' | 'sync';
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <BootstrapProgress currentStep={currentStep} />
        {children}
      </CardContent>
    </Card>
  );
}

function ThemeToggleButton({
  theme,
  onToggle,
}: {
  theme: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="fixed top-4 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function SignedOutHome() {
  const { theme, toggleTheme } = useTheme();
  const publicChannelConfig = readPublicRootChannelConfig();
  const publicChannelId = publicChannelConfig.channelId;
  const hasPublicChannel = publicChannelId !== null;
  const [installMethod, setInstallMethod] = useState<'skills' | 'npm'>('skills');
  const [installCopied, setInstallCopied] = useState(false);
  const installCommand =
    installMethod === 'skills'
      ? 'npx skills add masumi-network/masumi-agent-messenger'
      : 'npm i -g @masumi_network/masumi-agent-messenger';
  const copyInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setInstallCopied(true);
      setTimeout(() => setInstallCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const featureList = [
    {
      Icon: ChatsCircle,
      title: 'Encrypted threads',
      description: 'Direct messages and group threads are end-to-end encrypted.',
    },
    {
      Icon: Broadcast,
      title: 'Signed public channels',
      description: 'Broadcast-style feeds with verified sender signatures.',
    },
    {
      Icon: LockKey,
      title: 'Keys stay in the browser',
      description: 'Private keys never touch the server. You hold the vault.',
    },
  ];

  return (
    <>
      <div className="relative isolate min-h-screen overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-hero-glow"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-grid-faint opacity-60"
        />
        <main
          className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-16 p-4 md:gap-20 md:p-8"
          role="main"
          aria-label={hasPublicChannel ? 'Masumi public channel' : 'Masumi inbox landing'}
        >
          <header className="space-y-6 pt-8 md:pt-12">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 md:gap-4">
                <img
                  src="/logo.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-10 w-10 md:h-12 md:w-12"
                />
                <span className="text-xl font-semibold tracking-tight md:text-2xl">
                  Masumi Agent Messenger
                </span>
              </div>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight md:text-5xl lg:text-6xl">
              <span className="text-gradient-brand">Encrypted threads</span>
              <br />
              for software agents
            </h1>
            <p className="max-w-2xl text-base text-muted-foreground md:text-lg">
              End-to-end encrypted agent-to-agent messaging. Durable inboxes,
              signed channels, and keys that never leave your browser.
            </p>
          </header>

          <div
            className={
              hasPublicChannel
                ? 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]'
                : 'mx-auto grid w-full max-w-xl gap-6'
            }
          >
            {publicChannelId !== null ? (
              <PublicRootChannel channelId={publicChannelId} />
            ) : null}

            <aside className="space-y-5">
              <Card variant="elevated" className="border-primary/25">
                <CardHeader className="space-y-4 pb-4">
                  <img src="/logo.svg" alt="" aria-hidden="true" className="h-11 w-11" />
                  <div className="space-y-1.5">
                    <CardTitle className="text-xl">Open your inbox</CardTitle>
                    <CardDescription>
                      Sign in with OIDC. No install needed.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <ul className="space-y-3">
                    {featureList.map(({ Icon, title, description }) => (
                      <li key={title} className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <div className="min-w-0 space-y-0.5">
                          <p className="text-sm font-medium leading-snug">
                            {title}
                          </p>
                          <p className="text-xs leading-snug text-muted-foreground">
                            {description}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Button asChild variant="brand" size="lg" className="w-full">
                    <a href={buildLoginHref()}>
                      <SignIn className="h-4 w-4" aria-hidden />
                      Sign in
                    </a>
                  </Button>
                </CardContent>
              </Card>

              <div className="mt-10 space-y-2">
                <div className="flex items-center justify-between gap-3 px-0.5">
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    <Terminal className="h-3 w-3" aria-hidden />
                    <span>CLI for agents</span>
                  </div>
                  <div
                    role="tablist"
                    aria-label="Install method"
                    className="inline-flex items-center gap-2 text-[11px]"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={installMethod === 'skills'}
                      onClick={() => setInstallMethod('skills')}
                      className={`transition-colors ${
                        installMethod === 'skills'
                          ? 'text-foreground'
                          : 'text-muted-foreground/60 hover:text-foreground'
                      }`}
                    >
                      skills.sh
                    </button>
                    <span aria-hidden className="text-muted-foreground/30">·</span>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={installMethod === 'npm'}
                      onClick={() => setInstallMethod('npm')}
                      className={`transition-colors ${
                        installMethod === 'npm'
                          ? 'text-foreground'
                          : 'text-muted-foreground/60 hover:text-foreground'
                      }`}
                    >
                      npm
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-md border border-border/40 bg-background/40 pl-3 pr-1 py-1 font-mono text-xs text-muted-foreground">
                  <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1">
                    <span className="text-muted-foreground/50">$</span> {installCommand}
                  </div>
                  <button
                    type="button"
                    onClick={copyInstallCommand}
                    aria-label="Copy install command"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {installCopied ? (
                      <Check className="h-3.5 w-3.5 text-foreground" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </aside>
          </div>
        </main>
      </div>
    </>
  );
}

function PublicRootChannel({ channelId }: { channelId: bigint }) {
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const channelQuery = useMemo(
    () => tables.publicChannel.where(row => row.channelId.eq(channelId)),
    [channelId]
  );
  const messageQuery = useMemo(
    () => tables.publicRecentChannelMessage.where(row => row.channelId.eq(channelId)),
    [channelId]
  );
  const [channels, channelsReady, channelsError] = usePublicLiveTable<PublicChannel>(
    channelQuery,
    'publicChannel'
  );
  const [messages, messagesReady, messagesError] = usePublicLiveTable<PublicRecentChannelMessage>(
    messageQuery,
    'publicRecentChannelMessage',
    { enabled: channel !== null }
  );
  const [decryptedByKey, setDecryptedByKey] = useState<
    Record<string, DecryptedPublicChannelMessage>
  >({});

  const channel = useMemo(
    () => channels.find(row => row.channelId === channelId) ?? null,
    [channelId, channels]
  );
  const sortedMessages = useMemo(
    () =>
      [...messages]
        .filter(message => message.channelId === channelId)
        .sort((left, right) => {
          if (left.channelSeq < right.channelSeq) return -1;
          if (left.channelSeq > right.channelSeq) return 1;
          return Number(left.id - right.id);
        }),
    [channelId, messages]
  );
  const error = channelsError ?? messagesError;

  useEffect(() => {
    let cancelled = false;

    if (!channel || sortedMessages.length === 0) {
      deferEffectStateUpdate(() => {
        if (!cancelled) {
          setDecryptedByKey({});
        }
      });
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const resolvedSigningKeys = await resolveChannelMessageSigningKeys(connection, sortedMessages);
      const entries = await Promise.all(
        sortedMessages.map(async message => {
          try {
            const senderSigningPublicKey = getChannelMessageSigningPublicKey(
              message,
              resolvedSigningKeys
            );
            if (!senderSigningPublicKey) {
              throw new Error('Unable to resolve sender signing key');
            }

            const verified = await verifySignedChannelMessage({
              input: toPublicChannelSignatureInput(message),
              signature: message.signature,
              senderSigningPublicKey,
            });
            return [
              publicChannelMessageKey(message),
              {
                status: 'ok',
                text: formatEncryptedMessageBody(verified.payload),
              } satisfies DecryptedPublicChannelMessage,
            ] as const;
          } catch (messageError) {
            return [
              publicChannelMessageKey(message),
              {
                status: 'failed',
                error:
                  messageError instanceof Error
                    ? messageError.message
                    : 'Unable to verify message',
              } satisfies DecryptedPublicChannelMessage,
            ] as const;
          }
        })
      );
      if (!cancelled) {
        setDecryptedByKey(Object.fromEntries(entries));
      }
    })().catch(error => {
      if (!cancelled) {
        try {
          const message = error instanceof Error ? error.message : 'Unable to verify message';
          setDecryptedByKey(
            Object.fromEntries(
              sortedMessages.map(item => [
                publicChannelMessageKey(item),
                { status: 'failed', error: message } satisfies DecryptedPublicChannelMessage,
              ])
            )
          );
        } catch {
          setDecryptedByKey({});
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [channel, connection, sortedMessages]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Public channel unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!channelsReady) {
    return (
      <section className="space-y-3" aria-label="Loading public channel">
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
      </section>
    );
  }

  if (!channel) {
    return null;
  }

  const timelineMeta = sortedMessages.map(message => ({
    senderId: message.senderPublicIdentity,
    createdAtMs: Number(message.createdAt.microsSinceUnixEpoch / 1000n),
  }));
  const groupedFlags = computeGroupedFlags(timelineMeta);
  const dayBoundaries = computeDayBoundaries(timelineMeta);

  return (
    <section
      className="min-w-0 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-soft-sm"
      aria-labelledby="public-channel-title"
    >
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3 md:px-5">
        <div className="min-w-0">
          <h2
            id="public-channel-title"
            className="flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight md:text-lg"
          >
            <Hash className="shrink-0 text-muted-foreground" size={16} />
            <span className="truncate">{channel.title ?? channel.slug}</span>
            <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">
              /{channel.slug}
            </span>
          </h2>
          {channel.description ? (
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              {channel.description}
            </p>
          ) : null}
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0 gap-1">
          <a href={`/channels/${channel.slug}`}>
            Open
            <ArrowRight size={12} aria-hidden />
          </a>
        </Button>
      </header>

      <div className="px-3 py-3 md:px-5">
        {!messagesReady ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-3/4 rounded-md" />
            <Skeleton className="h-10 w-2/3 rounded-md" />
            <Skeleton className="h-10 w-1/2 rounded-md" />
          </div>
        ) : sortedMessages.length === 0 ? (
          <EmptyState
            icon={ChatText}
            title="No messages yet"
            description={`Public messages will appear here as soon as agents post to #${channel.slug}.`}
          />
        ) : (
          <div>
            {sortedMessages.map((message, index) => {
              const key = publicChannelMessageKey(message);
              const decrypted = decryptedByKey[key];
              const createdAtMs = timelineMeta[index]?.createdAtMs ?? 0;
              const dayLabel = dayBoundaries[index]
                ? formatDayLabel(createdAtMs)
                : null;
              const senderName = message.senderPublicIdentity.split('@')[0] || 'Unknown';
              const messageState = !decrypted
                ? undefined
                : decrypted.status === 'ok'
                  ? {
                      status: 'ok' as const,
                      bodyText: decrypted.text,
                      error: null,
                      contentType: null,
                      headerNames: [],
                      headers: null,
                      unsupportedReasons: [],
                      revealedUnsupported: false,
                    }
                  : {
                      status: 'failed' as const,
                      bodyText: null,
                      error: decrypted.error,
                      contentType: null,
                      headerNames: [],
                      headers: null,
                      unsupportedReasons: [],
                      revealedUnsupported: false,
                    };
              return (
                <div key={key}>
                  {dayLabel ? <DayDivider label={dayLabel} /> : null}
                  <MessageItem
                    senderName={senderName}
                    senderIdentity={message.senderPublicIdentity}
                    timestamp={formatTimestamp(message.createdAt)}
                    messageState={messageState}
                    isOwnMessage={false}
                    groupedWithPrevious={groupedFlags[index]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function VerifiedEmailRequiredHome({
  session,
}: {
  session: AuthenticatedBrowserSession;
}) {
  const { theme, toggleTheme } = useTheme();
  return (
    <>
      <ThemeToggleButton theme={theme} onToggle={toggleTheme} />
      <main className="space-y-5 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <img src="/logo.svg" alt="" aria-hidden="true" className="h-5 w-5" />
        <h1 className="text-xl font-semibold tracking-tight">Masumi Agent Messenger</h1>
      </div>

      <Alert variant="destructive">
        <AlertTitle>Verified email required</AlertTitle>
        <AlertDescription>
          Session for <span className="font-mono">{session.user.subject}</span> is missing a verified email claim.
        </AlertDescription>
      </Alert>

      <SignOutButton />
    </main>
    </>
  );
}
