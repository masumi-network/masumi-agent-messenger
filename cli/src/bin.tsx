import './services/runtime-polyfills';
import { runProgram } from './program';
import { emitCliError } from './services/command-runtime';
import { isCliError } from './services/errors';

// Detect global flags that change the error shape before the program parses
// them. Allows pre-runtime guards (thrown from action handlers before
// `runCommandAction` is called) to still emit a JSON envelope when the user
// asked for one.
function detectJsonFlag(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

function detectColorFlag(argv: readonly string[]): boolean {
  return !argv.includes('--no-color');
}

try {
  await runProgram(process.argv);
} catch (error) {
  // Commander's built-in exits (e.g. `--help`, `--version`, unknown option
  // errors it formatted itself) set `process.exitCode` and return without
  // throwing, so they never reach this block. Anything else (CliError from a
  // precondition guard, an unexpected runtime error) must still respect the
  // user's output preferences.
  if (!isCliError(error) && !(error instanceof Error)) {
    // Unknown non-Error throw: let the runtime surface it loudly.
    throw error;
  }

  emitCliError(error, {
    json: detectJsonFlag(process.argv.slice(2)),
    color: detectColorFlag(process.argv.slice(2)),
  });
}
