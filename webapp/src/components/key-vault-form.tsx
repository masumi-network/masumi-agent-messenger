import { useState } from 'react';
import { Lock, LockOpen } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type KeyVaultPromptProps = {
  mode: 'setup' | 'unlock';
  busy: boolean;
  error: string | null;
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (passphrase: string, confirmPassphrase: string) => Promise<void>;
};

function KeyVaultFormBody({
  mode,
  busy,
  error,
  submitLabel,
  onSubmit,
  autoFocus = false,
}: Pick<
  KeyVaultPromptProps,
  'mode' | 'busy' | 'error' | 'submitLabel' | 'onSubmit'
> & {
  autoFocus?: boolean;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {error || localError ? (
        <Alert variant="destructive">
          <AlertTitle>{mode === 'setup' ? 'Passphrase setup failed' : 'Unlock failed'}</AlertTitle>
          <AlertDescription>{error ?? localError}</AlertDescription>
        </Alert>
      ) : null}

      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          setLocalError(null);

          if (!passphrase.trim()) {
            setLocalError('Passphrase is required.');
            return;
          }
          if (mode === 'setup' && passphrase !== confirmPassphrase) {
            setLocalError('Passphrases do not match.');
            return;
          }

          void onSubmit(passphrase, confirmPassphrase)
            .then(() => {
              setPassphrase('');
              setConfirmPassphrase('');
            })
            .catch(() => {});
        }}
      >
        <div className="space-y-2">
          <Label htmlFor={`vault-passphrase-${mode}`}>Passphrase</Label>
          <Input
            id={`vault-passphrase-${mode}`}
            type="password"
            value={passphrase}
            onChange={event => setPassphrase(event.target.value)}
            placeholder={
              mode === 'setup'
                ? 'Create a passphrase'
                : 'Enter your passphrase'
            }
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            disabled={busy}
            autoFocus={autoFocus}
          />
        </div>

        {mode === 'setup' ? (
          <div className="space-y-2">
            <Label htmlFor="vault-passphrase-confirm">Confirm passphrase</Label>
            <Input
              id="vault-passphrase-confirm"
              type="password"
              value={confirmPassphrase}
              onChange={event => setConfirmPassphrase(event.target.value)}
              placeholder="Repeat the passphrase"
              autoComplete="new-password"
              disabled={busy}
            />
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {mode === 'setup'
            ? 'This passphrase protects your keys. Keep it safe — there is no way to recover it.'
            : 'Your keys are encrypted and only unlocked while this tab is open.'}
        </p>

        <Button type="submit" disabled={busy} className="w-full">
          {mode === 'setup' ? <Lock /> : <LockOpen />}
          {busy ? (mode === 'setup' ? 'Creating vault...' : 'Unlocking...') : submitLabel}
        </Button>
      </form>
    </div>
  );
}

export function KeyVaultForm({
  title,
  description,
  ...props
}: KeyVaultPromptProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <KeyVaultFormBody {...props} />
      </CardContent>
    </Card>
  );
}

export function KeyVaultDialog({
  open,
  onOpenChange,
  title,
  description,
  ...props
}: KeyVaultPromptProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && props.busy) {
          return;
        }

        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-md border-border bg-background/95 p-6 sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <KeyVaultFormBody {...props} autoFocus />
      </DialogContent>
    </Dialog>
  );
}
