import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { spawn } from 'node:child_process';

type InkInputKey = Parameters<Parameters<typeof useInput>[0]>[1];

export type TaskEvent = {
  kind: 'info' | 'success' | 'error';
  text: string;
};

export type TaskBanner = {
  code: string;
  label?: string;
  hint: string;
  verificationUri?: string;
};

export type TaskPrompt = {
  onCancel: () => void;
} & (
  | {
      kind: 'press-enter';
      message: string;
      onSubmit: () => void;
    }
  | {
      kind: 'choice';
      question: string;
      options: Array<{ label: string }>;
      selectedIndex: number;
      onSelectedIndexChange: (index: number) => void;
      onSubmit: (index: number) => void;
    }
  | {
      kind: 'confirm';
      question: string;
      value: boolean;
      defaultValue?: boolean;
      onValueChange: (value: boolean) => void;
      onSubmit: (value: boolean) => void;
    }
  | {
      kind: 'text' | 'secret';
      question: string;
      value: string;
      cursor: number;
      defaultValue?: string;
      placeholder?: string;
      onChange: (value: string, cursor: number) => void;
      onSubmit: (value: string) => void;
    }
  | {
      kind: 'multiline';
      question: string;
      doneMessage: string;
      lines: string[];
      value: string;
      cursor: number;
      placeholder?: string;
      onChange: (value: string, cursor: number) => void;
      onAddLine: (line: string) => void;
      onSubmit: () => void;
    }
);

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

function clampCursor(cursor: number, value: string): number {
  return Math.max(0, Math.min(value.length, cursor));
}

function insertInput(value: string, cursor: number, input: string): [string, number] {
  const safeCursor = clampCursor(cursor, value);
  const nextValue = value.slice(0, safeCursor) + input + value.slice(safeCursor);
  return [nextValue, safeCursor + input.length];
}

function removeBeforeCursor(value: string, cursor: number): [string, number] {
  const safeCursor = clampCursor(cursor, value);
  if (safeCursor <= 0) {
    return [value, safeCursor];
  }
  return [value.slice(0, safeCursor - 1) + value.slice(safeCursor), safeCursor - 1];
}

function removeAtCursor(value: string, cursor: number): [string, number] {
  const safeCursor = clampCursor(cursor, value);
  if (safeCursor >= value.length) {
    return [value, safeCursor];
  }
  return [value.slice(0, safeCursor) + value.slice(safeCursor + 1), safeCursor];
}

function shouldInsertInput(input: string, key: InkInputKey): boolean {
  return Boolean(input && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape);
}

function renderEditableValue(params: {
  value: string;
  cursor: number;
  secret?: boolean;
  placeholder?: string;
}) {
  const displayValue = params.secret ? '*'.repeat(params.value.length) : params.value;
  const cursor = clampCursor(params.cursor, displayValue);
  if (!displayValue) {
    return (
      <Text>
        <Text inverse> </Text>
        {params.placeholder ? <Text color="gray">{params.placeholder}</Text> : null}
      </Text>
    );
  }

  const before = displayValue.slice(0, cursor);
  const active = displayValue[cursor] ?? ' ';
  const after = cursor < displayValue.length ? displayValue.slice(cursor + 1) : '';

  return (
    <Text>
      {before}
      <Text inverse>{active}</Text>
      {after}
    </Text>
  );
}

function editValueFromInput(prompt: Extract<TaskPrompt, { kind: 'text' | 'secret' | 'multiline' }>, input: string, key: InkInputKey): void {
  if (key.leftArrow) {
    prompt.onChange(prompt.value, clampCursor(prompt.cursor - 1, prompt.value));
    return;
  }
  if (key.rightArrow) {
    prompt.onChange(prompt.value, clampCursor(prompt.cursor + 1, prompt.value));
    return;
  }
  if (key.home) {
    prompt.onChange(prompt.value, 0);
    return;
  }
  if (key.end) {
    prompt.onChange(prompt.value, prompt.value.length);
    return;
  }
  if (key.backspace) {
    const [nextValue, nextCursor] = removeBeforeCursor(prompt.value, prompt.cursor);
    prompt.onChange(nextValue, nextCursor);
    return;
  }
  if (key.delete) {
    const [nextValue, nextCursor] = removeAtCursor(prompt.value, prompt.cursor);
    prompt.onChange(nextValue, nextCursor);
    return;
  }
  if (shouldInsertInput(input, key)) {
    const [nextValue, nextCursor] = insertInput(prompt.value, prompt.cursor, input);
    prompt.onChange(nextValue, nextCursor);
  }
}

