// Auto-apply engine. Pulls jobs from one or more feed sources, runs them
// through filters, generates answers, submits applications with rate-limited
// delays, and writes to history. Emits events that the TUI listens to.

import { EventEmitter } from "node:events";
import { GlintsClient, GlintsApiError } from "./client.js";
import type { Config, FeedSource } from "./config.js";
import { decideJob } from "./filters.js";
import { buildAnswers, isBlocking } from "./answer-bank.js";
import { History } from "./storage.js";
import type { MeFragment, RecommendedJob } from "./types.js";

export type EngineEvent =
  | { type: "started"; runId: string; startedAt: string }
  | { type: "me"; me: MeFragment }
  | { type: "page"; page: number; got: number; sourceLabel: string }
  | { type: "candidate"; job: RecommendedJob }
  | { type: "skipped"; job: RecommendedJob; reason: string }
  | { type: "applying"; job: RecommendedJob }
  | { type: "applied"; job: RecommendedJob; applicationId?: string }
  | { type: "apply-failed"; job: RecommendedJob; error: string }
  | { type: "intro-sent"; job: RecommendedJob; channelId: string }
  | { type: "intro-failed"; job: RecommendedJob; error: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "limit-reached"; scope: "run" | "day"; count: number }
  | { type: "finished"; runId: string; summary: RunSummary };

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  scanned: number;
  applied: number;
  skipped: number;
  failed: number;
  introsSent: number;
  reasons: Record<string, number>;
}

export interface EngineOptions {
  client: GlintsClient;
  config: Config;
  dryRun?: boolean;
  history?: History;
  signal?: AbortSignal;
}

interface SourceState {
  src: FeedSource;
  label: string;
  page: number;
  exhausted: boolean;
  emptyStreak: number;
}

class StopRun extends Error {
  scope: "run" | "day" | "abort" | "done";
  constructor(scope: "run" | "day" | "abort" | "done") {
    super(scope);
    this.scope = scope;
  }
}

export class Engine extends EventEmitter {
  private client: GlintsClient;
  private cfg: Config;
  private dryRun: boolean;
  private history: History;
  private signal?: AbortSignal;

  constructor(opts: EngineOptions) {
    super();
    this.client = opts.client;
    this.cfg = opts.config;
    this.dryRun = opts.dryRun ?? false;
    this.history = opts.history ?? new History();
    this.signal = opts.signal;
  }

  onEvent(listener: (e: EngineEvent) => void): this {
    this.on("event", listener as (...args: unknown[]) => void);
    return this;
  }

