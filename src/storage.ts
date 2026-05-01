import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** "YYYY-MM-DD" in the requested IANA timezone (or the host local zone). */
export function localDayKey(d: Date, timezone?: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(d); // en-CA already gives YYYY-MM-DD
  } catch {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}

export interface AppliedRecord {
  jobId: string;
  title: string;
  company: string;
  appliedAt: string; // ISO
  status?: string;
  applicationId?: string;
  source?: string;
  traceInfo?: string;
}

export interface SessionRecord {
  accessToken?: string | null;
  refreshToken?: string | null;
  deviceId?: string;
  savedAt: string;
}

export class JsonStore<T> {
  private path: string;
  private cache: T;

  constructor(path: string, defaultValue: T) {
    this.path = resolve(process.cwd(), path);
    if (existsSync(this.path)) {
      try {
        this.cache = JSON.parse(readFileSync(this.path, "utf8")) as T;
      } catch {
        this.cache = defaultValue;
      }
    } else {
      this.cache = defaultValue;
    }
  }

  get(): T { return this.cache; }

  set(value: T): void {
    this.cache = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(value, null, 2), "utf8");
  }

  update(fn: (prev: T) => T): T {
    const next = fn(this.cache);
    this.set(next);
    return next;
  }
}

export class History {
  private store: JsonStore<{ applied: AppliedRecord[] }>;

  constructor(path = ".glints/history.json") {
    this.store = new JsonStore(path, { applied: [] });
  }

  all(): AppliedRecord[] {
    return this.store.get().applied;
  }

  has(jobId: string): boolean {
    return this.store.get().applied.some((r) => r.jobId === jobId);
  }

  /**
   * Count of applies on the local calendar day. Pass a timezone (IANA) to use
   * that zone's midnight instead of the host's local zone. Falls back to host
   * local on bad input.
   */
  appliedToday(timezone?: string): number {
    const today = localDayKey(new Date(), timezone);
    return this.store.get().applied.filter((r) => {
      try { return localDayKey(new Date(r.appliedAt), timezone) === today; }
      catch { return r.appliedAt.startsWith(today); }
    }).length;
  }

  /** Remove entries whose appliedAt falls on `today` in the given timezone. */
  clearDay(timezone?: string): number {
    const today = localDayKey(new Date(), timezone);
    let removed = 0;
    this.store.update((s) => {
      const kept = s.applied.filter((r) => {
        const same = localDayKey(new Date(r.appliedAt), timezone) === today;
        if (same) removed++;
        return !same;
      });
      return { applied: kept };
    });
    return removed;
  }

  appliedSince(sinceMs: number): AppliedRecord[] {
    const cutoff = Date.now() - sinceMs;
    return this.store.get().applied.filter((r) => Date.parse(r.appliedAt) >= cutoff);
  }

  add(rec: AppliedRecord): void {
    this.store.update((s) => ({ applied: [rec, ...s.applied].slice(0, 5000) }));
  }
}

export class SessionStore {
  private store: JsonStore<SessionRecord>;
  constructor(path = ".glints/session.json") {
    this.store = new JsonStore(path, { savedAt: new Date(0).toISOString() });
  }
  load(): SessionRecord { return this.store.get(); }
  save(s: Omit<SessionRecord, "savedAt">): void {
    this.store.set({ ...s, savedAt: new Date().toISOString() });
  }
}
