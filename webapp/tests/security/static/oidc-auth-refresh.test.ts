import { describe, expect, it } from 'vitest';
import { isRecoverableOidcSessionRefreshFailure } from '@/lib/oidc-auth.server';

describe('oidc refresh failure handling', () => {
  it('treats invalid refresh tokens as a recoverable sign-out condition', () => {
    expect(
      isRecoverableOidcSessionRefreshFailure(
        new Error('OIDC token exchange failed: invalid refresh token')
      )
    ).toBe(true);

    expect(
      isRecoverableOidcSessionRefreshFailure(
        new Error('OIDC token exchange failed: refresh token expired')
      )
    ).toBe(true);
  });

  it('treats invalid_grant refresh failures as recoverable', () => {
    const error = new Error('OIDC token exchange failed: invalid_grant');
    Object.assign(error, {
      oauthError: 'invalid_grant',
      oauthErrorDescription: 'refresh token revoked',
    });

    expect(isRecoverableOidcSessionRefreshFailure(error)).toBe(true);
  });

  it('does not hide unrelated OIDC failures', () => {
    expect(
      isRecoverableOidcSessionRefreshFailure(
        new Error('OIDC discovery failed (500) from https://issuer.example/.well-known/openid-configuration')
      )
    ).toBe(false);

    expect(
      isRecoverableOidcSessionRefreshFailure(
        new Error('OIDC token exchange failed: invalid client')
      )
    ).toBe(false);
  });
});
