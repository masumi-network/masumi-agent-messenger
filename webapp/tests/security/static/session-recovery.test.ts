import { describe, expect, it } from 'vitest';
import {
  isKeyVaultLockedError,
  isOidcTokenExpiredError,
} from '@/lib/session-recovery';

describe('session recovery error classification', () => {
  it('recognizes direct and nested expired OIDC errors', () => {
    expect(isOidcTokenExpiredError(new Error('OIDC token is expired'))).toBe(true);
    expect(
      isOidcTokenExpiredError({
        event: new Error('Reducer failed: OIDC token expired'),
      })
    ).toBe(true);
    const nestedError = new Error('Operation failed') as Error & { cause?: unknown };
    nestedError.cause = new Error('OIDC id_token is expired');
    expect(isOidcTokenExpiredError(nestedError)).toBe(true);
  });

  it('does not classify unrelated authorization errors as token expiry', () => {
    expect(isOidcTokenExpiredError(new Error('Unauthorized issuer'))).toBe(false);
    expect(isOidcTokenExpiredError(new Error('Permission denied'))).toBe(false);
  });

  it('recognizes a locked local vault without mistaking missing keys for a lock', () => {
    expect(
      isKeyVaultLockedError(
        new Error('Private keys are locked. Unlock the local key vault first.')
      )
    ).toBe(true);
    expect(
      isKeyVaultLockedError(new Error('Local key pair is missing. Restore keys first.'))
    ).toBe(false);
  });
});
