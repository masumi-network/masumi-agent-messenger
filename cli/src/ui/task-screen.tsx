import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { spawn } from 'node:child_process';

export type TaskEvent = {
  kind: 'info' | 'success' | 'error';
  text: string;
};

export type TaskBanner = {
  userCode: string;
  hint: string;
  verificationUri?: string;
};

export type TaskPrompt = {
  message: string;
  onConfirm: () => void;
};

export type TaskRenderState = {
  title: string;
  events: TaskEvent[];
  active?: string;
  banner?: TaskBanner;
  prompt?: TaskPrompt;
  final?: {
    kind: 'success' | 'error';
    summary: string;
    details: string[];
    celebration?: {
      message: string;
      fireworks: string[];
    };
  };
};

const ANIMATED_FIREWORK_FRAMES = [
  [
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '           .           ',
    '           |           ',
    '           ^           ',
    '          /#\\          ',
    '          |#|          ',
    '          / \\          ',
  ],
  [
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '           .           ',
    '           |           ',
    '           |           ',
    '           |           ',
    '           ^           ',
    '          /#\\          ',
    '          |#|          ',
    '          / \\          ',
  ],
  [
    '                       ',
    '           .           ',
    '           |           ',
    '           |           ',
    '           |           ',
    '           |           ',
    '           |           ',
    '           |           ',
    '           ^           ',
    '          /#\\          ',
    '          |#|          ',
    '          / \\          ',
  ],
  [
    '           .           ',
    '           |           ',
    '           |           ',
    '           |           ',
    '           `           ',
    '                       ',
    '           *           ',
    '          \\|/          ',
    '        `--*--`        ',
    '          /|\\          ',
    '           / \\         ',
    '                       ',
  ],
  [
    '      .       .        ',
    '         . | .         ',
    '       .  \\|/  .       ',
    '     .  -- * --  .     ',
    '       .  /|\\  .       ',
    '      .  / | \\  .      ',
    '         /  \\          ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
  ],
  [
    '   .   *    .    *   . ',
    '      .  \\  |  /  .    ',
    '  *  .   \\ | /   .  *  ',
    '    .  --- <*> --- .   ',
    '  *  .   / | \\   .  *  ',
    '      .  /  |  \\ .     ',
    '   .   *   / \\   *  .  ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
  ],
  [
    ' .    .        .    .  ',
    '    .   *  *   .       ',
    ' .    *  \\|/  *    .   ',
    '    .  -- + --  .      ',
    ' .    *  /|\\  *    .   ',
    '    .    / \\   .       ',
    ' .    .       .    .   ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
  ],
  [
    '       .     .         ',
    '    .     *     .      ',
    '       .  \\|/  .       ',
    '    .    --*--   .     ',
    '       .  /|\\  .       ',
    "    .      '      .     ",
    '       .     .         ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
    '                       ',
  ],
];
const ACTIVE_SPINNER_FRAMES = ['[   ]', '[=  ]', '[== ]', '[===]', '[ ==]', '[  =]'];
const FIREWORK_FRAME_COLORS = [
  'gray',
  'yellow',
  'yellow',
  'yellow',
  'magenta',
  'cyan',
  'red',
  'gray',
] as const;

function colorForEvent(kind: TaskEvent['kind']): 'blue' | 'green' | 'red' {
  if (kind === 'success') return 'green';
  if (kind === 'error') return 'red';
  return 'blue';
}

function prefixForEvent(kind: TaskEvent['kind']): string {
  if (kind === 'success') return '[ok]';
  if (kind === 'error') return '[!!]';
  return '[..]';
}

