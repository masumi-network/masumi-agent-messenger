import { render } from 'ink';
import type { GlobalOptions } from '../services/command-runtime';
import { toGlobalArgs } from './menu';
import { RootShell, type RootShellSnapshot } from '../ui/root-shell';

type RootShellResult =
  | { kind: 'exit' }
  | { kind: 'handoff'; args: string[]; snapshot: RootShellSnapshot };

async function renderRootShell(params: {
  options: GlobalOptions;
  initialSnapshot?: RootShellSnapshot;
}): Promise<RootShellResult> {
  return await new Promise(resolve => {
    let settled = false;

    const settle = (result: RootShellResult, instance: ReturnType<typeof render>) => {
      if (settled) {
        return;
      }
      settled = true;
      instance.unmount();
      resolve(result);
    };

    const instance = render(
      <RootShell
        options={params.options}
        initialSnapshot={params.initialSnapshot}
        onExit={() => settle({ kind: 'exit' }, instance)}
        onHandoff={(args, snapshot) => settle({ kind: 'handoff', args, snapshot }, instance)}
      />,
      {
        patchConsole: false,
        exitOnCtrlC: true,
      }
    );
  });
}

export async function runRootShell(options: GlobalOptions): Promise<void> {
  let snapshot: RootShellSnapshot | undefined;

  while (true) {
    const result = await renderRootShell({
      options,
      initialSnapshot: snapshot,
    });

    if (result.kind === 'exit') {
      return;
    }

    snapshot = result.snapshot;
    const { buildProgram } = await import('../program');
    await buildProgram().parseAsync(['node', 'masumi-agent-messenger', ...toGlobalArgs(options), ...result.args]);
  }
}