  private emitEvent(e: EngineEvent): void { this.emit("event", e); }
  private log(level: "info" | "warn" | "error", message: string): void {
    this.emitEvent({ type: "log", level, message });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((res, rej) => {
      const t = setTimeout(res, ms);
      const onAbort = () => { clearTimeout(t); rej(new StopRun("abort")); };
      if (this.signal?.aborted) { clearTimeout(t); rej(new StopRun("abort")); return; }
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private rateDelayMs(): number {
    const { minDelaySeconds, maxDelaySeconds } = this.cfg.limits;
    const min = Math.max(0, minDelaySeconds);
    const max = Math.max(min, maxDelaySeconds);
    return Math.floor((min + Math.random() * (max - min)) * 1000);
  }

  private resolveSources(me: MeFragment): SourceState[] {
    const configured = this.cfg.feed.sources;
    const sources: FeedSource[] = configured && configured.length
      ? configured
      : [{ type: "recommend", pageName: this.cfg.feed.pageName, maxPages: this.cfg.feed.maxPages }];

    return sources.map((s, i) => {
      let label: string;
      if (s.type === "recommend") {
        label = `recommend:${s.pageName ?? "for_you"}${s.recentlyAdded ? " (new)" : ""}`;
      } else {
        const lat = s.latitude ?? me.preferredLocations?.[0]?.latitude;
        const lng = s.longitude ?? me.preferredLocations?.[0]?.longitude;
        label = `nearby:${lat ?? "?"},${lng ?? "?"}${s.jobCategoryId ? `[${s.jobCategoryId.slice(0, 6)}]` : ""}`;
      }
      return { src: s, label: `${i + 1}.${label}`, page: 1, exhausted: false, emptyStreak: 0 };
    });
  }

  private async fetchPage(state: SourceState, me: MeFragment): Promise<RecommendedJob[]> {
    const pageSize = state.src.pageSize ?? this.cfg.feed.pageSize;
    const page = state.page;

    if (state.src.type === "recommend") {
      const res = await this.client.getRecommendedJobs({
        page,
        pageSize,
        pageName: state.src.pageName ?? this.cfg.feed.pageName,
        recentlyAdded: state.src.recentlyAdded ?? false,
      });
      return res?.data ?? [];
    }
    // nearby
    const lat = state.src.latitude ?? me.preferredLocations?.[0]?.latitude;
    const lng = state.src.longitude ?? me.preferredLocations?.[0]?.longitude;
    if (lat == null || lng == null) {
      this.log("warn", `nearby source skipped: no coordinates (set preferredLocations or specify latitude/longitude)`);
      state.exhausted = true;
      return [];
    }
    const res = await this.client.getNearbyJobs({
      page, pageSize,
      latitude: lat, longitude: lng,
      jobCategoryId: state.src.jobCategoryId,
    });
    return res?.data ?? [];
  }

  async run(): Promise<RunSummary> {
    const runId = `run_${Date.now().toString(36)}`;
    const startedAt = new Date().toISOString();
    this.emitEvent({ type: "started", runId, startedAt });

    const summary: RunSummary = {
      runId, startedAt, finishedAt: "",
      scanned: 0, applied: 0, skipped: 0, failed: 0, introsSent: 0, reasons: {},
    };
    let introMessage: string | null = null;
    const bumpReason = (r: string) => { summary.reasons[r] = (summary.reasons[r] ?? 0) + 1; };

    let me: MeFragment;
    try {
      me = await this.client.getMe();
      this.emitEvent({ type: "me", me });
    } catch (e) {
      this.log("error", `Failed to fetch profile: ${(e as Error).message}`);
      summary.finishedAt = new Date().toISOString();
      this.emitEvent({ type: "finished", runId, summary });
      return summary;
    }

    if (!me.resume) {
      this.log("error", "No resume on profile — upload one in the app first.");
      summary.finishedAt = new Date().toISOString();
      this.emitEvent({ type: "finished", runId, summary });
      return summary;
    }

    // Resolve intro message once per run.
    if (this.cfg.intro.enabled) {
      if (this.cfg.intro.message && this.cfg.intro.message.trim()) {
        introMessage = this.cfg.intro.message.trim();
      } else {
        try {
          const saved = await this.client.getMessagingIntroMessage();
          if (saved?.message) introMessage = saved.message;
          else this.log("warn", "intro: no saved intro message on profile, will skip post-apply messages");
        } catch (e) {
          this.log("warn", `intro: failed to fetch saved intro: ${(e as Error).message}`);
        }
      }
    }

    const tz = this.cfg.cron.timezone;
    let dayApplied = this.history.appliedToday(tz);
    if (dayApplied >= this.cfg.limits.maxAppliesPerDay) {
      this.log("error",
        `Daily cap reached (${dayApplied}/${this.cfg.limits.maxAppliesPerDay} applies today, tz=${tz}). ` +
        `Run "glints reset-day" to clear today's history, or raise limits.maxAppliesPerDay in config.json.`
      );
      this.emitEvent({ type: "limit-reached", scope: "day", count: dayApplied });
      summary.reasons["day-cap-reached"] = 1;
      summary.finishedAt = new Date().toISOString();
      this.emitEvent({ type: "finished", runId, summary });
      return summary;
    }

    const sources = this.resolveSources(me);
    const seen = new Set<string>();

    try {
      // Round-robin across sources so we don't burn through one feed before
      // touching the others. A source is "exhausted" once it hits its
      // configured maxPages or returns two consecutive empty pages.
      while (sources.some((s) => !s.exhausted)) {
        if (this.signal?.aborted) throw new StopRun("abort");

        let progressedThisLap = false;

        for (const state of sources) {
          if (state.exhausted) continue;
          if (this.signal?.aborted) throw new StopRun("abort");

          const cap = state.src.maxPages ?? this.cfg.feed.maxPages;
          if (state.page > cap) { state.exhausted = true; continue; }

          let jobs: RecommendedJob[] = [];
          try {
            jobs = await this.fetchPage(state, me);
          } catch (e) {
            this.log("error", `${state.label} page ${state.page} failed: ${(e as Error).message}`);
            state.exhausted = true;
            continue;
          }
          this.emitEvent({ type: "page", page: state.page, got: jobs.length, sourceLabel: state.label });
          state.page++;

          if (!jobs.length) {
            state.emptyStreak++;
            if (state.emptyStreak >= 2) state.exhausted = true;
            continue;
          }
          state.emptyStreak = 0;
          progressedThisLap = true;

          for (const job of jobs) {
            if (this.signal?.aborted) throw new StopRun("abort");
            if (seen.has(job.id)) continue;
            seen.add(job.id);
            summary.scanned++;
            this.emitEvent({ type: "candidate", job });

            if (this.history.has(job.id)) {
              summary.skipped++; bumpReason("already-in-history");
              this.emitEvent({ type: "skipped", job, reason: "already-in-history" });
              continue;
            }

            const decision = decideJob(job, this.cfg.filters);
            if (!decision.ok) {
              summary.skipped++; bumpReason(decision.reason ?? "filtered");
              this.emitEvent({ type: "skipped", job, reason: decision.reason ?? "filtered" });
              continue;
            }

            if (summary.applied >= this.cfg.limits.maxAppliesPerRun) {
              this.emitEvent({ type: "limit-reached", scope: "run", count: summary.applied });
              throw new StopRun("run");
            }
            if (dayApplied >= this.cfg.limits.maxAppliesPerDay) {
              this.emitEvent({ type: "limit-reached", scope: "day", count: dayApplied });
              throw new StopRun("day");
            }

            // one-tap questions → answers
            let questions;
            try {
              const q = await this.client.getOneTapApplyQuestions(job.id);
              questions = q.getOneTapJobApplyQuestions.profileQuestions;
            } catch (e) {
              summary.skipped++; bumpReason("questions-failed");
              this.emitEvent({ type: "skipped", job, reason: `questions-failed:${(e as Error).message}` });
              continue;
            }
            const plan = buildAnswers(questions, this.cfg.answers);
            if (isBlocking(plan.missing)) {
              const missing = plan.missing.map((m) => m.name).join(",");
              summary.skipped++; bumpReason("missing-answers");
              this.emitEvent({ type: "skipped", job, reason: `missing-answers:${missing}` });
              continue;
            }

            this.emitEvent({ type: "applying", job });
            if (this.dryRun) {
              this.log("info", `[dry-run] would apply to ${job.title} @ ${job.Company?.displayName ?? "?"}`);
              summary.applied++; dayApplied++;
            } else {
              try {
                const result = await this.client.applyToJob(job.id, {
                  resume: me.resume!,
                  answers: plan.answers,
                  source: (job.source ?? "FOR_YOU").toUpperCase(),
                  traceInfo: job.traceInfo,
                });
                summary.applied++; dayApplied++;
                this.history.add({
                  jobId: job.id,
                  title: job.title,
                  company: job.Company?.displayName ?? job.Company?.name ?? "—",
                  appliedAt: new Date().toISOString(),
                  status: result.data?.status,
                  applicationId: result.data?.id,
                  source: result.data?.source ?? "ANDROID",
                  traceInfo: job.traceInfo,
                });
                this.emitEvent({ type: "applied", job, applicationId: result.data?.id });

                // Post-apply chat: open channel + send saved intro message.
                if (introMessage && result.data?.id) {
                  try {
                    const ch = await this.client.startChatChannel(result.data.id);
                    const channelId = ch?.data?.id;
                    if (channelId) {
                      await this.client.sendChatMessage({
                        channelId,
                        text: introMessage,
                        type: "INTRO_MESSAGE",
                      });
                      summary.introsSent++;
                      this.emitEvent({ type: "intro-sent", job, channelId });
                    }
                  } catch (e) {
                    const msg = e instanceof GlintsApiError
                      ? `HTTP ${e.status ?? "?"}: ${typeof e.body === "string" ? e.body : JSON.stringify(e.body)}`
                      : (e as Error).message;
                    this.emitEvent({ type: "intro-failed", job, error: msg });
                  }
                }
              } catch (e) {
                // The API returns 409 CONFLICT when the user has already
                // applied to this job (visible/invisible to local history).
                // Treat that as "already applied" — record it locally so we
                // never retry, and count it as a skip rather than a failure.
                const isAlreadyApplied =
                  e instanceof GlintsApiError && (
                    e.status === 409 ||
                    (typeof e.body === "object" && e.body !== null &&
                      (((e.body as { error?: { code?: string } }).error?.code === "CONFLICT") ||
                       JSON.stringify(e.body).toLowerCase().includes("previously applied")))
                  );

                if (isAlreadyApplied) {
                  this.history.add({
                    jobId: job.id,
                    title: job.title,
                    company: job.Company?.displayName ?? job.Company?.name ?? "—",
                    appliedAt: new Date().toISOString(),
                    status: "ALREADY_APPLIED",
                    applicationId:
                      (e as GlintsApiError).body && typeof (e as GlintsApiError).body === "object"
                        ? ((e as GlintsApiError).body as { data?: { applicationId?: string } }).data?.applicationId
                        : undefined,
                    source: "ANDROID",
                    traceInfo: job.traceInfo,
                  });
                  summary.skipped++; bumpReason("already-applied-server");
                  this.emitEvent({ type: "skipped", job, reason: "already-applied-server (409)" });
                } else {
                  const msg = e instanceof GlintsApiError
                    ? `HTTP ${e.status ?? "?"}: ${typeof e.body === "string" ? e.body : JSON.stringify(e.body)}`
                    : (e as Error).message;
                  summary.failed++; bumpReason("apply-failed");
                  this.emitEvent({ type: "apply-failed", job, error: msg });
                }
              }
            }

            try { await this.sleep(this.rateDelayMs()); } catch { throw new StopRun("abort"); }
          }
        }

        if (!progressedThisLap) break; // every active source returned empty/aborted this lap
      }
    } catch (e) {
      if (!(e instanceof StopRun)) {
        this.log("error", `run errored: ${(e as Error).message}`);
      }
      // StopRun(run|day|abort) is a normal early termination — fall through.
    }

    summary.finishedAt = new Date().toISOString();
    this.emitEvent({ type: "finished", runId, summary });
    return summary;
  }
}
