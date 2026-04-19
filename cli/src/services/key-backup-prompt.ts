import { loadProfile } from './config-store';
import type { TaskReporter } from './command-runtime';
import { userError } from './errors';
import { backupInboxKeys, defaultBackupFilePath } from './key-backup';
import { confirmYesNo, promptSecret, promptText } from './prompts';

export async function maybeOfferBackupAfterKeyCreation(params: {
  profileName: string;
  reporter: TaskReporter;
  promptLabel: string;
  passphraseOverride?: string;
  filePathOverride?: string;
}): Promise<void> {
  params.reporter.info(
    `${params.promptLabel} Private keys were saved locally on this machine. They are not stored on the server. Create an encrypted backup now, and keep both the private keys and backup passphrase secret.`
  );

  const shouldBackup =
    params.filePathOverride || params.passphraseOverride
      ? true
      : await confirmYesNo({
          question: 'Create an encrypted backup of your local private keys now?',
          defaultValue: true,
        });

  if (!shouldBackup) {
    params.reporter.info(
      'Skipped encrypted backup creation. You can create one later with `masumi-agent-messenger account backup export`.'
    );
    return;
  }

  const profile = await loadProfile(params.profileName);
  const normalizedEmail = profile.bootstrapSnapshot?.inbox.normalizedEmail ?? 'masumi-agent-messenger';
  const filePath =
    params.filePathOverride ||
    (await promptText({
      question: 'Backup file path',
      defaultValue: defaultBackupFilePath(normalizedEmail),
    }));

  const passphrase =
    params.passphraseOverride ||
    (await promptSecret({
      question: 'Backup passphrase',
    }));
  const confirmPassphrase =
    params.passphraseOverride ||
    (await promptSecret({
      question: 'Confirm backup passphrase',
    }));

  if (!passphrase.trim()) {
    params.reporter.info('Backup skipped because no passphrase was provided.');
    return;
  }

  if (passphrase !== confirmPassphrase) {
    throw userError('Backup passphrases do not match.', {
      code: 'BACKUP_PASSPHRASE_MISMATCH',
    });
  }

  const result = await backupInboxKeys({
    profileName: params.profileName,
    filePath,
    passphrase,
    reporter: params.reporter,
  });

  params.reporter.success(`Encrypted backup saved to ${result.filePath}`);
}
