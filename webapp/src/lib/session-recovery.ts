function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return null;
}

function nestedErrorMatches(
  error: unknown,
  predicate: (message: string) => boolean
): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 6; depth += 1) {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);

    const message = errorMessage(current);
    if (message && predicate(message.toLowerCase())) {
      return true;
    }

    if (typeof current !== 'object' || current === null) {
      return false;
    }
    if ('cause' in current && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    if ('event' in current && current.event !== undefined) {
      current = current.event;
      continue;
    }
    return false;
  }

  return false;
}

export function isOidcTokenExpiredError(error: unknown): boolean {
  return nestedErrorMatches(
    error,
    message =>
      message.includes('oidc token is expired') ||
      message.includes('oidc token expired') ||
      message.includes('oidc id_token is expired')
  );
}

export function isKeyVaultLockedError(error: unknown): boolean {
  return nestedErrorMatches(
    error,
    message =>
      message.includes('private keys are locked') ||
      message.includes('unlock the local key vault')
  );
}
