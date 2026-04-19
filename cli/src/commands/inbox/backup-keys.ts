import type { Command } from 'commander';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadProfile } from '../../services/config-store';
import { userError } from '../../services/errors';
import { backupInboxKeys, defaultBackupFilePath } from '../../services/key-backup';
import { confirmYesNo, promptSecret, promptText } from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { renderKeyValue } from '../../services/render';

type BackupKeysOptions = GlobalOptions & {
  file?: string;
  passphrase?: string;
};

function estimatePassphraseStrength(passphrase: string): 'weak' | 'ok' | 'strong' {
  const hasUpper = /[A-Z]/.test(passphrase);
  const hasLower = /[a-z]/.test(passphrase);
  const hasDigit = /\d/.test(passphrase);
  const hasSymbol = /[^A-Za-z0-9]/.test(passphrase);
  const variety = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  if (passphrase.length >= 14 && variety >= 3) {
    return 'strong';
  }
  if (passphrase.length >= 10 && variety >= 2) {
    return 'ok';
  }
  return 'weak';
}

export function registerBackupExportCommand(command: Command): void {
  command
    .command('export')
    .description('Export an encrypted backup of local inbox private keys')
    .option('--file <path>', 'Path to write the encrypted backup file')
    .option('--passphrase <text>', 'Backup passphrase (avoid shell history when possible)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as BackupKeysOptions;
      await runCommandAction({
        title: 'Masumi auth backup export',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) => {
          const profile = await loadProfile(options.profile);
          const normalizedEmail = profile.bootstrapSnapshot?.inbox.normalizedEmail ?? 'masumi-agent-messenger';
          const filePath =
            options.file ??
            (options.json
              ? defaultBackupFilePath(normalizedEmail)
              : await promptText({
                  question: 'Backup file path',
                  defaultValue: defaultBackupFilePath(normalizedEmail),
                }));
          const passphrase =
            options.passphrase ??
            (await promptSecret({
              question: 'Backup passphrase',
            }));
          const confirmPassphrase =
            options.passphrase ??
            (await promptSecret({
              question: 'Confirm backup passphrase',
            }));

          if (!passphrase.trim()) {
            throw userError('Backup passphrase is required.', {
              code: 'BACKUP_PASSPHRASE_REQUIRED',
            });
          }
          if (passphrase !== confirmPassphrase) {
            throw userError('Backup passphrases do not match.', {
              code: 'BACKUP_PASSPHRASE_MISMATCH',
            });
          }

          const resolvedPath = path.resolve(filePath);
          const passphraseStrength = estimatePassphraseStrength(passphrase);

          // Preflight: refuse to overwrite an existing backup file.
          const existingStat = await stat(resolvedPath).catch(() => null);

          if (existingStat && existingStat.isFile()) {
            if (options.json) {
              throw userError(
                `Backup file already exists: ${resolvedPath}`,
                {
                  code: 'BACKUP_EXPORT_OVERWRITE_REFUSED',
                  hint: `Choose a different --file path (or remove the existing file before retrying).`,
                }
              );
            }

            const overwrite = await confirmYesNo({
              question: `Backup file exists at:\n${resolvedPath}\nOverwrite it?`,
              defaultValue: false,
            });
            if (!overwrite) {
              throw userError('Backup export cancelled.', {
                code: 'BACKUP_EXPORT_OVERWRITE_CANCELLED',
              });
            }
          }

          // Preflight: ensure parent directory is writable (mkdir recursive first).
          const parentDir = path.dirname(resolvedPath);
          await access(parentDir, constants.W_OK).catch(async () => {
            // Directory might not exist yet; allow backupInboxKeys to create it, but fail fast if we still can't.
            await import('node:fs/promises').then(fs => fs.mkdir(parentDir, { recursive: true }));
            return access(parentDir, constants.W_OK);
          });

          const backupResult = await backupInboxKeys({
            profileName: options.profile,
            filePath: resolvedPath,
            passphrase,
            reporter,
          });
          return {
            ...backupResult,
            passphraseStrength,
          };
        },
        toHuman: result => ({
          summary: 'Encrypted key backup created.',
          details: renderKeyValue([
            { key: 'File', value: result.filePath },
            { key: 'Email', value: result.normalizedEmail },
            { key: 'Passphrase strength', value: result.passphraseStrength },
            { key: 'Actors', value: result.actorCount },
            { key: 'Key versions', value: result.keyVersionCount },
          ]),
        }),
      });
    });
}
