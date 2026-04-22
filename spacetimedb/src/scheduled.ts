type ScheduledReducerName =
  | 'expireInboxAuthLease'
  | 'expireDeviceKeyBundle'
  | 'expireRateLimitBucket'
  | 'expireRateLimitReport';

const scheduledReducers: Partial<Record<ScheduledReducerName, unknown>> = {};

export function bindScheduledReducers(reducers: Record<ScheduledReducerName, unknown>): void {
  Object.assign(scheduledReducers, reducers);
}

export function getScheduledReducer(name: ScheduledReducerName): unknown {
  const reducer = scheduledReducers[name];
  if (!reducer) {
    throw new TypeError('Scheduled reducer ' + name + ' was not bound');
  }
  return reducer;
}
