import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isKeyVaultLockedError,
  isOidcTokenExpiredError,
} from '@/lib/session-recovery';

const WEBAPP_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function readRelativeFile(relativePath: string): string {
  return readFileSync(resolve(WEBAPP_ROOT, relativePath), 'utf8');
}

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

  it('silently refreshes and reconnects stale background-tab sessions', () => {
    const authSession = readRelativeFile('src/lib/auth-session.tsx');
    const router = readRelativeFile('src/router.tsx');
    const recoveryHook = readRelativeFile('src/hooks/use-oidc-session-recovery.ts');
    const liveTable = readRelativeFile('src/lib/spacetime-live-table.ts');
    const procedureSnapshot = readRelativeFile(
      'src/lib/spacetime-procedure-snapshot.ts'
    );
    const publicChannel = readRelativeFile('src/lib/public-channel.ts');

    expect(authSession).toContain("window.addEventListener('pageshow'");
    expect(authSession).toContain("window.addEventListener('online'");
    expect(authSession).toContain("document.addEventListener('visibilitychange'");
    expect(router).toContain('isOidcTokenExpiredError(err)');
    expect(router).toContain('void refreshAuthSession()');
    expect(recoveryHook).toContain('await refreshAuthSession()');

    for (const readPath of [liveTable, procedureSnapshot, publicChannel]) {
      expect(readPath).toContain('useOidcSessionRecovery');
      expect(readPath).toContain('recoveringSession ? null');
    }
  });
});
