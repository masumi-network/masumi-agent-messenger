import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getKeyVaultStatus,
  initializeKeyVault,
  unlockKeyVault,
  type KeyVaultOwner,
} from '@/lib/agent-session';
import { useAuthSession } from '@/lib/auth-session';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { normalizeEmail } from '../../../shared/inbox-slug';

export type UseKeyVaultResult = {
  owner: KeyVaultOwner | null;
  initialized: boolean;
  unlocked: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  handleSubmit: (passphrase: string) => Promise<void>;
};

export function useKeyVault(): UseKeyVaultResult {
  const auth = useAuthSession();
  const [initialized, setInitialized] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const authenticatedSession = auth.status === 'authenticated' ? auth.session : null;

  const owner = useMemo<KeyVaultOwner | null>(
    () =>
      authenticatedSession
        ? {
            userId: `${authenticatedSession.user.issuer}:${authenticatedSession.user.subject}`,
            normalizedEmail: normalizeEmail(authenticatedSession.user.email ?? ''),
          }
        : null,
    [authenticatedSession]
  );

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated || !owner) {
      return;
    }

    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setLoading(true);
      }
    });
    void getKeyVaultStatus(owner)
      .then(status => {
        if (cancelled) return;
        setInitialized(status.initialized);
        setUnlocked(status.unlocked);
        setError(null);
      })
      .catch(vaultStatusError => {
        if (cancelled) return;
        setError(
          vaultStatusError instanceof Error
            ? vaultStatusError.message
            : 'Unable to inspect the local key vault'
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hydrated, owner]);

  const handleSubmit = useCallback(
    async (passphrase: string): Promise<void> => {
      setSubmitting(true);
      setError(null);

      try {
        if (!owner) {
          throw new Error('Masumi user identity is required before unlocking private keys.');
        }
        if (initialized) {
          await unlockKeyVault(owner, passphrase);
        } else {
          await initializeKeyVault(owner, passphrase);
          setInitialized(true);
        }
        setUnlocked(true);
      } catch (vaultUnlockError) {
        setError(
          vaultUnlockError instanceof Error
            ? vaultUnlockError.message
            : 'Unable to unlock the local key vault'
        );
        throw vaultUnlockError instanceof Error
          ? vaultUnlockError
          : new Error('Unable to unlock the local key vault');
      } finally {
        setSubmitting(false);
      }
    },
    [initialized, owner]
  );

  return {
    owner,
    initialized,
    unlocked,
    loading,
    submitting,
    error,
    handleSubmit,
  };
}
