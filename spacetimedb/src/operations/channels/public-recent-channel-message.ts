import { t } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  SelectedPublicRecentChannelMessageRow,
  toSelectedPublicRecentChannelMessageRow,
} = model;

// Compatibility view for older generated clients. New clients should subscribe
// directly to publicRecentChannelMessage with a channelId filter.
export const selectedPublicRecentChannelMessages = spacetimedb.view(
  { public: true },
  t.array(SelectedPublicRecentChannelMessageRow),
  ctx => {
    return Array.from(ctx.db.publicRecentChannelMessage.iter())
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
