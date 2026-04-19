import type { Command } from 'commander';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { userError } from '../../services/errors';
import { restoreInboxKeys } from '../../services/key-backup';
import { promptSecret, promptText } from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { renderKeyValue } from '../../services/render';

type RestoreKeysOptions = GlobalOptions & {
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

export function registerBackupImportCommand(command: Command): void {
  command
    .command('import')
    .description('Import an encrypted backup of local inbox private keys')
    .option('--file <path>', 'Path to the encrypted backup file')
    .option('--passphrase <text>', 'Backup passphrase (avoid shell history when possible)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as RestoreKeysOptions;
      await runCommandAction({
        title: 'Masumi auth backup import',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) => {
          const filePath =
            options.file ??
            (await promptText({
              question: 'Encrypted backup file path',
            }));
          const passphrase =
            options.passphrase ??
            (await promptSecret({
              question: 'Backup passphrase',
            }));

          if (!filePath.trim()) {
            throw userError('Encrypted backup file path is required.', {
              code: 'BACKUP_FILE_REQUIRED',
            });
          }
          if (!passphrase.trim()) {
            throw userError('Backup passphrase is required.', {
              code: 'BACKUP_PASSPHRASE_REQUIRED',
            });
          }

          const resolvedPath = path.resolve(filePath);
          const passphraseStrength = estimatePassphraseStrength(passphrase);

          // Preflight: require readable file.
          try {
            await access(resolvedPath, constants.R_OK);
            const fileStat = await stat(resolvedPath);
            if (!fileStat.isFile()) {
              throw userError('Encrypted backup path must point to a file.', {
                code: 'BACKUP_FILE_INVALID',
              });
            }
          } catch (error) {
            if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
              throw userError(`Encrypted backup file does not exist: ${resolvedPath}`, {
                code: 'BACKUP_FILE_NOT_FOUND',
              });
            }
            throw error;
          }

          const restoreResult = await restoreInboxKeys({
            profileName: options.profile,
            filePath: resolvedPath,
            passphrase,
            reporter,
          });
          return {
            ...restoreResult,
            passphraseStrength,
          };
        },
        toHuman: result => ({
          summary: 'Encrypted key backup imported.',
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
