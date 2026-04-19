export const RESERVED_INBOX_SLUGS = ['favicon.ico', 'robots.txt', 'sitemap.xml'] as const;

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeInboxSlug(value: string): string {
  return stripDiacritics(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function emailSlugBase(normalizedEmail: string): string {
  const slug = normalizeInboxSlug(normalizedEmail);
  return slug || 'inbox';
}

function hashBase36(value: string): string {
  let hash = FNV64_OFFSET_BASIS;

  for (const char of value) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }

  return hash.toString(36).padStart(13, '0');
}

export function buildDefaultInboxSlug(email: string): string {
  const normalizedEmail = normalizeEmail(email);
  return `${emailSlugBase(normalizedEmail)}-${hashBase36(normalizedEmail).slice(0, 8)}`;
}

export function buildPreferredDefaultInboxSlug(
  email: string,
  isTaken: (slug: string) => boolean
): string {
  const normalizedEmail = normalizeEmail(email);
  const baseSlug = emailSlugBase(normalizedEmail);

  if (!isReservedInboxSlug(baseSlug) && !isTaken(baseSlug)) {
    return baseSlug;
  }

  const hashedSlug = buildDefaultInboxSlug(normalizedEmail);
  if (!isReservedInboxSlug(hashedSlug) && !isTaken(hashedSlug)) {
    return hashedSlug;
  }

  for (let attempt = 2; attempt < 10_000; attempt += 1) {
    const candidate = `${hashedSlug}-${attempt}`;
    if (!isReservedInboxSlug(candidate) && !isTaken(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to generate an available default inbox slug');
}

export function inboxSlugContainsEmailToken(slug: string, email: string): boolean {
  const emailToken = emailSlugBase(normalizeEmail(email));
  return emailToken.length > 0 && normalizeInboxSlug(slug).includes(emailToken);
}

export function isReservedInboxSlug(slug: string): boolean {
  const normalizedSlug = normalizeInboxSlug(slug);
  return RESERVED_INBOX_SLUGS.includes(
    normalizedSlug as (typeof RESERVED_INBOX_SLUGS)[number]
  );
}
