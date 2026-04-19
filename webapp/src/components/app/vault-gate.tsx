import { useState } from 'react';
import { KeyVaultDialog } from '@/components/key-vault-form';
import { Button } from '@/components/ui/button';
import type { UseKeyVaultResult } from '@/hooks/use-key-vault';

type VaultGateProps = {
  vault: UseKeyVaultResult;
  title?: string;
  description?: string;
  children: React.ReactNode;
};

export function VaultGate({
  vault,
  title,
  description,
  children,
}: VaultGateProps) {
  const [userRequestedOpen, setUserRequestedOpen] = useState(false);
  const dialogOpen = vault.loading ? false : (!vault.unlocked || userRequestedOpen);

  function handleOpenChange(open: boolean) {
    setUserRequestedOpen(open);
  }

  if (vault.loading) {
    return null;
  }

  if (!vault.unlocked) {
    const resolvedTitle =
      title ?? (vault.initialized ? 'Unlock Private Keys' : 'Create Private Key Vault');
    const resolvedDescription =
      description ??
      (vault.initialized
        ? 'Enter your passphrase to unlock local private keys for decryption, key rotation, and encrypted sending.'
        : 'Create a passphrase to encrypt this browser’s private key vault before generating or importing inbox keys.');

    return (
      <>
        <div className="space-y-3 rounded-lg border border-dashed border-border bg-card/40 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{resolvedTitle}</p>
            <p className="text-sm text-muted-foreground">{resolvedDescription}</p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => setUserRequestedOpen(true)}
            disabled={vault.submitting}
          >
            {vault.initialized ? 'Unlock keys' : 'Create vault'}
          </Button>
        </div>
        <KeyVaultDialog
          open={dialogOpen}
          onOpenChange={handleOpenChange}
          mode={vault.initialized ? 'unlock' : 'setup'}
          busy={vault.submitting}
          error={vault.error}
          title={resolvedTitle}
          description={resolvedDescription}
          submitLabel={vault.initialized ? 'Unlock keys' : 'Create vault'}
          onSubmit={vault.handleSubmit}
        />
      </>
    );
  }

  return <>{children}</>;
}
