import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isDeregisteringOrDeregisteredInboxAgentState,
  isFailedRegistrationInboxAgentState,
} from '../../../shared/inbox-agent-registration';
import type { PeerKeyTrustStore, PeerKeyTuple } from '../../../shared/peer-key-trust';
import { isCliError } from './errors';
import { pinFirstObservation } from './peer-key-trust';
import { requirePeerKeyTrust } from './send-message';

const tupleA: PeerKeyTuple = {
  encryptionPublicKey: 'p256-ecdh-public:v1:alice:1',
  encryptionKeyVersion: 1,
  signingPublicKey: 'p256-ecdsa-public:v1:alice:1',
  signingKeyVersion: 1,
};

const tupleARotated: PeerKeyTuple = {
  encryptionPublicKey: 'p256-ecdh-public:v1:alice:2',
  encryptionKeyVersion: 2,
  signingPublicKey: 'p256-ecdsa-public:v1:alice:2',
  signingKeyVersion: 2,
};

async function readPersistedTrustStore(configDir: string): Promise<PeerKeyTrustStore> {
  const raw = await readFile(path.join(configDir, 'masumi-agent-messenger', 'cli', 'peer-key-trust.json'), 'utf8');
  return JSON.parse(raw) as PeerKeyTrustStore;
}

async function writePersistedTrustStore(configDir: string, store: unknown): Promise<void> {
  const filePath = path.join(
    configDir,
    'masumi-agent-messenger',
    'cli',
    'peer-key-trust.json'
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

describe('send-message', () => {
  let tempDir: string;
  let previousXdgConfigHome: string | undefined;

  beforeEach(async () => {
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'send-message-'));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(async () => {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('requirePeerKeyTrust', () => {
    it('returns silently when the observed tuple matches the pinned one', async () => {
      await pinFirstObservation('alice-id', tupleA);
      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleA,
          allowFirstContactTrust: false,
        })
      ).resolves.toBeUndefined();
    });

    it('accepts legacy persisted string key versions while checking message trust', async () => {
      await writePersistedTrustStore(tempDir, {
        version: 1,
        peers: {
          'alice-id': {
            publicIdentity: 'alice-id',
            pinnedAt: '2026-04-18T00:00:00.000Z',
            current: {
              ...tupleA,
              encryptionKeyVersion: 'enc-v1',
              signingKeyVersion: 'sig-v1',
            },
          },
        },
      });

      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleA,
          allowFirstContactTrust: false,
        })
      ).resolves.toBeUndefined();
    });

    it('auto-pins on first contact when allowFirstContactTrust is true', async () => {
      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleA,
          allowFirstContactTrust: true,
        })
      ).resolves.toBeUndefined();

      const store = await readPersistedTrustStore(tempDir);
      expect(store.peers['alice-id']).toBeDefined();
      expect(store.peers['alice-id']?.current).toEqual(tupleA);
    });

    it('refuses to send to an unpinned peer when allowFirstContactTrust is false', async () => {
      const error = await requirePeerKeyTrust({
        publicIdentity: 'alice-id',
        displayLabel: 'alice',
        observed: tupleA,
        allowFirstContactTrust: false,
      }).then(
        () => null,
        (caught: unknown) => caught
      );

      expect(error).not.toBeNull();
      if (!isCliError(error)) {
        throw new Error('Expected CLI error');
      }
      expect(error.code).toBe('PEER_KEY_UNPINNED');
      expect(error.message).toMatch(/not trusted/i);
    });

    it('auto-confirms when the pinned peer rotates keys', async () => {
      await pinFirstObservation('alice-id', tupleA);

      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleARotated,
          allowFirstContactTrust: false,
        })
      ).resolves.toBeUndefined();

      const store = await readPersistedTrustStore(tempDir);
      const record = store.peers['alice-id'];
      expect(record?.current).toEqual(tupleARotated);
      expect(record?.history).toHaveLength(2);
      expect(record?.history[0]).toMatchObject(tupleA);
      expect(record?.history[1]).toMatchObject(tupleARotated);
    });

    it('auto-confirms rotation even when allowFirstContactTrust is true', async () => {
      await pinFirstObservation('alice-id', tupleA);

      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleARotated,
          allowFirstContactTrust: true,
        })
      ).resolves.toBeUndefined();

      const store = await readPersistedTrustStore(tempDir);
      expect(store.peers['alice-id']?.current).toEqual(tupleARotated);
    });
  });

  describe('Masumi registry advisory predicates', () => {
    it('flags deregistering and deregistered states as send-blockers', () => {
      expect(isDeregisteringOrDeregisteredInboxAgentState('DeregistrationRequested')).toBe(true);
      expect(isDeregisteringOrDeregisteredInboxAgentState('DeregistrationInitiated')).toBe(true);
      expect(isDeregisteringOrDeregisteredInboxAgentState('DeregistrationConfirmed')).toBe(true);
    });

    it('flags failed-registration state as send-blocker', () => {
      expect(isFailedRegistrationInboxAgentState('RegistrationFailed')).toBe(true);
    });

    it('does not flag healthy registration states as send-blockers', () => {
      for (const healthy of [
        'RegistrationRequested',
        'RegistrationInitiated',
        'RegistrationConfirmed',
      ]) {
        expect(isDeregisteringOrDeregisteredInboxAgentState(healthy)).toBe(false);
        expect(isFailedRegistrationInboxAgentState(healthy)).toBe(false);
      }
    });

    it('treats null and undefined registry state as not-blocked (advisory check failed open)', () => {
      // Per CLAUDE.md: registry lookup is advisory; failures must not block sends.
      // The send-path uses `networkTarget?.state` which is undefined when the lookup
      // throws or returns null, and these predicates must NOT trip in that case.
      expect(isDeregisteringOrDeregisteredInboxAgentState(null)).toBe(false);
      expect(isDeregisteringOrDeregisteredInboxAgentState(undefined)).toBe(false);
      expect(isFailedRegistrationInboxAgentState(null)).toBe(false);
      expect(isFailedRegistrationInboxAgentState(undefined)).toBe(false);
    });
  });
});
