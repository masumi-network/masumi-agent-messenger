import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Key, SpinnerGap, ShieldCheck, ShieldSlash } from '@phosphor-icons/react';
import { KeyBackupPanel } from '@/components/inbox/key-backup-panel';
import { EmptyState } from '@/components/inbox/empty-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DefaultKeyIssue, DashboardModal } from '@/lib/app-shell';
import type { Device } from '@/module_bindings/types';

type PendingDeviceRequest = {
  deviceId: string;
  verificationCode: string;
  verificationSymbols: string[];
  verificationWords: string[];
  expiresAt: string;
};

function VerificationCodeDisplay({
  symbols,
  words,
}: {
  symbols: string[];
  words: string[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {symbols.map((symbol, index) => (
        <div
          key={`${symbol}-${index.toString()}`}
          className="rounded-md border border-primary/20 bg-background/70 px-3 py-3 text-center"
        >
          <p className="text-3xl leading-none">{symbol}</p>
          <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {words[index] ?? ''}
          </p>
        </div>
      ))}
    </div>
  );
}

export function KeysRecoveryDialog({
  open,
  onOpenChange,
  mode,
  normalizedEmail,
  defaultKeyIssue,
  vaultUnlocked,
  deviceShareBusy,
  verifyingRequest,
  pendingDeviceRequest,
  devices,
  deviceVerificationCode,
  onDeviceVerificationCodeChange,
  onRequestKeys,
  onApproveCode,
  onRevokeDevice,
  onImportSuccess,
  onExportSuccess,
  onOverrideKeys,
  errorMessage,
  autoGenerateCodeOnMissingKeys = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DashboardModal;
  normalizedEmail: string;
  defaultKeyIssue: DefaultKeyIssue;
  vaultUnlocked: boolean;
  deviceShareBusy: boolean;
  verifyingRequest: boolean;
  pendingDeviceRequest: PendingDeviceRequest | null;
  devices: Device[];
  deviceVerificationCode: string;
  onDeviceVerificationCodeChange: (value: string) => void;
  onRequestKeys: () => void | Promise<void>;
  onApproveCode: () => void | Promise<void>;
  onRevokeDevice: (deviceId: string) => void | Promise<void>;
  onImportSuccess: () => void | Promise<void>;
  onExportSuccess?: () => void | Promise<void>;
  onOverrideKeys?: () => void | Promise<void>;
  errorMessage?: string | null;
  autoGenerateCodeOnMissingKeys?: boolean;
}) {
  const title = mode === 'backups' ? 'Backups' : 'Keys & Recovery';
  const description =
    mode === 'backups'
      ? 'Export or restore encrypted backups.'
      : defaultKeyIssue === 'missing'
        ? 'This browser needs private keys. Recover from another device or import a backup.'
        : defaultKeyIssue === 'mismatch'
          ? 'This browser has outdated private keys. Import a newer backup or recover from another device.'
          : 'Manage key recovery and trusted devices.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto border-border bg-background/95">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <KeysRecoveryContent
          open={open}
          mode={mode}
          normalizedEmail={normalizedEmail}
          defaultKeyIssue={defaultKeyIssue}
          vaultUnlocked={vaultUnlocked}
          deviceShareBusy={deviceShareBusy}
          verifyingRequest={verifyingRequest}
          pendingDeviceRequest={pendingDeviceRequest}
          devices={devices}
          deviceVerificationCode={deviceVerificationCode}
          onDeviceVerificationCodeChange={onDeviceVerificationCodeChange}
          onRequestKeys={onRequestKeys}
          onApproveCode={onApproveCode}
          onRevokeDevice={onRevokeDevice}
          onImportSuccess={onImportSuccess}
          onExportSuccess={onExportSuccess}
          onOverrideKeys={onOverrideKeys}
          errorMessage={errorMessage}
          autoGenerateCodeOnMissingKeys={autoGenerateCodeOnMissingKeys}
        />
      </DialogContent>
    </Dialog>
  );
}