function renderPrompt(prompt: TaskPrompt) {
  if (prompt.kind === 'press-enter') {
    return <Text color="cyan">{prompt.message}</Text>;
  }

  if (prompt.kind === 'choice') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">{prompt.question}</Text>
        {prompt.options.map((option, index) => (
          <Text key={`${option.label}:${index}`} color={index === prompt.selectedIndex ? 'cyan' : 'gray'}>
            {index === prompt.selectedIndex ? '> ' : '  '}
            {option.label}
          </Text>
        ))}
        <Text color="gray">Up/Down select · Enter confirm · Esc cancel</Text>
      </Box>
    );
  }

  if (prompt.kind === 'confirm') {
    const yesSuffix = prompt.defaultValue === true ? ' (default)' : '';
    const noSuffix = prompt.defaultValue === false ? ' (default)' : '';
    return (
      <Box flexDirection="column">
        <Text color="cyan">{prompt.question}</Text>
        <Text>
          <Text color={prompt.value ? 'cyan' : 'gray'}>{prompt.value ? '> ' : '  '}Yes{yesSuffix}</Text>
          <Text color="gray"> / </Text>
          <Text color={!prompt.value ? 'cyan' : 'gray'}>{!prompt.value ? '> ' : '  '}No{noSuffix}</Text>
        </Text>
        <Text color="gray">Left/Right select · y/n choose · Enter confirm · Esc cancel</Text>
      </Box>
    );
  }

  if (prompt.kind === 'text' || prompt.kind === 'secret') {
    const hasDefault = Boolean(prompt.defaultValue && prompt.defaultValue.length > 0);
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          {prompt.question}
          {prompt.kind === 'text' && hasDefault ? <Text color="gray"> [default: {prompt.defaultValue}]</Text> : null}
          {prompt.kind === 'secret' && hasDefault ? <Text color="gray"> [Enter keeps current value]</Text> : null}
        </Text>
        <Text>
          <Text color="green">{'> '}</Text>
          {renderEditableValue({
            value: prompt.value,
            cursor: prompt.cursor,
            secret: prompt.kind === 'secret',
            placeholder:
              prompt.placeholder ??
              (prompt.kind === 'secret' ? 'Hidden input' : hasDefault ? 'Press Enter for default' : 'Type here'),
          })}
        </Text>
        <Text color="gray">Enter submit · Esc cancel</Text>
      </Box>
    );
  }

  if (prompt.kind !== 'multiline') {
    return null;
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan">{prompt.question}</Text>
      <Text color="gray">{prompt.doneMessage}</Text>
      {prompt.lines.map((line, index) => (
        <Text key={`${index}:${line}`} color="gray">
          . {line}
        </Text>
      ))}
      <Text>
        <Text color="green">{'> '}</Text>
        {renderEditableValue({
          value: prompt.value,
          cursor: prompt.cursor,
          placeholder: prompt.placeholder ?? 'Type a line',
        })}
      </Text>
      <Text color="gray">Enter adds line · empty line submits · Esc cancel</Text>
    </Box>
  );
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
      if (hasActivePrompt) {
        const prompt = state.prompt!;
        if (key.escape || (key.ctrl && input === 'c')) {
          prompt.onCancel();
          return;
        }

        if (prompt.kind === 'press-enter') {
          if (key.return) {
            prompt.onSubmit();
          }
          return;
        }

        if (prompt.kind === 'choice') {
          if (key.upArrow) {
            const nextIndex =
              prompt.selectedIndex <= 0 ? prompt.options.length - 1 : prompt.selectedIndex - 1;
            prompt.onSelectedIndexChange(nextIndex);
            return;
          }
          if (key.downArrow) {
            const nextIndex =
              prompt.selectedIndex >= prompt.options.length - 1 ? 0 : prompt.selectedIndex + 1;
            prompt.onSelectedIndexChange(nextIndex);
            return;
          }
          if (key.return) {
            prompt.onSubmit(prompt.selectedIndex);
          }
          return;
        }

        if (prompt.kind === 'confirm') {
          const lowered = input.toLowerCase();
          if (lowered === 'y') {
            prompt.onSubmit(true);
            return;
          }
          if (lowered === 'n') {
            prompt.onSubmit(false);
            return;
          }
          if (key.leftArrow || key.rightArrow || key.tab) {
            prompt.onValueChange(!prompt.value);
            return;
          }
          if (key.return) {
            prompt.onSubmit(prompt.value);
          }
          return;
        }

        if (prompt.kind === 'text' || prompt.kind === 'secret') {
          if (key.return) {
            prompt.onSubmit(prompt.value);
            return;
          }
          editValueFromInput(prompt, input, key);
          return;
        }

        if (prompt.kind !== 'multiline') {
          return;
        }

        if (key.return) {
          if (prompt.value.length === 0) {
            prompt.onSubmit();
            return;
          }
          prompt.onAddLine(prompt.value);
          return;
        }
        editValueFromInput(prompt, input, key);
        return;
      }

      if (key.return) {
        if (shouldAnimateCelebration) {
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
        lowered === 'c' ? state.banner.verificationUri : state.banner.code;

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
            {state.banner.label ?? 'Your code'}:{' '}
            <Text bold color="yellowBright">{state.banner.code}</Text>
          </Text>
          <Text color="gray">{state.banner.hint}</Text>
        </Box>
      ) : null}
      {hasActivePrompt ? (
        renderPrompt(state.prompt!)
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