export function TaskScreen({ state }: { state: TaskRenderState }) {
  const { exit } = useApp();
  const shouldAnimateCelebration = Boolean(state.final?.celebration);
  const [frameIndex, setFrameIndex] = useState(0);
  const [spinnerIndex, setSpinnerIndex] = useState(0);

  useEffect(() => {
    if (!shouldAnimateCelebration) {
      setFrameIndex(0);
      return;
    }

    const intervalId = setInterval(() => {
      setFrameIndex(current => (current + 1) % ANIMATED_FIREWORK_FRAMES.length);
    }, 160);

    return () => {
      clearInterval(intervalId);
    };
  }, [shouldAnimateCelebration]);

  useEffect(() => {
    if (!state.active || state.final) {
      setSpinnerIndex(0);
      return;
    }

    const intervalId = setInterval(() => {
      setSpinnerIndex(current => (current + 1) % ACTIVE_SPINNER_FRAMES.length);
    }, 120);

    return () => {
      clearInterval(intervalId);
    };
  }, [state.active, state.final]);

  const hasActivePrompt = Boolean(state.prompt && !state.final);

  useInput(
    (input, key) => {
      if (key.return) {
        if (hasActivePrompt) {
          state.prompt!.onConfirm();
        } else if (shouldAnimateCelebration) {
          exit();
        }
      }

      // One-key copy helpers for auth device-code flows.
      // Only when banner is visible and no blocking prompt is active.
      if (!state.banner || state.final || hasActivePrompt) {
        return;
      }

      const char = input?.trim();
      if (!char) {
        return;
      }

      const lowered = char.toLowerCase();
      if (lowered !== 'c' && lowered !== 'u') {
        return;
      }

      const textToCopy =
        lowered === 'c' ? state.banner.verificationUri : state.banner.userCode;

      if (!textToCopy) {
        return;
      }

      try {
        const platform = process.platform;

        if (platform === 'darwin') {
          const p = spawn('pbcopy');
          p.stdin.end(textToCopy);
          return;
        }

        if (platform === 'win32') {
          const p = spawn('clip');
          p.stdin.end(textToCopy);
          return;
        }

        // Linux: try xclip then wl-copy.
        const tryCmds = [['xclip', ['-selection', 'clipboard']], ['wl-copy', []]] as const;
        for (const [cmd, extraArgs] of tryCmds) {
          try {
            const p = spawn(cmd, [...extraArgs]);
            p.stdin.end(textToCopy);
            return;
          } catch {
            continue;
          }
        }
      } catch {
        // Best-effort copy; no UI side effects.
      }
    },
    {
      isActive: hasActivePrompt || shouldAnimateCelebration,
    }
  );

  return (
    <Box flexDirection="column">
      <Static items={state.events}>
        {event => (
          <Text color={colorForEvent(event.kind)}>
            {prefixForEvent(event.kind)} {event.text}
          </Text>
        )}
      </Static>
      {state.banner && !state.final ? (
        <Box
          flexDirection="column"
          marginTop={1}
          marginBottom={1}
          borderStyle="single"
          borderColor="yellow"
          paddingLeft={1}
          paddingRight={1}
        >
          <Text>
            Your code: <Text bold color="yellowBright">{state.banner.userCode}</Text>
          </Text>
          <Text color="gray">{state.banner.hint}</Text>
        </Box>
      ) : null}
      {hasActivePrompt ? (
        <Text color="cyan">{state.prompt!.message}</Text>
      ) : state.active && !state.final ? (
        <Text color="cyan">
          {ACTIVE_SPINNER_FRAMES[spinnerIndex]} {state.active}
        </Text>
      ) : null}
      {state.final ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={state.final.kind === 'success' ? 'green' : 'red'}>
            {state.final.kind === 'success' ? '[done]' : '[fail]'} {state.final.summary}
          </Text>
          {state.final.details.map((detail, index) => (
            <Text key={`${detail}:${index}`} color="gray">
              {detail}
            </Text>
          ))}
          {state.final.celebration ? (
            <Box marginTop={1} marginBottom={1} flexDirection="column">
              <Text color="yellowBright">{state.final.celebration.message}</Text>
              {ANIMATED_FIREWORK_FRAMES[frameIndex].map((line, index) => (
                <Text
                  key={`${frameIndex}:${line}:${index}`}
                  color={FIREWORK_FRAME_COLORS[frameIndex % FIREWORK_FRAME_COLORS.length]}
                >
                  {line}
                </Text>
              ))}
              <Text color="gray">Press Enter to continue.</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
