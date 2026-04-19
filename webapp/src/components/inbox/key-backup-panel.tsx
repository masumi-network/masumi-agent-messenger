import { useState } from 'react';
import { DownloadSimple, Shield, UploadSimple } from '@phosphor-icons/react';
import { createEncryptedNamespaceKeyBackupForInbox, importEncryptedNamespaceKeyBackupForInbox } from '@/lib/key-export';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type KeyBackupPanelProps = {
  normalizedEmail: string;
  disabled?: boolean;
  disabledMessage?: string;
  emphasisMessage?: string | null;
  showExport?: boolean;
  showImport?: boolean;
  onExportSuccess?: () => void | Promise<void>;
  onImportSuccess?: () => void | Promise<void>;
};

function downloadBackupFile(fileName: string, json: string): void {
  const blob = new Blob([`${json}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function KeyBackupPanel({
  normalizedEmail,
  disabled = false,
  disabledMessage = 'Unlock your vault before exporting or importing backups.',
  emphasisMessage,
  showExport = true,
  showImport = true,
  onExportSuccess,
  onImportSuccess,
}: KeyBackupPanelProps) {
  const [busyAction, setBusyAction] = useState<'export' | 'import' | null>(null);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportPassphraseConfirm, setExportPassphraseConfirm] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSuccess, setLocalSuccess] = useState<string | null>(null);

  async function handleExportBackup() {
    if (!exportPassphrase.trim()) {
      setLocalError('Enter a passphrase before exporting.');
      setLocalSuccess(null);
      return;
    }
    if (exportPassphrase !== exportPassphraseConfirm) {
      setLocalError('Backup passphrases do not match.');
      setLocalSuccess(null);
      return;
    }

    setBusyAction('export');
    setLocalError(null);
    setLocalSuccess(null);

    try {
      const backup = await createEncryptedNamespaceKeyBackupForInbox(
        normalizedEmail,
        exportPassphrase
      );
      downloadBackupFile(backup.fileName, backup.json);
      setExportPassphrase('');
      setExportPassphraseConfirm('');
      setLocalSuccess('Backup downloaded. Keep the file and passphrase safe.');
      await onExportSuccess?.();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleImportBackup() {
    if (!importFile) {
      setLocalError('Choose a backup file to import.');
      setLocalSuccess(null);
      return;
    }
    if (!importPassphrase.trim()) {
      setLocalError('Enter the passphrase to import your backup.');
      setLocalSuccess(null);
      return;
    }

    setBusyAction('import');
    setLocalError(null);
    setLocalSuccess(null);

    try {
      const json = await importFile.text();
      await importEncryptedNamespaceKeyBackupForInbox(
        json,
        importPassphrase,
        normalizedEmail
      );
      setImportPassphrase('');
      setImportFile(null);
      setFileInputKey(current => current + 1);
      setLocalSuccess('Backup imported. Your keys have been restored.');
      await onImportSuccess?.();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-4">
      {emphasisMessage ? (
        <Alert>
          <Shield className="h-4 w-4" />
          <AlertTitle>Back up your keys</AlertTitle>
          <AlertDescription>{emphasisMessage}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">
        Your keys are only stored in this browser. Back them up now and keep the file and passphrase safe.
      </p>

      {disabled ? (
        <p className="text-sm text-muted-foreground">{disabledMessage}</p>
      ) : null}

      {localError ? (
        <Alert variant="destructive">
          <AlertTitle>Backup error</AlertTitle>
          <AlertDescription>{localError}</AlertDescription>
        </Alert>
      ) : null}

      {localSuccess ? (
        <Alert>
          <AlertTitle>Backup update</AlertTitle>
          <AlertDescription>{localSuccess}</AlertDescription>
        </Alert>
      ) : null}

      <div
        className={
          showExport && showImport ? 'grid gap-4 lg:grid-cols-2' : 'space-y-4'
        }
      >
        {showExport ? (
          <section className="space-y-3 rounded-lg border bg-muted/20 px-4 py-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Export encrypted backup</p>
              <p className="text-sm text-muted-foreground">
                Download a backup that works across the CLI and webapp.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="backup-export-passphrase">Backup passphrase</Label>
              <Input
                id="backup-export-passphrase"
                type="password"
                value={exportPassphrase}
                onChange={event => setExportPassphrase(event.target.value)}
                placeholder="Choose a strong passphrase"
                disabled={disabled || busyAction !== null}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="backup-export-passphrase-confirm">
                Confirm backup passphrase
              </Label>
              <Input
                id="backup-export-passphrase-confirm"
                type="password"
                value={exportPassphraseConfirm}
                onChange={event => setExportPassphraseConfirm(event.target.value)}
                placeholder="Re-enter the passphrase"
                disabled={disabled || busyAction !== null}
              />
            </div>

            <Button
              type="button"
              onClick={() => void handleExportBackup()}
              disabled={disabled || busyAction !== null}
            >
              <DownloadSimple className="h-4 w-4" />
              {busyAction === 'export' ? 'Exporting...' : 'Download encrypted backup'}
            </Button>
          </section>
        ) : null}

        {showImport ? (
          <section className="space-y-3 rounded-lg border bg-muted/20 px-4 py-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Import encrypted backup</p>
              <p className="text-sm text-muted-foreground">
                Restore your inbox from a backup file.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="backup-import-file">Backup file</Label>
              <Input
                key={fileInputKey}
                id="backup-import-file"
                type="file"
                accept=".json,application/json"
                onChange={event => setImportFile(event.target.files?.[0] ?? null)}
                disabled={disabled || busyAction !== null}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="backup-import-passphrase">Backup passphrase</Label>
              <Input
                id="backup-import-passphrase"
                type="password"
                value={importPassphrase}
                onChange={event => setImportPassphrase(event.target.value)}
                placeholder="Enter the backup passphrase"
                disabled={disabled || busyAction !== null}
              />
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={() => void handleImportBackup()}
              disabled={disabled || busyAction !== null}
            >
              <UploadSimple className="h-4 w-4" />
              {busyAction === 'import' ? 'Importing...' : 'Import encrypted backup'}
            </Button>
          </section>
        ) : null}
      </div>
    </div>
  );
}
