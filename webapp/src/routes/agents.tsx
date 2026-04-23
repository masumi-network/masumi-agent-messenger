import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Copy,
  Plus,
  ShieldCheck,
  Trash,
  Users,
} from '@phosphor-icons/react';
import { useReducer } from 'spacetimedb/tanstack';
import { AGENT_ACCENT, AgentAvatar, getAgentColorIndex } from '@/components/inbox/agent-avatar';
import { KeyVaultDialog } from '@/components/key-vault-form';
import { EmptyState } from '@/components/inbox/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { describeActor } from '@/lib/agent-directory';
import { getOrCreateAgentKeyPair, setActiveActorIdentity } from '@/lib/agent-session';
import { buildWorkspaceSearch, describeLocalVaultRequirement } from '@/lib/app-shell';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { buildRouteHead } from '@/lib/seo';
import { useKeyVault } from '@/hooks/use-key-vault';
import {
  deregisterBrowserInboxAgent,
  registerBrowserInboxAgent,
  readActorRegistrationMetadata,
} from '@/lib/inbox-agent-registration';
import { queueKeyBackupPrompt } from '@/lib/key-backup-prompt';
import { reducers } from '@/module_bindings';
import { cn } from '@/lib/utils';
import {
  buildMasumiRegistrationSyncKey,
  canAttemptManagedAgentDeregistration,
  canAttemptManagedAgentRegistration,
  getActorPublishedCapabilities,
  getActorSupportedContentTypes,
  getActorSupportedHeaderNames,
  inferAllowAllFromSelection,
  toggleSelection,
} from '@/features/workspace/actor-settings';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { useWorkspaceWriteAccess } from '@/features/workspace/use-write-access';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';
import { MAX_PUBLIC_DESCRIPTION_CHARS } from '../../../shared/contact-policy';
import {
  createEmptyMasumiRegistrationResult,
  isDeregisteringOrDeregisteredInboxAgentState,
  registrationResultFromMetadata,
  type MasumiRegistrationResult,
} from '../../../shared/inbox-agent-registration';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  STANDARD_MESSAGE_CONTENT_TYPES,
  STANDARD_MESSAGE_HEADER_NAMES,
} from '../../../shared/message-format';

export const Route = createFileRoute('/agents')({
  head: () =>
    buildRouteHead({
      title: 'My agents',
      description:
        'Manage inbox identities, encryption keys, and Masumi network registration.',
      path: '/agents',
    }),
  component: AgentsPage,
});

type ManagedAgentDetailsTab = 'profile' | 'registration';
type AgentsPageProps = {
  signInReturnTo?: string;
};

function getManagedRegistrationLabel(
  registration: MasumiRegistrationResult
): string {
  switch (registration.registrationState) {
    case 'DeregistrationConfirmed':
      return 'Deregistered';
    case 'DeregistrationRequested':
    case 'DeregistrationInitiated':
      return 'Deregistering';
    default:
      break;
  }

  switch (registration.status) {
    case 'registered':
      return 'Registered';
    case 'deregistered':
      return 'Deregistered';
    case 'pending':
      return 'Pending';
    case 'failed':
    case 'service_unavailable':
    case 'scope_missing':
      return 'Error';
    default:
      return 'Not registered';
  }
}

