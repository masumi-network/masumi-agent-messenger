const PATRICK_EMAILS = new Set([
  'patrick.tobler@nmkr.io',
  'patrick@yellowhouse.gmbh',
]);

const PATRICK_NAMES = new Set(['patrick tobler']);

const FIREWORK_LINES = [
  '      .   *   .      ',
  '    .   \\  |  /  .   ',
  '  .   --  <*>  --  . ',
  '    .   /  |  \\  .   ',
  '      .   / \\  .     ',
];

export type BirthdayCelebration = {
  message: string;
  fireworks: string[];
};

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function getBirthdayCelebration(params: {
  email?: string | null;
  displayName?: string | null;
  now?: Date;
}): BirthdayCelebration | null {
  const email = normalize(params.email);
  const displayName = normalize(params.displayName);
  const now = params.now ?? new Date();
  const isPatrick = PATRICK_EMAILS.has(email) || PATRICK_NAMES.has(displayName);
  const isApril = now.getMonth() === 3;
  const dayOfMonth = now.getDate();

  if (!isPatrick || !isApril || dayOfMonth < 12 || dayOfMonth > 16) {
    return null;
  }

  return {
    message:
      dayOfMonth === 12
        ? 'Happy Birthday Patrick!'
        : 'Happy late birthday Patrick!',
    fireworks: FIREWORK_LINES,
  };
}
