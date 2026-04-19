const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const FG_RED = `${ESC}31m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_BLUE = `${ESC}34m`;
const FG_MAGENTA = `${ESC}35m`;
const FG_CYAN = `${ESC}36m`;
const FG_WHITE = `${ESC}37m`;
const FG_GRAY = `${ESC}90m`;

const SENDER_COLORS = [FG_CYAN, FG_MAGENTA, FG_YELLOW, FG_GREEN, FG_BLUE, FG_RED] as const;

function isColorDisabled(): boolean {
  return Boolean(process.env.NO_COLOR);
}

function wrap(code: string, text: string): string {
  if (isColorDisabled()) return text;
  return `${code}${text}${RESET}`;
}

export function bold(text: string): string {
  return wrap(BOLD, text);
}

export function dim(text: string): string {
  return wrap(DIM, text);
}

export function green(text: string): string {
  return wrap(FG_GREEN, text);
}

export function red(text: string): string {
  return wrap(FG_RED, text);
}

export function yellow(text: string): string {
  return wrap(FG_YELLOW, text);
}

export function cyan(text: string): string {
  return wrap(FG_CYAN, text);
}

export function gray(text: string): string {
  return wrap(FG_GRAY, text);
}

export function blue(text: string): string {
  return wrap(FG_BLUE, text);
}

export function magenta(text: string): string {
  return wrap(FG_MAGENTA, text);
}

export function white(text: string): string {
  return wrap(FG_WHITE, text);
}

export const symbols = {
  pointer: '▸',
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: '●',
  bullet: '◆',
  dot: '·',
  arrowRight: '→',
} as const;

function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function senderColor(name: string): string {
  if (isColorDisabled()) return name;
  const color = SENDER_COLORS[hashCode(name) % SENDER_COLORS.length];
  return `${color}${name}${RESET}`;
}

export function badge(label: string, color: (s: string) => string): string {
  return color(`[${label}]`);
}

const ANSI_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');

function stripAnsi(s: string): number {
  return s.replace(ANSI_PATTERN, '').length;
}

function padVisual(s: string, width: number): string {
  const visible = stripAnsi(s);
  return visible >= width ? s : s + ' '.repeat(width - visible);
}

export type TableColumn = {
  header: string;
  key: string;
  color?: (s: string) => string;
  align?: 'left' | 'right';
};

export function renderTable(rows: Record<string, string>[], columns: TableColumn[]): string[] {
  if (rows.length === 0) return [];

  const widths = columns.map(col =>
    Math.max(col.header.length, ...rows.map(row => stripAnsi(row[col.key] ?? '')))
  );

  const header = columns
    .map((col, i) => padVisual(dim(col.header), widths[i]))
    .join('  ');

  const separator = columns
    .map((_col, i) => dim('─'.repeat(widths[i])))
    .join('  ');

  const dataRows = rows.map(row =>
    columns
      .map((col, i) => {
        const value = row[col.key] ?? '';
        const colored = col.color ? col.color(value) : value;
        return col.align === 'right'
          ? ' '.repeat(Math.max(0, widths[i] - stripAnsi(colored))) + colored
          : padVisual(colored, widths[i]);
      })
      .join('  ')
  );

  return [header, separator, ...dataRows];
}

export function renderKeyValue(
  pairs: Array<{ key: string; value: string; color?: (s: string) => string }>
): string[] {
  const maxKeyLen = Math.max(...pairs.map(p => p.key.length));
  return pairs.map(p => {
    const label = dim(p.key.padEnd(maxKeyLen));
    const value = p.color ? p.color(p.value) : p.value;
    return `  ${label}  ${value}`;
  });
}

export function renderEmpty(message: string): string {
  return dim(message);
}

export function renderEmptyWithTry(message: string, tryCommand: string): string {
  return `${dim(message)}\n${dim('Try:')} ${tryCommand}`;
}
