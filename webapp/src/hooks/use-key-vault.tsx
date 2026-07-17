import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
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

const KeyVaultContext = createContext<UseKeyVaultResult | null>(null);

function useKeyVaultState(): UseKeyVaultResult {
  const auth = useAuthSession();
  const [initialized, setInitialized] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const authenticatedSession =
    auth.status === 'authenticated' ? auth.session : null;
  const ownerUserId = authenticatedSession
    ? `${authenticatedSession.user.issuer}:${authenticatedSession.user.subject}`
    : null;
  const ownerEmail = authenticatedSession
    ? normalizeEmail(authenticatedSession.user.email ?? '')
    : null;

  const owner = useMemo<KeyVaultOwner | null>(
    () =>
      ownerUserId && ownerEmail !== null
        ? {
            userId: ownerUserId,
            email: ownerEmail,
          }
        : null,
    [ownerEmail, ownerUserId]
  );

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    if (!owner) {
      return deferEffectStateUpdate(() => {
        setInitialized(false);
        setUnlocked(false);
        setLoading(false);
        setError(null);
      });
    }

    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setInitialized(false);
        setUnlocked(false);
        setLoading(true);
        setError(null);
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

export function KeyVaultProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const vault = useKeyVaultState();
  return (
    <KeyVaultContext.Provider value={vault}>
      {children}
    </KeyVaultContext.Provider>
  );
}

export function useKeyVault(): UseKeyVaultResult {
  const vault = useContext(KeyVaultContext);
  if (!vault) {
    throw new Error('useKeyVault must be used within KeyVaultProvider');
  }
  return vault;
}
