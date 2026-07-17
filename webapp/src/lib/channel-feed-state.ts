export type ChannelFeedAccessMode = 'public' | 'approval_required';

export function isChannelFeedReady(params: {
  accessMode: ChannelFeedAccessMode | null;
  historyReady: boolean;
  publicMessagesReady: boolean;
  canReadAuthenticatedHistory: boolean;
}): boolean {
  if (!params.accessMode || !params.historyReady) {
    return false;
  }

  if (params.accessMode !== 'public') {
    return true;
  }

  return params.canReadAuthenticatedHistory || params.publicMessagesReady;
}
