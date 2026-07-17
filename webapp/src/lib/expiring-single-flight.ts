type SingleFlightEntry<Result> = {
  promise: Promise<Result>;
  expiresAtMs: number | null;
};

export class ExpiringSingleFlight<Result> {
  private readonly entries = new Map<string, SingleFlightEntry<Result>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: {
    ttlMs: number;
    maxEntries?: number;
    now?: () => number;
  }) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? Date.now;
  }

  run(key: string, task: () => Promise<Result>): Promise<Result> {
    const nowMs = this.now();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.expiresAtMs === null || existing.expiresAtMs > nowMs) {
        return existing.promise;
      }
      this.entries.delete(key);
    }

    this.pruneExpired(nowMs);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }
      this.entries.delete(oldestKey);
    }

    const entry: SingleFlightEntry<Result> = {
      promise: Promise.resolve().then(task),
      expiresAtMs: null,
    };
    this.entries.set(key, entry);

    void entry.promise.then(
      () => {
        if (this.entries.get(key) === entry) {
          entry.expiresAtMs = this.now() + this.ttlMs;
        }
      },
      () => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
      }
    );

    return entry.promise;
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
        this.entries.delete(key);
      }
    }
  }
}
