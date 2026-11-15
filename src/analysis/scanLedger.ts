/**
 * Per-file scan bookkeeping for a host that scans while the user types: the latest stored result of each file, and the order in which
 * its scans started and finished. Has no editor dependency, so the rules can be tested without one.
 */
export interface ScanLedger<T> {
  /** Latest stored result per key. */
  readonly states: Map<string, T>;
  /** Numbers a scan of `key` when it starts. */
  begin(key: string): number;
  /** Stores the result unless a scan that started later has already stored its own: an older result never replaces a newer one. */
  commit(key: string, seq: number, state: T): boolean;
  /** Drops every scan of `key` that is still running; their results will not be stored. The stored result stays. */
  cancel(key: string): void;
  /** Forgets everything about `key`: its result and its scan order. True when a result was dropped. */
  forget(key: string): boolean;
  /** Forgets every key for which `keep` is false. Returns the keys dropped. */
  retain(keep: (key: string) => boolean): string[];
}

export function createScanLedger<T>(): ScanLedger<T> {
  const states = new Map<string, T>();
  const started = new Map<string, number>();
  const committed = new Map<string, number>();
  const ledger: ScanLedger<T> = {
    states,
    begin(key) {
      const n = (started.get(key) ?? 0) + 1;
      started.set(key, n);
      return n;
    },
    commit(key, seq, state) {
      if (seq < (committed.get(key) ?? 0)) return false;
      committed.set(key, seq);
      states.set(key, state);
      return true;
    },
    cancel(key) {
      committed.set(key, ledger.begin(key));
    },
    forget(key) {
      started.delete(key);
      committed.delete(key);
      return states.delete(key);
    },
    retain(keep) {
      const dropped: string[] = [];
      for (const key of new Set([...states.keys(), ...started.keys(), ...committed.keys()])) {
        if (keep(key)) continue;
        ledger.forget(key);
        dropped.push(key);
      }
      return dropped;
    },
  };
  return ledger;
}
