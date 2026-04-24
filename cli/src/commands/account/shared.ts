import process from 'node:process';
import { getMasumiInboxAgentNetwork } from '../../../../shared/inbox-agent-registration';
import type { AuthenticatedInboxResult } from '../../services/auth';
import { claimDeviceShare, requestDeviceShare } from '../../services/device';
import { bootstrapInbox } from '../../services/inbox';
import type { BootstrapResult } from '../../services/inbox-bootstrap';
import { rotateInboxKeys } from '../../services/inbox-management';
import { restoreInboxKeys } from '../../services/key-backup';
import { maybeOfferBackupAfterKeyCreation } from '../../services/key-backup-prompt';
import { resolvePublicDescriptionOption } from '../../services/public-description';
import {
  confirmYesNo,
  promptChoice,
  promptMultiline,
  promptSecret,
  promptText,
  waitForEnterMessage,
} from '../../services/prompts';
import type { GlobalOptions, TaskReporter } from '../../services/command-runtime';

export type AccountFlowOptions = GlobalOptions & {
  issuer?: string;
  clientId?: string;
  displayName?: string;
  skipAgentRegistration?: boolean;
  disableLinkedEmail?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
  debug?: boolean;
};

export function isInteractiveAccountFlow(options: GlobalOptions): boolean {
  return !options.json && Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
}

export function buildAccountRegistrationPrompts() {
  return {
    confirmAgentRegistration: async ({
      actorSlug,
      displayName,
      creditsRemaining,
    }: {
      actorSlug: string;
      displayName?: string | null;
      creditsRemaining?: number | null;
    }) =>
      confirmYesNo({
        question: `Create managed agent for ${displayName ?? actorSlug} on ${getMasumiInboxAgentNetwork()}? Credits: ${creditsRemaining ?? 'unknown'}.`,
        defaultValue: true,
      }),
    confirmLinkedEmailVisibility: async ({ actorSlug }: { actorSlug: string }) =>
      confirmYesNo({
        question: `Expose linked email on /${actorSlug}/public?`,
        defaultValue: true,
      }),
    confirmPublicDescription: async ({ actorSlug }: { actorSlug: string }) => {
      const shouldSetDescription = await confirmYesNo({
        question: `Set a public description on /${actorSlug}/public now?`,
        defaultValue: false,
      });
      if (!shouldSetDescription) {
        return null;
      }
      const description = await promptMultiline({
        question: 'Enter the public description markdown.',
      });
      return description || null;
    },
    pauseAfterRegistrationBlocked: async (message: string) => {
      await waitForEnterMessage(`${message} Press Enter to continue.`);
    },
  };
}

export async function resolveAccountRegistrationSettings(options: AccountFlowOptions) {
  return {
    registrationMode: options.skipAgentRegistration
      ? 'skip'
      : isInteractiveAccountFlow(options)
        ? 'prompt'
        : 'auto',
    desiredLinkedEmailVisibility: !options.disableLinkedEmail,
    desiredPublicDescription: await resolvePublicDescriptionOption({
      description: options.publicDescription,
      descriptionFile: options.publicDescriptionFile,
    }),
  } as const;
}

function mergeRecoveredBootstrap(
  base: AuthenticatedInboxResult,
  next: Awaited<ReturnType<typeof bootstrapInbox>>,
  keySource: AuthenticatedInboxResult['keySource']
): AuthenticatedInboxResult {
  return {
    ...base,
    ...next,
    keySource,
    recoveryRequired: next.recoveryRequired && !next.localKeysReady,
    recoveryReason: next.localKeysReady ? null : next.recoveryReason,
    recoveryOptions: next.localKeysReady ? [] : next.recoveryOptions,
  };
}

async function runBootstrapRefresh(params: {
  options: AccountFlowOptions;
  reporter: TaskReporter;
}): Promise<Awaited<ReturnType<typeof bootstrapInbox>>> {
  const registration = await resolveAccountRegistrationSettings(params.options);
  return bootstrapInbox({
    profileName: params.options.profile,
    reporter: params.reporter,
    ...registration,
    ...buildAccountRegistrationPrompts(),
  });
}