export function KeysRecoveryContent({
  open,
  mode,
  normalizedEmail,
  defaultKeyIssue,
  vaultUnlocked,
  deviceShareBusy,
  verifyingRequest,
  pendingDeviceRequest,
  devices,
  deviceVerificationCode,
  onDeviceVerificationCodeChange,
  onRequestKeys,
  onApproveCode,
  onRevokeDevice,
  onImportSuccess,
  onExportSuccess,
  onOverrideKeys,
  errorMessage,
  autoGenerateCodeOnMissingKeys = false,
}: {
  open?: boolean;
  mode: DashboardModal;
  normalizedEmail: string;
  defaultKeyIssue: DefaultKeyIssue;
  vaultUnlocked: boolean;
  deviceShareBusy: boolean;
  verifyingRequest: boolean;
  pendingDeviceRequest: PendingDeviceRequest | null;
  devices: Device[];
  deviceVerificationCode: string;
  onDeviceVerificationCodeChange: (value: string) => void;
  onRequestKeys: () => void | Promise<void>;
  onApproveCode: () => void | Promise<void>;
  onRevokeDevice: (deviceId: string) => void | Promise<void>;
  onImportSuccess: () => void | Promise<void>;
  onExportSuccess?: () => void | Promise<void>;
  onOverrideKeys?: () => void | Promise<void>;
  errorMessage?: string | null;
  autoGenerateCodeOnMissingKeys?: boolean;
}) {
  const [activeRecoveryTab, setActiveRecoveryTab] = useState<
    'request' | 'approve' | 'import'
  >(defaultKeyIssue ? 'request' : 'approve');
  const [copiedForCode, setCopiedForCode] = useState<string | null>(null);
  const copiedVerificationCode = copiedForCode !== null && copiedForCode === pendingDeviceRequest?.verificationCode;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const autoRequestedRef = useRef(false);
  const requestButtonLabel = autoGenerateCodeOnMissingKeys
    ? 'Regenerate verification code'
    : 'Generate verification code';
  const requestButtonBusyLabel = autoGenerateCodeOnMissingKeys ? 'Regenerating…' : 'Generating…';

  useEffect(() => {
    if (!pendingDeviceRequest) {
      return;
    }
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [pendingDeviceRequest]);

  useEffect(() => {
    if (open === false) {
      autoRequestedRef.current = false;
      return;
    }
    if (!autoGenerateCodeOnMissingKeys) {
      return;
    }
    if (!defaultKeyIssue) {
      return;
    }
    if (pendingDeviceRequest || deviceShareBusy || !vaultUnlocked) {
      return;
    }
    if (autoRequestedRef.current) {
      return;
    }

    autoRequestedRef.current = true;
    void onRequestKeys();
  }, [
    autoGenerateCodeOnMissingKeys,
    defaultKeyIssue,
    deviceShareBusy,
    onRequestKeys,
    open,
    pendingDeviceRequest,
    vaultUnlocked,
  ]);

  const requestValidity = useMemo(() => {
    if (!pendingDeviceRequest) {
      return null;
    }
    const expiresMs = new Date(pendingDeviceRequest.expiresAt).getTime();
    if (!Number.isFinite(expiresMs)) {
      return 'Unknown';
    }
    const remainingSeconds = Math.max(0, Math.floor((expiresMs - nowMs) / 1000));
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `${minutes.toString()}:${seconds.toString().padStart(2, '0')}`;
  }, [nowMs, pendingDeviceRequest]);
  const approvedDeviceCount = useMemo(
    () => devices.filter(device => device.status === 'approved').length,
    [devices]
  );
  const pendingDeviceCount = useMemo(
    () => devices.filter(device => device.status === 'pending').length,
    [devices]
  );
  const revokedDeviceCount = useMemo(
    () => devices.filter(device => device.status === 'revoked').length,
    [devices]
  );
  const topDeviceLabels = useMemo(() => {
    return devices
      .slice(0, 3)
      .map(device => device.label?.trim() || device.deviceId);
  }, [devices]);

  async function handleCopyVerificationCode(): Promise<void> {
    if (!pendingDeviceRequest || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(pendingDeviceRequest.verificationCode);
    setCopiedForCode(pendingDeviceRequest.verificationCode);
  }

  if (mode === 'backups') {
    return (
      <KeyBackupPanel
        normalizedEmail={normalizedEmail}
        disabled={!vaultUnlocked}
        onImportSuccess={onImportSuccess}
        onExportSuccess={onExportSuccess}
      />
    );
  }

  return (
    <div className="space-y-5">
      {errorMessage ? (
        <Alert variant="destructive" className="my-2">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      {!defaultKeyIssue ? (
        <Alert className="border-amber-500/30 bg-amber-500/10">
          <AlertTitle>Warning: this device already has keys</AlertTitle>
          <AlertDescription>
            This browser already has working private keys. Generate recovery codes only when you
            intentionally want to share keys with another trusted device.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Available devices</p>
            <p className="text-sm text-muted-foreground">
              Trusted devices currently visible for this inbox.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Total {devices.length.toString()}</Badge>
          <Badge variant="outline">Approved {approvedDeviceCount.toString()}</Badge>
          <Badge variant="outline">Pending {pendingDeviceCount.toString()}</Badge>
          <Badge variant="outline">Revoked {revokedDeviceCount.toString()}</Badge>
        </div>
        {topDeviceLabels.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {topDeviceLabels.join(' · ')}
            {devices.length > topDeviceLabels.length
              ? ` · +${(devices.length - topDeviceLabels.length).toString()} more`
              : ''}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No devices registered yet.</p>
        )}
      </div>

      <Tabs
        value={activeRecoveryTab}
        onValueChange={value =>
          setActiveRecoveryTab(value as 'request' | 'approve' | 'import')
        }
        className="space-y-3"
      >
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-xl border border-border bg-card p-1">
          <TabsTrigger value="approve">Share with trusted device</TabsTrigger>
          <TabsTrigger value="import">Import encrypted backup</TabsTrigger>
          <TabsTrigger value="request">Recover on this device</TabsTrigger>
        </TabsList>

        <TabsContent value="request" className="mt-0 space-y-3">
          <p className="text-sm text-muted-foreground">
            Use this on the receiving device. Generate a short-lived emoji code, then complete
            approval on another trusted device that already has your keys.
          </p>

          {pendingDeviceRequest ? (
            <div className="space-y-2 rounded-md border border-primary/20 bg-primary/10 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Pending recovery request</p>
                  <VerificationCodeDisplay
                    symbols={pendingDeviceRequest.verificationSymbols}
                    words={pendingDeviceRequest.verificationWords}
                  />
                  <p className="font-mono text-sm text-muted-foreground">
                    {pendingDeviceRequest.verificationCode}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void onRequestKeys()}
                  disabled={deviceShareBusy}
                >
                  <Key className="h-4 w-4" />
                  {deviceShareBusy ? requestButtonBusyLabel : requestButtonLabel}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopyVerificationCode()}
                  disabled={deviceShareBusy}
                >
                  {copiedVerificationCode ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copiedVerificationCode ? 'Copied' : 'Copy code'}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Device ID:{' '}
                <span className="font-mono">{pendingDeviceRequest.deviceId}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                Expires: {pendingDeviceRequest.expiresAt}
              </p>
              <p className="text-sm text-muted-foreground">
                Valid for: <span className="font-mono">{requestValidity ?? 'Unknown'}</span>
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => void onRequestKeys()}
                disabled={!vaultUnlocked || deviceShareBusy}
              >
                <Key className="h-4 w-4" />
                {deviceShareBusy ? requestButtonBusyLabel : requestButtonLabel}
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="approve" className="mt-0 space-y-2 rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Use this on a trusted device that already has working private keys. Paste the emoji
            code from the receiving device to share keys.
          </p>
          <Label htmlFor="dashboard-device-verification-code">
            Share keys using emoji verification code
          </Label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              id="dashboard-device-verification-code"
              value={deviceVerificationCode}
              onChange={event => onDeviceVerificationCodeChange(event.target.value)}
              placeholder="Paste code from receiving device"
              disabled={!vaultUnlocked || deviceShareBusy}
            />
            <Button
              type="button"
              onClick={() => void onApproveCode()}
              disabled={!vaultUnlocked || deviceShareBusy || !deviceVerificationCode.trim()}
            >
              {verifyingRequest ? (
                <SpinnerGap className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {verifyingRequest ? 'Verifying…' : 'Share keys'}
            </Button>
          </div>
          {verifyingRequest ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <SpinnerGap className="h-4 w-4 animate-spin" />
              <span>Verifying…</span>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="import" className="mt-0 space-y-3 rounded-md border border-border px-4 py-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Import encrypted backup</p>
            <p className="text-sm text-muted-foreground">
              Use backup file when another device is unavailable.
            </p>
          </div>
          <KeyBackupPanel
            normalizedEmail={normalizedEmail}
            disabled={!vaultUnlocked}
            showExport={false}
            onImportSuccess={onImportSuccess}
          />
        </TabsContent>

      </Tabs>

      <section className="space-y-3 rounded-md border border-border px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Trusted devices</p>
          <p className="text-sm text-muted-foreground">
            Devices that have access to this inbox.
          </p>
        </div>
        {devices.length === 0 ? (
          <EmptyState
            icon={Key}
            title="No devices registered"
            description="Set up this browser to register a device."
          />
        ) : (
          <div className="space-y-2">
            {devices.map(device => (
              <div
                key={device.deviceId}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {device.label?.trim() || device.deviceId}
                    </p>
                    <Badge variant="outline">{device.status}</Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {device.platform ?? 'unknown platform'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onRevokeDevice(device.deviceId)}
                  disabled={deviceShareBusy || device.status === 'revoked'}
                >
                  <ShieldSlash className="h-4 w-4" />
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {defaultKeyIssue && onOverrideKeys ? (
        <Alert className="border-amber-500/30 bg-amber-500/10">
          <AlertTitle>Lost access to the old keys?</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Overriding will publish brand-new keys for this inbox. Old encrypted messages
              that depend on the missing keys may remain unreadable until you recover them
              from a trusted device or backup.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void onOverrideKeys()}
              disabled={!vaultUnlocked || deviceShareBusy}
            >
              Override with new local keys
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
