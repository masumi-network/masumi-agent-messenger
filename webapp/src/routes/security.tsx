import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Key, Shield } from '@phosphor-icons/react';
import { useLiveTable } from '@/lib/spacetime-live-table';
import { KeysRecoveryContent } from '@/components/app/keys-recovery-dialog';
import { VaultGate } from '@/components/app/vault-gate';
import { KeyVaultDialog } from '@/components/key-vault-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { parseSecurityPanel, buildWorkspaceSearch, type SecurityPanel } from '@/lib/app-shell';
import { buildRouteHead } from '@/lib/seo';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useKeyVault } from '@/hooks/use-key-vault';
import { tables } from '@/module_bindings';
import type { Device, VisibleDeviceKeyBundleRow } from '@/module_bindings/types';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';
import { useWorkspaceWriteAccess } from '@/features/workspace/use-write-access';
import {
  useSecurityRecovery,
  type SecurityLiveConnection,
} from '@/features/security/use-security-recovery';

export const Route = createFileRoute('/security')({
  validateSearch: search => ({
    panel: parseSecurityPanel(search.panel),
  }),
  head: () =>
    buildRouteHead({
      title: 'Security',
      description:
        'Manage key recovery, trusted devices, and encrypted backups for your inbox.',
      path: '/security',
    }),
  component: SecurityPage,
});

function SecurityPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const workspace = useWorkspaceShell();
  const vault = useKeyVault();
  const [userRequestedVaultDialog, setUserRequestedVaultDialog] = useState(false);
  const showVaultDialog = vault.unlocked ? false : userRequestedVaultDialog;

  const [devices, devicesReady, devicesError] = useLiveTable<Device>(
    tables.visibleDevices,
    'visibleDevices'
  );
  const [deviceShareBundles, deviceShareBundlesReady, deviceShareBundlesError] =
    useLiveTable<VisibleDeviceKeyBundleRow>(
      tables.visibleDeviceKeyBundles,
      'visibleDeviceKeyBundles'
    );

  const existingDefaultActor =
    workspace.status === 'ready' ? workspace.existingDefaultActor : null;
  const normalizedEmail =
    workspace.status === 'ready' ? workspace.normalizedEmail : '';
  const shellInboxSlug =
    workspace.status === 'ready' ? workspace.shellInboxSlug : null;
  const liveConnection =
    workspace.status === 'ready'
      ? ((workspace.conn.getConnection() ?? null) as SecurityLiveConnection | null)
      : null;

  const writeAccess = useWorkspaceWriteAccess({
    connected: workspace.status === 'ready' ? workspace.connected : false,
    session: workspace.status === 'ready' ? workspace.session : null,
    normalizedSessionEmail:
      workspace.status === 'ready' ? workspace.normalizedEmail : null,
    inbox: workspace.status === 'ready' ? workspace.ownedInbox : null,
    connectionIdentity:
      workspace.status === 'ready' ? workspace.conn.identity ?? null : null,
    hasActor: Boolean(existingDefaultActor),
  });

  const ownedDevices =
    existingDefaultActor === null
      ? []
      : devices
          .filter(device => device.inboxId === existingDefaultActor.inboxId)
          .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  const routeTablesReady =
    workspace.status === 'ready' &&
    workspace.tablesReady &&
    devicesReady &&
    deviceShareBundlesReady;
  const routeTablesError =
    workspace.status === 'ready'
      ? workspace.tablesError || devicesError || deviceShareBundlesError
      : null;
  const panel: SecurityPanel = search.panel ?? 'recovery';
  const handlePanelChange = (nextPanel: SecurityPanel) => {
    void navigate({
      to: '/security',
      search: { panel: nextPanel },
    });
  };
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

  const security = useSecurityRecovery({
    existingDefaultActor,
    normalizedEmail,
    liveConnection,
    canWrite: writeAccess.canWrite,
    writeReason: writeAccess.reason,
    vault,
    deviceShareBundles,
  });
  const primaryAction = !vault.unlocked
    ? {
        label: vault.initialized ? 'Unlock keys' : 'Create vault',
        onClick: () => setUserRequestedVaultDialog(true),
      }
    : security.defaultKeyIssue
      ? {
          label: 'Open recovery',
          onClick: () =>
            void navigate({
              to: '/security',
              search: { panel: 'recovery' },
            }),
        }
      : {
          label: 'Open backups',
          onClick: () =>
            void navigate({
              to: '/security',
              search: { panel: 'backups' },
            }),
        };

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="security"
      title="Security"
      signInReturnTo="/security"
      signedOutDescription="Sign in to manage security settings."
    >
      {() =>
        needsBootstrapRedirect ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        ) : (
        <>
          <KeyVaultDialog
            open={showVaultDialog}
            onOpenChange={setUserRequestedVaultDialog}
            mode={vault.initialized ? 'unlock' : 'setup'}
            busy={vault.submitting}
            error={vault.error}
            title={vault.initialized ? 'Unlock Private Keys' : 'Create Private Key Vault'}
            description="Unlock your vault to access security settings."
            submitLabel={vault.initialized ? 'Unlock keys' : 'Create vault'}
            onSubmit={vault.handleSubmit}
          />

          {(security.feedback || security.error || routeTablesError) ? (
            <div className="space-y-2">
              {security.feedback ? (
                <Alert variant="info" onDismiss={() => security.setFeedback(null)}>
                  <AlertDescription>{security.feedback}</AlertDescription>
                </Alert>
              ) : null}
              {security.error ? (
                <Alert variant="destructive" onDismiss={() => security.setError(null)}>
                  <AlertDescription>{security.error}</AlertDescription>
                </Alert>
              ) : null}
              {routeTablesError ? (
                <Alert variant="destructive">
                  <AlertTitle>Security state unavailable</AlertTitle>
                  <AlertDescription>{routeTablesError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          {existingDefaultActor ? (
            <div className="space-y-6">
              <section className="grid gap-4">
                <Card className="border-border">
                  <CardHeader>
                    <CardTitle>Inbox security</CardTitle>
                    <CardDescription>
                      Recovery, trusted devices, and backups apply to your whole inbox.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-md border border-border px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                          Default inbox
                        </p>
                        <p className="mt-2 font-mono text-sm">/{existingDefaultActor.slug}</p>
                      </div>
                      <div className="rounded-md border border-border px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                          Vault
                        </p>
                        <p className="mt-2 text-sm">
                          {vault.loading
                            ? 'Checking'
                            : vault.unlocked
                              ? 'Unlocked'
                              : vault.initialized
                                ? 'Locked'
                                : 'Not created'}
                        </p>
                      </div>
                      <div className="rounded-md border border-border px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                          Key state
                        </p>
                        <p
                          className={`mt-2 text-sm ${
                            security.defaultKeyIssue
                              ? ''
                              : 'font-medium text-amber-700 dark:text-amber-300'
                          }`}
                        >
                          {security.defaultKeyIssue === 'missing'
                            ? 'Missing'
                            : security.defaultKeyIssue === 'mismatch'
                              ? 'Outdated'
                              : 'Warning: keys already exist on this device'}
                        </p>
                      </div>
                    </div>
                    <Button className="w-full justify-start" onClick={primaryAction.onClick}>
                      {primaryAction.label}
                    </Button>
                  </CardContent>
                </Card>
              </section>

              {routeTablesReady ? (
                <VaultGate
                  vault={vault}
                  title={
                    vault.initialized ? 'Unlock Private Keys' : 'Create Private Key Vault'
                  }
                  description={
                    vault.initialized
                      ? 'Unlock your browser vault before managing recovery, device shares, and backups.'
                      : 'Create a vault passphrase before storing any private inbox keys in this browser.'
                  }
                >
                  <Tabs
                    value={panel}
                    onValueChange={value => handlePanelChange(value as SecurityPanel)}
                    className="space-y-4"
                  >
                    <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-xl border border-border bg-card p-1">
                      <TabsTrigger value="recovery" className="gap-1.5">
                        <Key className="h-4 w-4" />
                        Recovery
                      </TabsTrigger>
                      <TabsTrigger value="backups" className="gap-1.5">
                        <Shield className="h-4 w-4" />
                        Backups
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="recovery" className="mt-0">
                      <Card className="border-border">
                        <CardContent className="pt-6">
                          <KeysRecoveryContent
                            mode="recovery"
                            normalizedEmail={normalizedEmail}
                            defaultKeyIssue={security.defaultKeyIssue}
                            vaultUnlocked={vault.unlocked}
                            deviceShareBusy={security.deviceShareBusy}
                            verifyingRequest={security.verifyingDeviceRequest}
                            pendingDeviceRequest={
                              security.pendingDeviceRequest
                                ? {
                                    deviceId: security.pendingDeviceRequest.device.deviceId,
                                    verificationCode:
                                      security.pendingDeviceRequest.verificationCode,
                                    verificationSymbols:
                                      security.pendingDeviceRequest.verificationSymbols,
                                    verificationWords:
                                      security.pendingDeviceRequest.verificationWords,
                                    expiresAt: security.pendingDeviceRequest.expiresAt,
                                  }
                                : null
                            }
                            devices={ownedDevices}
                            deviceVerificationCode={security.deviceVerificationCode}
                            onDeviceVerificationCodeChange={
                              security.setDeviceVerificationCode
                            }
                            onRequestKeys={security.handleRequestKeysFromAnotherDevice}
                            onApproveCode={security.handleApproveDeviceShareByCode}
                            onRevokeDevice={security.handleRevokeDevice}
                            onImportSuccess={security.handleBackupImportSuccess}
                            onExportSuccess={() => {
                              security.setFeedback('Encrypted backup exported successfully.');
                            }}
                            errorMessage={security.error}
                            onOverrideKeys={
                              shellInboxSlug
                                ? () =>
                                    navigate({
                                      to: '/$slug',
                                      params: { slug: shellInboxSlug },
                                      search: buildWorkspaceSearch({}),
                                    })
                                : undefined
                            }
                          />
                        </CardContent>
                      </Card>
                    </TabsContent>
                    <TabsContent value="backups" className="mt-0">
                      <Card className="border-border">
                        <CardContent className="pt-6">
                          <KeysRecoveryContent
                            mode="backups"
                            normalizedEmail={normalizedEmail}
                            defaultKeyIssue={security.defaultKeyIssue}
                            vaultUnlocked={vault.unlocked}
                            deviceShareBusy={security.deviceShareBusy}
                            verifyingRequest={security.verifyingDeviceRequest}
                            pendingDeviceRequest={null}
                            devices={ownedDevices}
                            deviceVerificationCode={security.deviceVerificationCode}
                            onDeviceVerificationCodeChange={
                              security.setDeviceVerificationCode
                            }
                            onRequestKeys={security.handleRequestKeysFromAnotherDevice}
                            onApproveCode={security.handleApproveDeviceShareByCode}
                            onRevokeDevice={security.handleRevokeDevice}
                            onImportSuccess={security.handleBackupImportSuccess}
                            onExportSuccess={() => {
                              security.setFeedback('Encrypted backup exported successfully.');
                            }}
                            errorMessage={security.error}
                            onOverrideKeys={
                              shellInboxSlug
                                ? () =>
                                    navigate({
                                      to: '/$slug',
                                      params: { slug: shellInboxSlug },
                                      search: buildWorkspaceSearch({}),
                                    })
                                : undefined
                            }
                          />
                        </CardContent>
                      </Card>
                    </TabsContent>
                  </Tabs>
                </VaultGate>
              ) : null}
            </div>
          ) : null}
        </>
        )
      }
    </WorkspaceRouteShell>
  );
}
