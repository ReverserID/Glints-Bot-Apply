import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import "dotenv/config";

/**
 * Generate a random Android-style device id: 16 lowercase hex chars (8 bytes),
 * matching the format Glints' app uses. Stable per install — generate ONCE and
 * persist it (session.json); do NOT regenerate per request, or the server sees
 * every call as a new device and the token/session binding breaks.
 */
export function genDeviceId(): string {
  return randomBytes(8).toString("hex");
}

export type FeedSource =
  | { type: "recommend"; pageName?: string; recentlyAdded?: boolean; maxPages?: number; pageSize?: number }
  | { type: "nearby"; latitude?: number; longitude?: number; jobCategoryId?: string; maxPages?: number; pageSize?: number };

export interface Config {
  feed: {
    pageName: string;
    pageSize: number;
    maxPages: number;
    sources?: FeedSource[];
  };
  filters: {
    includeKeywords: string[];
    excludeKeywords: string[];
    jobTypes: string[];
    workArrangements: string[];
    minYearsOfExperienceMax: number;
    remoteOnly: boolean;
    skipApplied: boolean;
    skipFraudFlagged: boolean;
    /** Bypass all content filters (keywords/type/arrangement/remote/exp) and apply to every job. Safety skips (fraud, already-applied, closed) still apply. */
    applyAll: boolean;
  };
  limits: {
    maxAppliesPerRun: number;
    maxAppliesPerDay: number;
    minDelaySeconds: number;
    maxDelaySeconds: number;
  };
  answers: Record<string, string | string[] | number | boolean>;
  intro: {
    /** Send the intro message after each successful apply (mirrors the app). */
    enabled: boolean;
    /** If set, used verbatim. Otherwise the user's saved intro from the API is used. */
    message?: string;
  };
  cron: {
    schedule: string;
    timezone: string;
  };
  auto: {
    /** When the per-run cap hits, sleep this many minutes before next run. */
    cooldownMinutes: number;
    /** When NO jobs were applied (feed exhausted), sleep this many minutes. */
    idleMinutes: number;
    /** Re-derive keywords from profile every N runs (0 = disable). */
    refreshKeywordsEvery: number;
    /** If true, replace `filters.includeKeywords` with auto-derived ones at start of each run. */
    autoKeywords: boolean;
    /** Maximum consecutive errors before the loop exits. */
    maxConsecutiveErrors: number;
  };
}

const DEFAULT: Config = {
  feed: {
    pageName: "for_you",
    pageSize: 10,
    maxPages: 20,
    sources: [
      { type: "recommend", pageName: "for_you", maxPages: 20 },
      { type: "recommend", pageName: "for_you", recentlyAdded: true, maxPages: 10 },
      { type: "nearby", maxPages: 10 },
    ],
  },
  filters: {
    includeKeywords: [],
    excludeKeywords: [],
    jobTypes: [],
    workArrangements: [],
    minYearsOfExperienceMax: 99,
    remoteOnly: false,
    skipApplied: true,
    skipFraudFlagged: true,
    applyAll: false,
  },
  limits: {
    maxAppliesPerRun: 20,
    maxAppliesPerDay: 50,
    minDelaySeconds: 4,
    maxDelaySeconds: 12,
  },
  answers: {
    years_of_relevant_experience_v2: "More than 5 years",
    skill_set_tools: "Expert",
    skill_set_foreign_language_v2: ["Bahasa Indonesia", "English"],
  },
  intro: { enabled: true },
  cron: { schedule: "0 */2 * * *", timezone: "Asia/Jakarta" },
  auto: {
    cooldownMinutes: 30,
    idleMinutes: 20,
    refreshKeywordsEvery: 5,
    autoKeywords: true,
    maxConsecutiveErrors: 5,
  },
};

export function loadConfig(path = "config.json"): Config {
  const full = resolve(process.cwd(), path);
  let user: Partial<Config> = {};
  try {
    user = JSON.parse(readFileSync(full, "utf8")) as Partial<Config>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return {
    feed: { ...DEFAULT.feed, ...(user.feed ?? {}) },
    filters: { ...DEFAULT.filters, ...(user.filters ?? {}) },
    limits: { ...DEFAULT.limits, ...(user.limits ?? {}) },
    answers: { ...DEFAULT.answers, ...(user.answers ?? {}) },
    intro: { ...DEFAULT.intro, ...(user.intro ?? {}) },
    cron: { ...DEFAULT.cron, ...(user.cron ?? {}) },
    auto: { ...DEFAULT.auto, ...(user.auto ?? {}) },
  };
}

export function envCreds() {
  const username = process.env.GLINTS_USERNAME;
  const password = process.env.GLINTS_PASSWORD;
  // Empty when unset — makeClient resolves env > persisted session > generated.
  const deviceId = process.env.GLINTS_DEVICE_ID || "";
  if (!username || !password) {
    throw new Error("Missing GLINTS_USERNAME or GLINTS_PASSWORD env vars (copy .env.example to .env).");
  }
  return {
    username,
    password,
    deviceId,
    countryCode: process.env.GLINTS_COUNTRY || "ID",
    language: process.env.GLINTS_LANG || "id",
    appVersion: process.env.GLINTS_APP_VERSION || "1.106.2",
    osVersion: process.env.GLINTS_OS_VERSION || "9",
  };
}
