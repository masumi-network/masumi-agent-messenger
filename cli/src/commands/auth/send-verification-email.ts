import type { Command } from 'commander';
import { requestVerificationEmailForIssuer } from '../../services/auth';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { dim, green, red, renderKeyValue } from '../../services/render';

type SendVerificationEmailOptions = GlobalOptions & {
  email: string;
  issuer?: string;
  callbackUrl?: string;
};

export function registerAuthSendVerificationEmailCommand(command: Command): void {
  command
    .command('resend-verification')
    .description('Request a new Masumi verification email')
    .requiredOption('--email <email>', 'Email address that should receive the verification link')
    .option('--issuer <url>', 'OIDC issuer URL')
    .option('--callback-url <url>', 'Verification callback URL to embed in the email')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as SendVerificationEmailOptions;

      await runCommandAction({
        title: 'Masumi auth send verification email',
        options,
        run: ({ reporter }) =>
          requestVerificationEmailForIssuer({
            profileName: options.profile,
            issuer: options.issuer,
            email: options.email,
            callbackURL: options.callbackUrl,
            reporter,
          }),
        toHuman: result => ({
          summary: result.sent
            ? green('Verification email requested.')
            : red('Verification email request failed.'),
          details: renderKeyValue([
            { key: 'Email', value: result.email },
            { key: 'Issuer', value: result.issuer, color: dim },
            ...(result.callbackURL ? [{ key: 'Callback URL', value: result.callbackURL, color: dim }] : []),
          ]),
        }),
      });
    });
}
