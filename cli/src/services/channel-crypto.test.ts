import { describe, expect, it } from 'vitest';
import { generateAgentKeyPair } from '../../../shared/agent-crypto';
import {
  prepareChannelMessage,
  verifySignedChannelMessage,
  verifyChannelMessageSignature,
} from '../../../shared/channel-crypto';

describe('channel crypto helpers', () => {
  it('verifies a signed public channel message', async () => {
    const keyPair = await generateAgentKeyPair();
    const prepared = await prepareChannelMessage({
      channelId: 42n,
      senderPublicIdentity: 'alice',
      senderSeq: 1n,
      keyPair,
      payload: {
        contentType: 'text/plain',
        body: 'hello channel',
      },
    });

    const input = {
      channelId: 42n,
      senderPublicIdentity: 'alice',
      senderSeq: 1n,
      senderSigningKeyVersion: prepared.senderSigningKeyVersion,
      plaintext: prepared.plaintext,
      replyToMessageId: null,
    };

    await expect(
      verifyChannelMessageSignature({
        input,
        signature: prepared.signature,
        senderSigningPublicKey: keyPair.signing.publicKey,
      })
    ).resolves.toBe(true);

    const verified = await verifySignedChannelMessage({
      input,
      signature: prepared.signature,
      senderSigningPublicKey: keyPair.signing.publicKey,
    });
    expect(verified.payload).toEqual({
      contentType: 'text/plain',
      body: 'hello channel',
    });
  });

  it('rejects tampered sender identity before reading plaintext', async () => {
    const keyPair = await generateAgentKeyPair();
    const prepared = await prepareChannelMessage({
      channelId: 7n,
      senderPublicIdentity: 'alice',
      senderSeq: 1n,
      keyPair,
      payload: {
        contentType: 'text/plain',
        body: 'signed text',
      },
    });

    await expect(
      verifySignedChannelMessage({
        input: {
          channelId: 7n,
          senderPublicIdentity: 'mallory',
          senderSeq: 1n,
          senderSigningKeyVersion: prepared.senderSigningKeyVersion,
          plaintext: prepared.plaintext,
          replyToMessageId: null,
        },
        signature: prepared.signature,
        senderSigningPublicKey: keyPair.signing.publicKey,
      })
    ).rejects.toThrow('Channel message signature verification failed');
  });
});
