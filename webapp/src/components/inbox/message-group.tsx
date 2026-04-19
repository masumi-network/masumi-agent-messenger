import { Fragment } from 'react';
import { MessageItem } from './message-item';
import { DayDivider } from './day-divider';
import { KeyRotationItem } from './message-item';
import { computeGroupedFlags, computeDayBoundaries } from '@/lib/group-messages';
import { formatDayLabel } from '@/lib/format-relative-time';
import { staggeredDelay } from '@/lib/use-staggered-delay';

type MessageItemProps = React.ComponentProps<typeof MessageItem>;

type BaseTimelineEntry = {
  id: string;
  senderId: string;
  createdAtMs: number;
};

export type TimelineEntry =
  | (BaseTimelineEntry & {
      kind: 'message';
      props: Omit<MessageItemProps, 'groupedWithPrevious' | 'className'>;
    })
  | (BaseTimelineEntry & {
      kind: 'keyRotation';
      actorName: string;
      timestampLabel: string;
    });

/**
 * Renders a chronological list of messages and key-rotation notices with
 * grouping (consecutive same-sender messages collapse repeated headers) and
 * day dividers ("Today"/"Yesterday"/weekday).
 */
export function MessageGroup({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return null;

  const grouped = computeGroupedFlags(
    entries.map(entry => ({ senderId: entry.senderId, createdAtMs: entry.createdAtMs }))
  );
  const dayBoundaries = computeDayBoundaries(entries);

  return (
    <>
      {entries.map((entry, index) => {
        const isGrouped = entry.kind === 'message' ? grouped[index] : false;
        const showDayDivider = dayBoundaries[index];
        const dayLabel = showDayDivider ? formatDayLabel(entry.createdAtMs) : null;

        return (
          <Fragment key={entry.id}>
            {showDayDivider && dayLabel ? <DayDivider label={dayLabel} /> : null}
            {entry.kind === 'keyRotation' ? (
              <div className="animate-soft-enter" style={staggeredDelay(index)}>
                <KeyRotationItem
                  actorName={entry.actorName}
                  timestamp={entry.timestampLabel}
                />
              </div>
            ) : (
              <MessageItem
                {...entry.props}
                groupedWithPrevious={isGrouped}
                className="animate-soft-enter"
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}