export function AgentsPage({ signInReturnTo = '/agents' }: AgentsPageProps = {}) {
  const navigate = useNavigate();
  const vault = useKeyVault();
  const workspace = useWorkspaceShell();
  const session = workspace.status === 'ready' ? workspace.session : null;
  const connected = workspace.status === 'ready' ? workspace.connected : false;

  const [selectedOwnedAgentSlug, setSelectedOwnedAgentSlug] = useState<string | null>(null);
  const [managedAgentTab, setManagedAgentTab] =
    useState<ManagedAgentDetailsTab>('profile');
  const [publicDescriptionDraft, setPublicDescriptionDraft] = useState('');
  const [agentsPage, setAgentsPage] = useState(1);
  const AGENTS_PAGE_SIZE = 10;

  const [newSlug, setNewSlug] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [showCreateAgentDialog, setShowCreateAgentDialog] = useState(false);
  const [showVaultDialog, setShowVaultDialog] = useState(false);
  const [showDeregisterAgentDialog, setShowDeregisterAgentDialog] = useState(false);
  const [deregisterConfirmationSlug, setDeregisterConfirmationSlug] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [inboxAgentAction, setInboxAgentAction] =
    useState<'register' | 'deregister' | null>(null);
  const [publicLinkedEmailBusy, setPublicLinkedEmailBusy] = useState(false);
  const [publicMessageCapabilitiesBusy, setPublicMessageCapabilitiesBusy] =
    useState(false);
  const [publicDescriptionBusy, setPublicDescriptionBusy] = useState(false);
  const [managedAgentRegistration, setManagedAgentRegistration] =
    useState<MasumiRegistrationResult>(createEmptyMasumiRegistrationResult());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createInboxIdentityReducer = useReducer(reducers.createInboxIdentity);
  const upsertMasumiInboxAgentRegistrationReducer = useReducer(
    reducers.upsertMasumiInboxAgentRegistration
  );
  const setAgentPublicLinkedEmailVisibilityReducer = useReducer(
    reducers.setAgentPublicLinkedEmailVisibility
  );
  const setAgentPublicDescriptionReducer = useReducer(
    reducers.setAgentPublicDescription
  );
  const setAgentPublicMessageCapabilitiesReducer = useReducer(
    reducers.setAgentPublicMessageCapabilities
  );
  const inboxAgentBusy = inboxAgentAction !== null;

  const normalizedEmail = useMemo(
    () =>
      workspace.status === 'ready'
        ? normalizeEmail(workspace.session.user.email ?? '')
        : '',
    [workspace]
  );
  const existingDefaultActor =
    workspace.status === 'ready' ? workspace.existingDefaultActor : null;
  const subscribedOwnedAgentEntries = useMemo(
    () => (workspace.status === 'ready' ? workspace.ownedInboxAgents : []),
    [workspace]
  );
  const ownedAgentRegistrationRefresh =
    workspace.status === 'ready'
      ? workspace.ownedInboxAgentRegistrationRefresh
      : null;
  const ownedAgentEntries = useMemo(
    () =>
      subscribedOwnedAgentEntries.map(entry => {
        const actor = entry.actor;
        const actorId = actor.id.toString();
        const sourceSyncKey = buildMasumiRegistrationSyncKey(actor);
        const metadata = readActorRegistrationMetadata(actor);
        const baseRegistration = registrationResultFromMetadata(metadata);
        const refreshedRegistration =
          ownedAgentRegistrationRefresh?.resultsByActorId[actorId];
        const refreshError = ownedAgentRegistrationRefresh?.errorsByActorId[actorId];
        const registration =
          refreshedRegistration &&
          refreshedRegistration.sourceSyncKey === sourceSyncKey
            ? refreshedRegistration.registration
            : refreshError
              ? {
                  ...baseRegistration,
                  attempted: true,
                  error: refreshError,
                  status:
                    baseRegistration.status === 'skipped'
                      ? 'service_unavailable'
                      : baseRegistration.status,
                }
              : baseRegistration;
        return {
          ...entry,
          actor,
          registration,
          managed:
            metadata !== null ||
            registration.attempted ||
            registration.error !== null,
          registered: registration.status === 'registered',
          deregistered: isDeregisteringOrDeregisteredInboxAgentState(
            registration.registrationState
          ),
        };
      }),
    [ownedAgentRegistrationRefresh, subscribedOwnedAgentEntries]
  );
  const ownedAgents = useMemo(
    () => ownedAgentEntries.map(entry => entry.actor),
    [ownedAgentEntries]
  );
  useEffect(() => {
    if (ownedAgents.length === 0 && selectedOwnedAgentSlug !== null) {
      return deferEffectStateUpdate(() => {
        setSelectedOwnedAgentSlug(null);
      });
    }

    if (
      selectedOwnedAgentSlug &&
      !ownedAgents.some(actor => actor.slug === selectedOwnedAgentSlug)
    ) {
      return deferEffectStateUpdate(() => {
        setSelectedOwnedAgentSlug(null);
      });
    }
  }, [ownedAgents, selectedOwnedAgentSlug]);

  const selectedOwnedAgentEntry = useMemo(
    () =>
      ownedAgentEntries.find(entry => entry.actor.slug === selectedOwnedAgentSlug) ??
      null,
    [ownedAgentEntries, selectedOwnedAgentSlug]
  );
  const selectedOwnedAgent = selectedOwnedAgentEntry?.actor ?? null;
  const selectedOwnedAgentSupportedContentTypes = useMemo(
    () => (selectedOwnedAgent ? getActorSupportedContentTypes(selectedOwnedAgent) : []),
    [selectedOwnedAgent]
  );
  const selectedOwnedAgentSupportedHeaderNames = useMemo(
    () => (selectedOwnedAgent ? getActorSupportedHeaderNames(selectedOwnedAgent) : []),
    [selectedOwnedAgent]
  );
  const selectedOwnedAgentRegistrationBase = useMemo(() => {
    return selectedOwnedAgentEntry?.registration ?? createEmptyMasumiRegistrationResult();
  }, [selectedOwnedAgentEntry]);

  const writeAccess = useWorkspaceWriteAccess({
    connected,
    session,
    normalizedSessionEmail:
      workspace.status === 'ready' ? workspace.normalizedEmail : null,
    inbox: workspace.status === 'ready' ? workspace.ownedInbox : null,
    connectionIdentity:
      workspace.status === 'ready' ? workspace.conn.identity ?? null : null,
    hasActor: Boolean(selectedOwnedAgent ?? existingDefaultActor),
  });
  const canCreate = writeAccess.canWrite && Boolean(existingDefaultActor);
  const canManageSelectedAgent =
    writeAccess.canWrite &&
    Boolean(selectedOwnedAgent);
  const needsBootstrapRedirect =
    workspace.status === 'ready' && workspace.tablesReady && !existingDefaultActor;

  useEffect(() => {
    if (!needsBootstrapRedirect) {
      return;
    }

    void navigate({
      to: '/',
      replace: true,
    });
  }, [navigate, needsBootstrapRedirect]);

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setPublicDescriptionDraft(selectedOwnedAgent?.publicDescription ?? '');
      setManagedAgentTab('profile');
    });
  }, [selectedOwnedAgent?.id, selectedOwnedAgent?.publicDescription]);

  useEffect(() => {
    if (vault.unlocked) {
      return deferEffectStateUpdate(() => {
        setShowVaultDialog(false);
      });
    }
  }, [vault.unlocked]);

  useEffect(() => {
    if (inboxAgentBusy) {
      return;
    }

    return deferEffectStateUpdate(() => {
      setManagedAgentRegistration(
        selectedOwnedAgent
          ? selectedOwnedAgentRegistrationBase
          : createEmptyMasumiRegistrationResult()
      );
    });
  }, [
    inboxAgentBusy,
    selectedOwnedAgent,
    selectedOwnedAgentRegistrationBase,
  ]);

  const canRegisterManagedAgent = useMemo(
    () => canAttemptManagedAgentRegistration(managedAgentRegistration),
    [managedAgentRegistration]
  );
  const canDeregisterManagedAgent = useMemo(
    () => canAttemptManagedAgentDeregistration(managedAgentRegistration),
    [managedAgentRegistration]
  );
  const deregisterConfirmationMatches =
    Boolean(selectedOwnedAgent) &&
    deregisterConfirmationSlug.trim() === selectedOwnedAgent?.slug;
  const registerManagedAgentLabel =
    managedAgentRegistration.registrationState === 'DeregistrationConfirmed' ||
    managedAgentRegistration.registrationState === 'DeregistrationRequested' ||
    managedAgentRegistration.registrationState === 'DeregistrationInitiated'
      ? 'Re-register managed agent'
      : 'Register managed agent';

  function resetMessages() {
    setError(null);
    setFeedback(null);
  }

  function openDeregisterManagedAgentDialog() {
    if (!selectedOwnedAgent) {
      return;
    }

    if (!canDeregisterManagedAgent) {
      setError('Only confirmed managed inbox-agent registrations can be deregistered.');
      return;
    }

    if (!canManageSelectedAgent) {
      setError(writeAccess.reason ?? 'Your current session is read-only.');
      return;
    }

    resetMessages();
    setDeregisterConfirmationSlug('');
    setShowDeregisterAgentDialog(true);
  }

  async function handleCreateAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!existingDefaultActor) {
      setError('Finish setting up your default agent first.');
      return;
    }

    if (!canCreate) {
      setError(writeAccess.reason ?? 'Your current session is read-only.');
      return;
    }

    if (!vault.unlocked) {
      setError(
        describeLocalVaultRequirement({
          initialized: vault.initialized,
          phrase: 'before creating a new agent',
        })
      );
      return;
    }

    const normalizedSlug = normalizeInboxSlug(newSlug);
    if (!normalizedSlug) {
      setError('Agent slug is required.');
      return;
    }

    setCreateBusy(true);
    resetMessages();

    try {
      const identity = {
        normalizedEmail,
        slug: normalizedSlug,
        inboxIdentifier: normalizedSlug,
      };
      const keyPair = await getOrCreateAgentKeyPair(identity);
      await Promise.resolve(
        createInboxIdentityReducer({
          slug: normalizedSlug,
          displayName: newDisplayName.trim() || undefined,
          encryptionPublicKey: keyPair.encryption.publicKey,
          encryptionKeyVersion: keyPair.encryption.keyVersion,
          encryptionAlgorithm: keyPair.encryption.algorithm,
          signingPublicKey: keyPair.signing.publicKey,
          signingKeyVersion: keyPair.signing.keyVersion,
          signingAlgorithm: keyPair.signing.algorithm,
        })
      );
      queueKeyBackupPrompt({
        normalizedEmail,
        slug: normalizedSlug,
        reason: 'created',
      });
      setActiveActorIdentity(identity);
      setNewSlug('');
      setNewDisplayName('');
      setSelectedOwnedAgentSlug(normalizedSlug);
      setShowCreateAgentDialog(false);
      setFeedback('Agent created. Export a backup to keep your keys safe.');
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'Unable to create the agent'
      );
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleRegisterManagedAgent() {
    if (!session || !selectedOwnedAgent) {
      return;
    }

    if (!canRegisterManagedAgent) {
      if (
        managedAgentRegistration.registrationState === 'RegistrationRequested' ||
        managedAgentRegistration.registrationState === 'RegistrationInitiated' ||
        managedAgentRegistration.registrationState === 'DeregistrationRequested' ||
        managedAgentRegistration.registrationState === 'DeregistrationInitiated'
      ) {
        setError(
          'This managed registration is still in progress on Masumi. Wait for it to finish or refresh the agent status before retrying.'
        );
      } else {
        setError(
          'This agent is already registered. You can retry after a failed, missing, stale, or deregistered registration state.'
        );
      }
      return;
    }

    if (!canManageSelectedAgent) {
      setError(writeAccess.reason ?? 'Your current session is read-only.');
      return;
    }

    setInboxAgentAction('register');
    resetMessages();

    try {
      if (!selectedOwnedAgent.publicLinkedEmailEnabled) {
        await Promise.resolve(
          setAgentPublicLinkedEmailVisibilityReducer({
            agentDbId: selectedOwnedAgent.id,
            enabled: true,
          })
        );
      }
      const result = await registerBrowserInboxAgent({
        session,
        actor: selectedOwnedAgent,
        persistRegistration: async payload => {
          await Promise.resolve(upsertMasumiInboxAgentRegistrationReducer(payload));
        },
      });
      setManagedAgentRegistration(result.registration);
      if (result.registration.status === 'registered') {
        setFeedback('Registration is confirmed on the Masumi network.');
      } else if (result.registration.status === 'pending') {
        setFeedback(
          'Registration submitted. It may take a moment to appear in the Masumi dashboard.'
        );
      } else if (result.registration.error) {
        setError(result.registration.error);
      }
    } catch (registrationError) {
      setError(
        registrationError instanceof Error
          ? registrationError.message
          : 'Registration failed'
      );
    } finally {
      setInboxAgentAction(null);
    }
  }

  async function handleDeregisterManagedAgent() {
    if (!session || !selectedOwnedAgent) {
      return;
    }

    if (!canDeregisterManagedAgent) {
      setError('Only confirmed managed inbox-agent registrations can be deregistered.');
      return;
    }

    if (!canManageSelectedAgent) {
      setError(writeAccess.reason ?? 'Your current session is read-only.');
      return;
    }

    if (!deregisterConfirmationMatches) {
      setError(`Type ${selectedOwnedAgent.slug} to confirm deregistration.`);
      return;
    }

    setInboxAgentAction('deregister');
    resetMessages();
    setShowDeregisterAgentDialog(false);
    setDeregisterConfirmationSlug('');

    try {
      const result = await deregisterBrowserInboxAgent({
        session,
        actor: selectedOwnedAgent,
        persistRegistration: async payload => {
          await Promise.resolve(upsertMasumiInboxAgentRegistrationReducer(payload));
        },
      });
      setManagedAgentRegistration(result.registration);
      if (
        result.registration.registrationState === 'DeregistrationRequested' ||
        result.registration.registrationState === 'DeregistrationInitiated'
      ) {
        setFeedback(
          'Deregistration submitted. It may take a moment to finish on the Masumi network.'
        );
      } else if (result.registration.registrationState === 'DeregistrationConfirmed') {
        setFeedback('Deregistration is confirmed on the Masumi network.');
      } else if (result.registration.error) {
        setError(result.registration.error);
      }
    } catch (deregistrationError) {
      setError(
        deregistrationError instanceof Error
          ? deregistrationError.message
          : 'Deregistration failed'
      );
    } finally {
      setInboxAgentAction(null);
    }
  }

  async function handleSetPublicLinkedEmailVisibility(enabled: boolean) {
    if (!selectedOwnedAgent) {
      return;
    }

    if (!canManageSelectedAgent) {
      setError(writeAccess.reason ?? 'Your current session is read-only.');
      return;
    }

    setPublicLinkedEmailBusy(true);
    resetMessages();

    try {
      await Promise.resolve(
        setAgentPublicLinkedEmailVisibilityReducer({
          agentDbId: selectedOwnedAgent.id,
          enabled,
        })
      );
      setFeedback(
        enabled
          ? 'Linked email will be included on the public endpoint.'
          : 'Linked email was removed from the public endpoint.'
      );
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : 'Unable to update linked email visibility'
      );
    } finally {
      setPublicLinkedEmailBusy(false);
    }
  }

  async function handleSetPublicDescription() {
    if (!selectedOwnedAgent) {
      return;
    }

    if (!canManageSelectedAgent) {
      setError(writeAccess.reason ?? 'Your current session is read-only.');
      return;
    }

    setPublicDescriptionBusy(true);
    resetMessages();

    try {
      const normalizedDescription = publicDescriptionDraft.trim();
      await Promise.resolve(
        setAgentPublicDescriptionReducer({
          agentDbId: selectedOwnedAgent.id,
          description: normalizedDescription || undefined,
        })
      );
      setFeedback(
        normalizedDescription
          ? 'Public description updated.'
          : 'Public description cleared.'
      );
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : 'Unable to update the public description'
      );
    } finally {
      setPublicDescriptionBusy(false);
    }
  }

  async function handleSetPublicMessageCapabilities(params: {
    allowAllContentTypes?: boolean;
    allowAllHeaders?: boolean;
    supportedContentTypes: string[];
    supportedHeaders: string[];
  }) {
    if (!selectedOwnedAgent) {
      return;
    }

    if (!canManageSelectedAgent) {
      setError(writeAccess.reason ?? 'Your current session is read-only.');
      return;
    }

    setPublicMessageCapabilitiesBusy(true);
    resetMessages();

    try {
      const currentCapabilities = getActorPublishedCapabilities(selectedOwnedAgent);
      await Promise.resolve(
        setAgentPublicMessageCapabilitiesReducer({
          agentDbId: selectedOwnedAgent.id,
          allowAllContentTypes:
            inferAllowAllFromSelection(params.supportedContentTypes)
              ? true
              : (params.allowAllContentTypes ?? currentCapabilities.allowAllContentTypes),
          allowAllHeaders:
            inferAllowAllFromSelection(params.supportedHeaders)
              ? true
              : (params.allowAllHeaders ?? currentCapabilities.allowAllHeaders),
          supportedContentTypes: params.supportedContentTypes,
          supportedHeaders: params.supportedHeaders,
        })
      );
      setFeedback('Public message capabilities updated.');
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : 'Unable to update public message capabilities'
      );
    } finally {
      setPublicMessageCapabilitiesBusy(false);
    }
  }

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="agents"
      title="My agents"
      signInReturnTo={signInReturnTo}
      signedOutDescription="Sign in to manage inbox identities, keys, and Masumi registration."
    >
      {needsBootstrapRedirect ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : (
        <div className="space-y-4">
          <KeyVaultDialog
            open={showVaultDialog}
            onOpenChange={setShowVaultDialog}
            mode={vault.initialized ? 'unlock' : 'setup'}
            busy={vault.submitting}
            error={vault.error}
            title={vault.initialized ? 'Unlock Private Keys' : 'Create Private Key Vault'}
            description="Unlock your vault before creating another agent."
            submitLabel={vault.initialized ? 'Unlock keys' : 'Create vault'}
            onSubmit={vault.handleSubmit}
          />

          <Dialog open={showCreateAgentDialog} onOpenChange={setShowCreateAgentDialog}>
            <DialogContent className="max-w-sm border-border bg-background/95">
              <DialogHeader>
                <DialogTitle>Create new agent</DialogTitle>
                <DialogDescription>
                  Add another agent to your account.
                </DialogDescription>
              </DialogHeader>
              <form className="space-y-3" onSubmit={handleCreateAgent}>
                <Input
                  value={newSlug}
                  onChange={event => setNewSlug(event.target.value)}
                  placeholder="my-agent"
                  disabled={!canCreate || createBusy}
                  className="font-mono"
                />
                <Input
                  value={newDisplayName}
                  onChange={event => setNewDisplayName(event.target.value)}
                  placeholder="Display name (optional)"
                  disabled={!canCreate || createBusy}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!canCreate || createBusy}
                >
                  <Plus className="h-4 w-4" />
                  {createBusy ? 'Creating...' : 'Register new agent'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog
            open={showDeregisterAgentDialog}
            onOpenChange={open => {
              if (inboxAgentBusy) {
                return;
              }
              setShowDeregisterAgentDialog(open);
              if (!open) {
                setDeregisterConfirmationSlug('');
              }
            }}
          >
            <DialogContent className="max-w-md border-destructive/30 bg-background/95">
              <DialogHeader>
                <DialogTitle>Deregister managed agent</DialogTitle>
                <DialogDescription>
                  This removes the selected agent from Masumi network discovery.
                </DialogDescription>
              </DialogHeader>
              {selectedOwnedAgent ? (
                <form
                  className="space-y-4"
                  onSubmit={event => {
                    event.preventDefault();
                    void handleDeregisterManagedAgent();
                  }}
                >
                  <Alert variant="destructive">
                    <AlertTitle>Confirm deregistration</AlertTitle>
                    <AlertDescription>
                      /{selectedOwnedAgent.slug} will no longer be available for new chats
                      through Masumi discovery. Local inbox history and the SpacetimeDB agent
                      row remain in place.
                    </AlertDescription>
                  </Alert>
                  <div className="space-y-2">
                    <Label htmlFor="deregister-confirm-slug">
                      Type the agent slug to continue
                    </Label>
                    <Input
                      id="deregister-confirm-slug"
                      value={deregisterConfirmationSlug}
                      onChange={event =>
                        setDeregisterConfirmationSlug(event.target.value)
                      }
                      placeholder={selectedOwnedAgent.slug}
                      disabled={inboxAgentBusy}
                      className="font-mono"
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowDeregisterAgentDialog(false)}
                      disabled={inboxAgentBusy}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="destructive"
                      disabled={
                        inboxAgentBusy ||
                        !canDeregisterManagedAgent ||
                        !deregisterConfirmationMatches
                      }
                    >
                      <Trash className="h-4 w-4" />
                      {inboxAgentAction === 'deregister'
                        ? 'Deregistering...'
                        : 'Deregister agent'}
                    </Button>
                  </DialogFooter>
                </form>
              ) : null}
            </DialogContent>
          </Dialog>

          {(feedback || error) ? (
            <div className="space-y-2">
              {feedback ? (
                <Alert variant="info" onDismiss={() => setFeedback(null)}>
                  <AlertDescription>{feedback}</AlertDescription>
                </Alert>
              ) : null}
              {error ? (
                <Alert variant="destructive" onDismiss={() => setError(null)}>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">My agents</p>
              <p className="text-xs text-muted-foreground">
                Select an agent to edit its profile and registration.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!existingDefaultActor || !writeAccess.canWrite || vault.loading}
              onClick={() => {
                if (vault.unlocked) {
                  setShowCreateAgentDialog(true);
                  return;
                }

                setShowVaultDialog(true);
              }}
            >
              <Plus className="h-4 w-4" />
              {vault.unlocked ? 'New agent' : 'Unlock to create'}
            </Button>
          </div>

          {ownedAgentEntries.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No agents yet"
              description="Add more agents once your default agent is ready."
            />
          ) : (
            <div className="space-y-2">
              {ownedAgentEntries
                .slice((agentsPage - 1) * AGENTS_PAGE_SIZE, agentsPage * AGENTS_PAGE_SIZE)
                .map(entry => {
                const actor = entry.actor;
                const isExpanded = actor.slug === selectedOwnedAgent?.slug;
                const isSelectedActor = isExpanded && selectedOwnedAgent !== null;
                const accent = AGENT_ACCENT[getAgentColorIndex(actor.publicIdentity)];
                const rowRegistration = entry.registration;
                const rowRegistrationRefreshPending =
                  Boolean(
                    ownedAgentRegistrationRefresh?.busy &&
                      ownedAgentRegistrationRefresh.targetIds.has(actor.id.toString()) &&
                      ownedAgentRegistrationRefresh.completedKey !==
                        ownedAgentRegistrationRefresh.refreshKey
                  );
                const rowIsRegistered = rowRegistration.status === 'registered';
                const rowIsDeregistered = isDeregisteringOrDeregisteredInboxAgentState(
                  rowRegistration.registrationState
                );
                const rowIsPending = rowRegistration.status === 'pending';
                const rowHasError =
                  rowRegistration.error !== null ||
                  rowRegistration.status === 'failed' ||
                  rowRegistration.status === 'service_unavailable' ||
                  rowRegistration.status === 'scope_missing';
                const statusLabel = rowRegistrationRefreshPending
                  ? 'Refreshing'
                  : rowHasError
                    ? 'Error'
                    : rowIsDeregistered
                      ? rowRegistration.registrationState === 'DeregistrationConfirmed'
                        ? 'Deregistered'
                        : 'Deregistering'
                    : rowIsRegistered
                      ? 'Registered'
                    : rowIsPending
                      ? 'Pending'
                      : 'Unregistered';
                const statusClass = rowRegistrationRefreshPending
                  ? 'bg-muted text-muted-foreground ring-border'
                  : rowHasError
                    ? 'bg-rose-500/10 text-rose-500 ring-rose-500/30'
                    : rowIsDeregistered
                      ? 'bg-slate-500/10 text-slate-500 ring-slate-500/30'
                    : rowIsRegistered
                      ? 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/30'
                    : rowIsPending
                      ? 'bg-sky-500/10 text-sky-500 ring-sky-500/30'
                      : 'bg-amber-500/10 text-amber-500 ring-amber-500/30';

                return (
                  <div
                    key={actor.id.toString()}
                    className={cn(
                      'overflow-hidden rounded-lg border border-l-2 transition-colors',
                      isExpanded
                        ? cn('border-border bg-muted/20 ring-1', accent.bar, accent.ring)
                        : cn('border-border/60 border-l-transparent', accent.tint)
                    )}
                  >
                    <div className="flex w-full items-start gap-2 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.deregistered) {
                            return;
                          }
                          void navigate({
                            to: '/$slug',
                            params: { slug: actor.slug },
                            search: buildWorkspaceSearch({}),
                          });
                        }}
                        disabled={entry.deregistered}
                        className={cn(
                          'flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                          entry.deregistered && 'cursor-not-allowed opacity-70'
                        )}
                      >
                        <AgentAvatar
                          name={describeActor(actor)}
                          identity={actor.publicIdentity}
                          size="lg"
                        />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {describeActor(actor)}
                            </p>
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              /{actor.slug}
                            </span>
                            {actor.isDefault ? (
                              <Badge variant="secondary" className="text-[10px]">
                                Default
                              </Badge>
                            ) : null}
                            {entry.registered ? (
                              <Badge variant="secondary" className="text-[10px]">
                                <ShieldCheck className="mr-0.5 h-3 w-3" />
                                Published
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset',
                                statusClass
                              )}
                            >
                              <span
                                className={cn(
                                  'h-1.5 w-1.5 rounded-full',
                                  rowRegistrationRefreshPending
                                    ? 'bg-muted-foreground'
                                    : rowHasError
                                      ? 'bg-rose-500'
                                      : rowIsDeregistered
                                        ? 'bg-slate-500'
                                      : rowIsRegistered
                                      ? 'bg-emerald-500'
                                      : 'bg-amber-500'
                                )}
                                aria-hidden
                              />
                              {statusLabel}
                            </span>
                          </div>
                          {actor.publicDescription ? (
                            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                              {actor.publicDescription}
                            </p>
                          ) : null}
                          {rowRegistration.error ? (
                            <p className="line-clamp-2 text-xs leading-relaxed text-destructive">
                              {rowRegistration.error}
                            </p>
                          ) : null}
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? `Hide settings for ${describeActor(actor)}`
                            : `Show settings for ${describeActor(actor)}`
                        }
                        onClick={() =>
                          setSelectedOwnedAgentSlug(isExpanded ? null : actor.slug)
                        }
                        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <CaretDown
                          className={cn(
                            'h-4 w-4 transition-transform',
                            isExpanded && 'rotate-180'
                          )}
                        />
                      </button>
                    </div>

                    {isSelectedActor && selectedOwnedAgent ? (
                      <div className="animate-soft-enter border-t border-border/60 p-4">
                        <Tabs
                          value={managedAgentTab}
                          onValueChange={value =>
                            setManagedAgentTab(
                              value === 'registration' ? 'registration' : 'profile'
                            )
                          }
                          className="space-y-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 bg-background/70 p-3">
                            <div className="min-w-0">
                              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                Selected agent
                              </p>
                              <p className="mt-1 truncate text-sm font-medium text-foreground">
                                /{selectedOwnedAgent.slug}
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="gap-1.5"
                              onClick={openDeregisterManagedAgentDialog}
                              disabled={
                                !canManageSelectedAgent ||
                                inboxAgentBusy ||
                                !canDeregisterManagedAgent
                              }
                            >
                              <Trash className="h-3.5 w-3.5" />
                              {inboxAgentAction === 'deregister'
                                ? 'Deregistering...'
                                : 'Deregister'}
                            </Button>
                          </div>

                          <TabsList className="h-8 w-auto justify-start gap-0.5 rounded-lg bg-muted/50 p-0.5">
                            <TabsTrigger
                              value="profile"
                              className="rounded-md px-3 py-1 text-xs font-medium"
                            >
                              Profile
                            </TabsTrigger>
                            <TabsTrigger
                              value="registration"
                              className="rounded-md px-3 py-1 text-xs font-medium"
                            >
                              Registration
                            </TabsTrigger>
                          </TabsList>

                          <TabsContent value="profile" className="mt-0 space-y-3">
                            <div className="space-y-3">
                              <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                  Public profile
                                </p>
                                <Label className="mt-2 block text-xs text-muted-foreground">
                                  Description
                                </Label>
                                <Textarea
                                  value={publicDescriptionDraft}
                                  onChange={event =>
                                    setPublicDescriptionDraft(event.target.value)
                                  }
                                  maxLength={MAX_PUBLIC_DESCRIPTION_CHARS}
                                  rows={3}
                                  placeholder="A short public description of this inbox agent..."
                                  disabled={
                                    !canManageSelectedAgent || publicDescriptionBusy
                                  }
                                  className="mt-1 resize-none border-border text-sm"
                                />
                                <div className="mt-2 flex items-center justify-between">
                                  <p className="text-xs text-muted-foreground/70">
                                    {publicDescriptionDraft.length}/
                                    {MAX_PUBLIC_DESCRIPTION_CHARS}
                                  </p>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-7 text-xs"
                                    onClick={() => void handleSetPublicDescription()}
                                    disabled={
                                      !canManageSelectedAgent || publicDescriptionBusy
                                    }
                                  >
                                    Save description
                                  </Button>
                                </div>
                              </div>
                            </div>

                            <div className="space-y-2.5">
                              <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                  Reachability
                                </p>
                                <div className="mt-2 rounded-md bg-muted/40 px-3 py-2.5">
                                  <div className="flex items-center justify-between gap-3">
                                    <div>
                                      <p className="text-sm font-medium">
                                        Linked email visibility
                                      </p>
                                      <p className="mt-0.5 text-xs text-muted-foreground">
                                        {selectedOwnedAgent.publicLinkedEmailEnabled
                                          ? 'Email is visible on public endpoint.'
                                          : 'Email is hidden from public endpoint.'}
                                      </p>
                                    </div>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 text-xs"
                                      onClick={() =>
                                        void handleSetPublicLinkedEmailVisibility(
                                          !selectedOwnedAgent.publicLinkedEmailEnabled
                                        )
                                      }
                                      disabled={
                                        !canManageSelectedAgent || publicLinkedEmailBusy
                                      }
                                    >
                                      {selectedOwnedAgent.publicLinkedEmailEnabled
                                        ? 'Hide email'
                                        : 'Show email'}
                                    </Button>
                                  </div>
                                </div>
                              </div>

                              <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                  Supported content types
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {STANDARD_MESSAGE_CONTENT_TYPES.map(contentType => (
                                    <Button
                                      key={contentType}
                                      size="sm"
                                      variant={
                                        selectedOwnedAgentSupportedContentTypes.includes(
                                          contentType
                                        )
                                          ? 'default'
                                          : 'outline'
                                      }
                                      className="h-7 font-mono text-xs"
                                      onClick={() => {
                                        const nextContentTypes = toggleSelection(
                                          selectedOwnedAgentSupportedContentTypes,
                                          contentType
                                        );
                                        void handleSetPublicMessageCapabilities({
                                          allowAllContentTypes:
                                            inferAllowAllFromSelection(nextContentTypes),
                                          allowAllHeaders:
                                            getActorPublishedCapabilities(
                                              selectedOwnedAgent
                                            ).allowAllHeaders,
                                          supportedContentTypes: nextContentTypes,
                                          supportedHeaders:
                                            selectedOwnedAgentSupportedHeaderNames,
                                        });
                                      }}
                                      disabled={
                                        !canManageSelectedAgent ||
                                        publicMessageCapabilitiesBusy
                                      }
                                    >
                                      {contentType}
                                    </Button>
                                  ))}
                                </div>
                              </div>

                              <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                  Supported headers
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {STANDARD_MESSAGE_HEADER_NAMES.map(headerName => (
                                    <Button
                                      key={headerName}
                                      size="sm"
                                      variant={
                                        selectedOwnedAgentSupportedHeaderNames.includes(
                                          headerName
                                        )
                                          ? 'default'
                                          : 'outline'
                                      }
                                      className="h-7 font-mono text-xs"
                                      onClick={() => {
                                        const nextHeaders = toggleSelection(
                                          selectedOwnedAgentSupportedHeaderNames,
                                          headerName
                                        );
                                        void handleSetPublicMessageCapabilities({
                                          allowAllContentTypes:
                                            getActorPublishedCapabilities(
                                              selectedOwnedAgent
                                            ).allowAllContentTypes,
                                          allowAllHeaders:
                                            inferAllowAllFromSelection(nextHeaders),
                                          supportedContentTypes:
                                            selectedOwnedAgentSupportedContentTypes,
                                          supportedHeaders: nextHeaders,
                                        });
                                      }}
                                      disabled={
                                        !canManageSelectedAgent ||
                                        publicMessageCapabilitiesBusy
                                      }
                                    >
                                      {headerName}
                                    </Button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </TabsContent>

                          <TabsContent value="registration" className="mt-0">
                            <div className="space-y-3">
                              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                Registration status
                              </p>
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="secondary" className="text-[10px]">
                                  {getManagedRegistrationLabel(managedAgentRegistration)}
                                </Badge>
                                {managedAgentRegistration.creditsRemaining !== null &&
                                managedAgentRegistration.creditsRemaining !== undefined ? (
                                  <span className="font-mono text-xs text-muted-foreground">
                                    {managedAgentRegistration.creditsRemaining.toString()}{' '}
                                    credits
                                  </span>
                                ) : null}
                              </div>

                              {managedAgentRegistration.error ? (
                                <Alert variant="destructive">
                                  <AlertTitle>
                                    {managedAgentRegistration.status === 'registered' ||
                                    managedAgentRegistration.status === 'pending'
                                      ? 'Registration refresh issue'
                                      : 'Registration issue'}
                                  </AlertTitle>
                                  <AlertDescription>
                                    {managedAgentRegistration.error}
                                  </AlertDescription>
                                </Alert>
                              ) : null}

                              {managedAgentRegistration.registrationState ? (
                                <p className="font-mono text-xs text-muted-foreground">
                                  State: {managedAgentRegistration.registrationState}
                                </p>
                              ) : null}

                              {isDeregisteringOrDeregisteredInboxAgentState(
                                managedAgentRegistration.registrationState
                              ) ? (
                                <Alert>
                                  <AlertTitle>Deregistration in progress</AlertTitle>
                                  <AlertDescription>
                                    This agent is deregistering or deregistered
                                    on Masumi and cannot be used as an active
                                    inbox agent.
                                  </AlertDescription>
                                </Alert>
                              ) : null}

                              {managedAgentRegistration.status === 'skipped' &&
                              !isDeregisteringOrDeregisteredInboxAgentState(
                                managedAgentRegistration.registrationState
                              ) ? (
                                <Alert>
                                  <AlertTitle>Not registered yet</AlertTitle>
                                  <AlertDescription>
                                    This agent isn't registered yet. Click "Register managed agent" to create one.
                                  </AlertDescription>
                                </Alert>
                              ) : null}

                              {selectedOwnedAgent.masumiAgentIdentifier ? (
                                <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/30 p-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                                      Agent identifier
                                    </p>
                                    <p className="mt-1.5 break-all font-mono text-sm text-foreground">
                                      {selectedOwnedAgent.masumiAgentIdentifier}
                                    </p>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 shrink-0 px-2"
                                    onClick={() => {
                                      const identifier =
                                        selectedOwnedAgent.masumiAgentIdentifier;
                                      if (identifier) {
                                        void navigator.clipboard.writeText(identifier);
                                      }
                                    }}
                                    aria-label="Copy agent identifier"
                                  >
                                    <Copy className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ) : null}

                              <div className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => void handleRegisterManagedAgent()}
                                  disabled={
                                    !canManageSelectedAgent ||
                                    inboxAgentBusy ||
                                    !canRegisterManagedAgent
                                  }
                                >
                                  {inboxAgentAction === 'register'
                                    ? 'Registering…'
                                    : registerManagedAgentLabel}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="gap-1.5"
                                  onClick={openDeregisterManagedAgentDialog}
                                  disabled={
                                    !canManageSelectedAgent ||
                                    inboxAgentBusy ||
                                    !canDeregisterManagedAgent
                                  }
                                >
                                  <Trash className="h-3.5 w-3.5" />
                                  {inboxAgentAction === 'deregister'
                                    ? 'Deregistering…'
                                    : 'Deregister'}
                                </Button>
                              </div>
                            </div>
                          </TabsContent>
                        </Tabs>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {ownedAgentEntries.length > AGENTS_PAGE_SIZE ? (
                <div className="flex items-center justify-start gap-2 pt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={agentsPage <= 1}
                    onClick={() => setAgentsPage(current => Math.max(1, current - 1))}
                  >
                    <CaretLeft className="h-4 w-4" />
                    Prev
                  </Button>
                  <span className="min-w-14 text-center text-xs text-muted-foreground">
                    Page {agentsPage} of{' '}
                    {Math.max(
                      1,
                      Math.ceil(ownedAgentEntries.length / AGENTS_PAGE_SIZE)
                    )}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={
                      agentsPage >=
                      Math.ceil(ownedAgentEntries.length / AGENTS_PAGE_SIZE)
                    }
                    onClick={() => setAgentsPage(current => current + 1)}
                  >
                    Next
                    <CaretRight className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
    </WorkspaceRouteShell>
  );
}