export async function resolveAccountRecoveryFlow(params: {
  result: AuthenticatedInboxResult;
  options: AccountFlowOptions;
  reporter: TaskReporter;
}): Promise<AuthenticatedInboxResult> {
  let current = params.result;

  while (current.recoveryRequired) {
    params.reporter.info(
      current.recoveryReason === 'mismatch'
        ? 'This CLI profile has local private keys that do not match the published inbox keys.'
        : 'This CLI profile does not have the local private keys for the published inbox yet.'
    );

    const choice = await promptChoice({
      question: 'Choose how to continue:',
      defaultValue: 'device_share',
      options: [
        { value: 'device_share', label: 'Recover from another device' },
        { value: 'backup_import', label: 'Import encrypted backup' },
        { value: 'rotate', label: "I don't have access" },
        { value: 'cancel', label: 'Cancel for now' },
      ],
    });

    if (choice === 'cancel') {
      params.reporter.info(
        'Authentication completed, but local private keys still need recovery before this CLI profile can decrypt older messages.'
      );
      return current;
    }

    if (choice === 'device_share') {
      await requestDeviceShare({
        profileName: params.options.profile,
        reporter: params.reporter,
      });
      const claim = await claimDeviceShare({
        profileName: params.options.profile,
        reporter: params.reporter,
      });
      if (!claim.imported) {
        params.reporter.info(
          'No key share was approved before the emoji verification code expired. Choose another recovery option or try again.'
        );
        continue;
      }

      const refreshed = await runBootstrapRefresh(params);
      current = mergeRecoveredBootstrap(current, refreshed, 'device_share');
      continue;
    }

    if (choice === 'backup_import') {
      const filePath = await promptText({
        question: 'Encrypted backup file path',
      });
      const passphrase = await promptSecret({
        question: 'Backup passphrase',
      });
      await restoreInboxKeys({
        profileName: params.options.profile,
        filePath,
        passphrase,
        reporter: params.reporter,
        expectedNormalizedEmail: current.inbox.normalizedEmail,
      });

      params.reporter.success('Encrypted backup imported');
      const refreshed = await runBootstrapRefresh(params);
      current = mergeRecoveredBootstrap(current, refreshed, 'backup_import');
      continue;
    }

    params.reporter.info(
      'Rotating keys will permanently remove access to previous messages encrypted to the old keys. This CLI profile will only receive and decrypt new messages after rotation.'
    );
    const confirmation = await promptText({
      question: 'Type ROTATE to confirm destructive key rotation',
    });
    if (confirmation !== 'ROTATE') {
      params.reporter.info('Key rotation cancelled.');
      continue;
    }

    await rotateInboxKeys({
      profileName: params.options.profile,
      reporter: params.reporter,
    });
    params.reporter.info(
      'Keys rotated. Previous encrypted messages will remain inaccessible on this CLI profile unless the older private keys are recovered later.'
    );
    const refreshed = await runBootstrapRefresh(params);
    current = mergeRecoveredBootstrap(current, refreshed, 'rotated');
  }

  return current;
}

export function shouldOfferAccountBackup(result: AuthenticatedInboxResult): boolean {
  return (
    result.localKeysReady &&
    !result.recoveryRequired &&
    (result.keySource === 'new_local' || result.keySource === 'rotated')
  );
}

export async function maybeOfferAccountBackup(params: {
  result: AuthenticatedInboxResult;
  options: AccountFlowOptions;
  reporter: TaskReporter;
  createdLabel: string;
  rotatedLabel?: string;
}): Promise<void> {
  if (!params.options.json && shouldOfferAccountBackup(params.result)) {
    await maybeOfferBackupAfterKeyCreation({
      profileName: params.options.profile,
      reporter: params.reporter,
      promptLabel:
        params.result.keySource === 'rotated'
          ? (params.rotatedLabel ?? 'New agent keys were created.')
          : params.createdLabel,
    });
  }
}

export function toRecoveredAccountResult(result: BootstrapResult): AuthenticatedInboxResult {
  return {
    authenticated: true,
    expiresAt: null,
    issuer: null,
    email: result.inbox.displayEmail,
    subject: null,
    grantedScopes: [],
    ...result,
  };
}
