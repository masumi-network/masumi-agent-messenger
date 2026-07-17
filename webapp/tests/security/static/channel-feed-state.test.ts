import { describe, expect, it } from 'vitest';
import { isChannelFeedReady } from '@/lib/channel-feed-state';

describe('channel feed readiness', () => {
  it('does not wait for the disabled public lookup on approval channels', () => {
    expect(
      isChannelFeedReady({
        accessMode: 'approval_required',
        historyReady: true,
        publicMessagesReady: false,
        canReadAuthenticatedHistory: true,
      })
    ).toBe(true);
  });

  it('renders authenticated public history without waiting for the public lookup', () => {
    expect(
      isChannelFeedReady({
        accessMode: 'public',
        historyReady: true,
        publicMessagesReady: false,
        canReadAuthenticatedHistory: true,
      })
    ).toBe(true);
  });

  it('waits for public messages when authenticated history is unavailable', () => {
    expect(
      isChannelFeedReady({
        accessMode: 'public',
        historyReady: true,
        publicMessagesReady: false,
        canReadAuthenticatedHistory: false,
      })
    ).toBe(false);
    expect(
      isChannelFeedReady({
        accessMode: 'public',
        historyReady: true,
        publicMessagesReady: true,
        canReadAuthenticatedHistory: false,
      })
    ).toBe(true);
  });

  it('waits for the channel and history source before rendering', () => {
    expect(
      isChannelFeedReady({
        accessMode: null,
        historyReady: true,
        publicMessagesReady: true,
        canReadAuthenticatedHistory: true,
      })
    ).toBe(false);
    expect(
      isChannelFeedReady({
        accessMode: 'approval_required',
        historyReady: false,
        publicMessagesReady: true,
        canReadAuthenticatedHistory: true,
      })
    ).toBe(false);
  });
});
