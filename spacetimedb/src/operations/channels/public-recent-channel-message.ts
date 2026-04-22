import { t } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  SelectedPublicRecentChannelMessageRow,
  toSelectedPublicRecentChannelMessageRow,
} = model;
export const selectedPublicRecentChannelMessages = spacetimedb.view(
  { public: true },
  t.array(SelectedPublicRecentChannelMessageRow),
  ctx => {
    return Array.from(ctx.db.publicRecentChannelMessage.iter())
      .filter(message => {
        const channel = ctx.db.channel.id.find(message.channelId);
        return Boolean(channel && channel.accessMode === 'public' && channel.discoverable);
      })
      .sort((left, right) => {
        if (left.channelId < right.channelId) return -1;
        if (left.channelId > right.channelId) return 1;
        if (left.channelSeq > right.channelSeq) return -1;
        if (left.channelSeq < right.channelSeq) return 1;
        return Number(right.id - left.id);
      })
      .map(message => toSelectedPublicRecentChannelMessageRow(ctx, message));
  }
);
