import type { Command } from 'commander';
import type { GlobalOptions } from '../../services/command-runtime';
import { promptText } from '../../services/prompts';
import { registerInboxAgentListCommand } from './agents';
import { registerInboxCreateCommand } from './create';
import { registerInboxListCommand } from './list';
import { registerInboxStatusCommand } from './status';
import { registerInboxAgentRegisterCommand } from './register-agent';
import { registerInboxRequestCommands } from './approvals';
import { registerInboxPublicCommand } from './public';
import { registerInboxAllowlistCommand } from './allowlist';
import { registerInboxBootstrapCommand } from './bootstrap';
import { registerThreadLatestCommand } from './messages';
import { registerAuthRotateCommand } from './rotate-keys';
import { registerThreadSendCommand } from './send';
import { registerInboxTrustCommand } from './trust';
import {
  chooseMenuAction,
  invokeMenuCommand,
  isInteractiveHumanMode,
  showCommandHelp,
} from '../menu';

export function registerInboxCommands(program: Command): void {
  const inbox = program.command('inbox').description('Inbox identity, public profile, and approval commands');

  inbox.action(async (_options, commandInstance) => {
    const options = commandInstance.optsWithGlobals() as GlobalOptions;
    if (!isInteractiveHumanMode(options)) {
      showCommandHelp(commandInstance);
      return;
    }

    const choice = await chooseMenuAction({
      question: 'Which inbox command do you want?',
      defaultValue: 'list',
      options: [
        { value: 'list', label: 'List owned inboxes' },
        { value: 'create', label: 'Create a new inbox slug' },
        { value: 'status', label: 'Show inbox status' },
        { value: 'agent-register', label: 'Register a managed agent' },
        { value: 'public-show', label: 'Show public profile' },
        { value: 'request-list', label: 'List approval requests' },
        { value: 'allowlist-list', label: 'List allowlist entries' },
      ],
    });

    switch (choice) {
      case 'create': {
        const slug = await promptText({
          question: 'Inbox slug to create',
        });
        await invokeMenuCommand(options, ['inbox', 'create', slug]);
        return;
      }
      case 'agent-register':
        await invokeMenuCommand(options, ['inbox', 'agent', 'register']);
        return;
      case 'public-show':
        await invokeMenuCommand(options, ['inbox', 'public', 'show']);
        return;
      case 'request-list':
        await invokeMenuCommand(options, ['inbox', 'request', 'list']);
        return;
      case 'allowlist-list':
        await invokeMenuCommand(options, ['inbox', 'allowlist', 'list']);
        return;
      default:
        await invokeMenuCommand(options, ['inbox', choice]);
    }
  });

  registerInboxListCommand(inbox);
  registerInboxCreateCommand(inbox);
  registerInboxStatusCommand(inbox);
  registerInboxBootstrapCommand(inbox);
  registerThreadSendCommand(inbox);
  registerThreadLatestCommand(inbox);
  registerAuthRotateCommand(inbox);

  const agent = inbox.command('agent').description('Managed inbox-agent registration commands');
  registerInboxAgentListCommand(agent);
  registerInboxAgentRegisterCommand(agent);

  registerInboxPublicCommand(inbox);
  registerInboxRequestCommands(inbox);
  registerInboxAllowlistCommand(inbox);
  registerInboxTrustCommand(inbox);
}
