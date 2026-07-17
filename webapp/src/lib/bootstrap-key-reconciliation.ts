import type { AgentKeyPair } from './crypto';
import type { AgentKeyBundle } from '@/module_bindings/types';

export type ExistingActorKeySource = 'pending' | 'stored' | 'missing';

type AgentPublicKeyPair = {
  encryption: Pick<AgentKeyPair['encryption'], 'publicKey' | 'keyVersion'>;
  signing: Pick<AgentKeyPair['signing'], 'publicKey' | 'keyVersion'>;
};

export function keyBundleMatchesAgentKeyPair(
  bundle: AgentKeyBundle,
  keyPair: AgentPublicKeyPair
): boolean {
  return (
    bundle.encryptionPublicKey === keyPair.encryption.publicKey &&
    bundle.keyBundleVersion === keyPair.encryption.keyVersion &&
    bundle.signingPublicKey === keyPair.signing.publicKey &&
    bundle.keyBundleVersion === keyPair.signing.keyVersion
  );
}

export function resolveExistingActorKeySource(params: {
  bundle: AgentKeyBundle;
  pending: AgentKeyPair;
  stored: AgentKeyPair | null;
}): ExistingActorKeySource {
  if (keyBundleMatchesAgentKeyPair(params.bundle, params.pending)) {
    return 'pending';
  }
  if (
    params.stored &&
    keyBundleMatchesAgentKeyPair(params.bundle, params.stored)
  ) {
    return 'stored';
  }
  return 'missing';
}
