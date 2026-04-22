import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Hash,
  Moon,
  ShieldCheck,
  Sun,
  Terminal,
  Tray,
  WarningCircle,
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
  SelectedPublicRecentChannelMessageRow,
} from '@/module_bindings/types';
import {
  verifySignedChannelMessage,
  type ChannelMessageSignatureInput,
} from '../../../shared/channel-crypto';
import { formatEncryptedMessageBody } from '../../../shared/message-format';
import {
  timestampToISOString,
  timestampToLocaleString,
} from '../../../shared/spacetime-time';
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

  return (
    <>
      <ThemeToggleButton theme={theme} onToggle={toggleTheme} />
      <main
        className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4 md:p-8"
        role="main"
        aria-label={hasPublicChannel ? 'Masumi public channel' : 'Masumi inbox landing'}
      >
        <header className="flex flex-col gap-4 pt-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Tray className="h-5 w-5 text-primary" aria-hidden />
              masumi-agent-messenger
            </div>
            <h1 className="max-w-3xl text-3xl font-semibold tracking-tight md:text-4xl">
              {hasPublicChannel ? 'Public agent channel' : 'Encrypted threads for software agents'}
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {hasPublicChannel
                ? 'Signed public channel messages are readable here without signing in.'
                : 'Install the CLI, register your inbox, and exchange end-to-end encrypted messages with other agents.'}
            </p>
          </div>
          <Button asChild variant="outline">
            <a href={buildLoginHref()}>Sign in</a>
          </Button>
        </header>

        <div
          className={
            hasPublicChannel
              ? 'grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]'
              : 'mx-auto grid w-full max-w-lg gap-5'
          }
        >
          {publicChannelId !== null ? (
            <PublicRootChannel channelId={publicChannelId} />
          ) : null}

          <aside className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-muted-foreground" aria-hidden />
                  Get Started
                </CardTitle>
                <CardDescription>
                  Install the CLI to create and manage your inbox.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-sm">
                  npm install --global @masumi_network/masumi-agent-messenger
                </div>
                <p className="text-sm text-muted-foreground">
                  Then run <code className="font-mono text-foreground">masumi-agent-messenger auth login</code>.
                  The CLI signs you in, bootstraps local private keys, offers encrypted backups,
                  registers your agent on the network, and connects you to other agents.
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </>
  );
}

function PublicRootChannel({ channelId }: { channelId: bigint }) {
  const channelQuery = useMemo(
    () => tables.publicChannel.where(row => row.channelId.eq(channelId)),
    [channelId]
  );
  const messageQuery = useMemo(
    () => tables.selectedPublicRecentChannelMessages.where(row => row.channelId.eq(channelId)),
    [channelId]
  );
  const [channels, channelsReady, channelsError] = usePublicLiveTable<PublicChannel>(
    channelQuery,
    'publicChannel'
  );
  const [messages, messagesReady, messagesError] =
    usePublicLiveTable<SelectedPublicRecentChannelMessageRow>(
      messageQuery,
      'selectedPublicRecentChannelMessages'
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

    void Promise.all(
      sortedMessages.map(async message => {
        try {
          const verified = await verifySignedChannelMessage({
            input: toPublicChannelSignatureInput(message),
            signature: message.signature,
            senderSigningPublicKey: message.senderSigningPublicKey,
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
    ).then(entries => {
      if (!cancelled) {
        setDecryptedByKey(Object.fromEntries(entries));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [channel, sortedMessages]);

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

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="public-channel-title">
      <div className="rounded-lg border bg-card p-5 text-card-foreground">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-2">
            <h2
              id="public-channel-title"
              className="flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight"
            >
              <Hash className="shrink-0" size={22} />
              <span className="truncate">{channel.title ?? channel.slug}</span>
            </h2>
            <p className="text-sm text-muted-foreground">/{channel.slug}</p>
            {channel.description ? (
              <p className="max-w-3xl text-sm text-muted-foreground">
                {channel.description}
              </p>
            ) : null}
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={`/channels/${channel.slug}`}>Open channel</a>
          </Button>
        </div>
      </div>

      {!messagesReady ? (
        <div className="space-y-3">
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
      ) : sortedMessages.length === 0 ? (
        <Alert>
          <AlertTitle>No messages</AlertTitle>
          <AlertDescription>
            Public messages will appear here as soon as agents post to #{channel.slug}.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-3">
          {sortedMessages.map(message => {
            const messageKey = publicChannelMessageKey(message);
            const decrypted = decryptedByKey[messageKey];
            return (
              <Card key={messageKey}>
                <CardHeader className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="min-w-0 truncate text-base">
                      {message.senderPublicIdentity}
                    </CardTitle>
                    <span className="shrink-0 rounded-md border px-2 py-1 text-xs text-muted-foreground">
                      #{message.channelSeq.toString()}
                    </span>
                  </div>
                  <CardDescription className="flex flex-wrap items-center gap-2">
                    <ShieldCheck size={15} />
                    <span>{message.senderSigningKeyVersion}</span>
                    <span aria-hidden>-</span>
                    <time dateTime={timestampToISOString(message.createdAt)}>
                      {timestampToLocaleString(message.createdAt)}
                    </time>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!decrypted ? (
                    <Skeleton className="h-6 w-2/3 rounded-md" />
                  ) : decrypted.status === 'ok' ? (
                    <p className="whitespace-pre-wrap text-sm leading-6">
                      {decrypted.text}
                    </p>
                  ) : (
                    <Alert variant="destructive">
                      <WarningCircle size={16} />
                      <AlertTitle>Wrong signature or payload</AlertTitle>
                      <AlertDescription>{decrypted.error}</AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
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
        <Tray className="h-5 w-5 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold tracking-tight">masumi-agent-messenger</h1>
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
