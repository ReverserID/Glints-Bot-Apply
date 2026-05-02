// 24/7 auto loop. Runs the engine in a never-ending cycle, waiting until
// next local midnight when the daily cap hits, sleeping a cooldown when the
// per-run cap hits, and backing off on errors.

import chalk from "chalk";
import { GlintsClient } from "./client.js";
import { Engine, type EngineEvent, type RunSummary } from "./engine.js";
import { History } from "./storage.js";
import { Dashboard } from "./tui.js";
import { deriveKeywords } from "./auto-keywords.js";
import type { Config } from "./config.js";

export interface AutoOptions {
  client: GlintsClient;
  config: Config;
  dryRun?: boolean;
  tui?: boolean;
  signal?: AbortSignal;
}

export class AutoLoop {
  private client: GlintsClient;
  private cfg: Config;
  private dryRun: boolean;
  private tui: boolean;
  private signal?: AbortSignal;
  private history = new History();

  private runs = 0;
  private consecutiveErrors = 0;
  private lastKeywordRefreshRun = -1;

  constructor(opts: AutoOptions) {
    this.client = opts.client;
    this.cfg = { ...opts.config };
    this.dryRun = opts.dryRun ?? false;
    this.tui = opts.tui ?? true;
    this.signal = opts.signal;
  }

  private async sleep(ms: number, label: string): Promise<void> {
    const until = new Date(Date.now() + ms);
    this.banner(chalk.dim(`sleeping ${formatDuration(ms)} → resume at ${until.toLocaleString()} (${label})`));

    return new Promise((res, rej) => {
      const t = setTimeout(res, ms);
      const onAbort = () => { clearTimeout(t); rej(new Error("aborted")); };
      if (this.signal?.aborted) { clearTimeout(t); rej(new Error("aborted")); return; }
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private banner(line: string): void {
    const ts = chalk.dim(`[${new Date().toISOString()}]`);
    console.log(`${ts} ${line}`);
  }

  /** Milliseconds until next midnight in the configured timezone. */
  private msUntilNextMidnight(): number {
    const tz = this.cfg.cron.timezone;
    const now = new Date();
    // Get current local time in the tz
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const localNow = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`);
    const localMidnight = new Date(localNow);
    localMidnight.setHours(24, 0, 30, 0); // 30 sec past midnight, just to be safe
    return localMidnight.getTime() - localNow.getTime();
  }

  private async refreshKeywordsIfNeeded(): Promise<void> {
    if (!this.cfg.auto.autoKeywords) return;

    const every = this.cfg.auto.refreshKeywordsEvery;
    const shouldRefresh =
      this.lastKeywordRefreshRun < 0 ||
      (every > 0 && this.runs - this.lastKeywordRefreshRun >= every);

    if (!shouldRefresh) return;

    try {
      const me = await this.client.getMe();
      const derived = await deriveKeywords(this.client, me);
      if (derived.filtered.length) {
        this.cfg = {
          ...this.cfg,
          filters: { ...this.cfg.filters, includeKeywords: derived.filtered },
        };
        this.banner(chalk.cyan(
          `auto-keywords refreshed (${derived.filtered.length} terms): ${derived.filtered.slice(0, 12).join(", ")}${derived.filtered.length > 12 ? "…" : ""}`
        ));
      } else {
        this.banner(chalk.yellow("auto-keywords: derived list was empty, keeping current filters"));
      }
    } catch (e) {
      this.banner(chalk.yellow(`auto-keywords: failed to refresh: ${(e as Error).message}`));
    }
    this.lastKeywordRefreshRun = this.runs;
  }

  private decideNextWait(summary: RunSummary, hitDayCap: boolean, hitRunCap: boolean): { ms: number; label: string } {
    if (hitDayCap) {
      const ms = Math.max(this.msUntilNextMidnight(), 60_000);
      return { ms, label: `daily cap reached, waiting until next midnight (${this.cfg.cron.timezone})` };
    }
    if (hitRunCap) {
      return { ms: this.cfg.auto.cooldownMinutes * 60_000, label: `per-run cap, cooldown ${this.cfg.auto.cooldownMinutes}m` };
    }
    if (summary.applied === 0) {
      return { ms: this.cfg.auto.idleMinutes * 60_000, label: `feed exhausted / nothing matched, idle ${this.cfg.auto.idleMinutes}m` };
    }
    // Progressed normally — small breath before next run
    return { ms: 2 * 60_000, label: "post-run breath 2m" };
  }

  async run(): Promise<void> {
    this.banner(chalk.bold.cyan(`⟢ Auto loop starting (dryRun=${this.dryRun}, tui=${this.tui})`));

    while (!this.signal?.aborted) {
      this.runs++;
      this.banner(chalk.bold(`──── Run #${this.runs} ────`));

      try {
        await this.refreshKeywordsIfNeeded();

        const engine = new Engine({
          client: this.client,
          config: this.cfg,
          dryRun: this.dryRun,
          history: this.history,
          signal: this.signal,
        });

        let hitDayCap = false;
        let hitRunCap = false;
        engine.on("event", (raw: unknown) => {
          const e = raw as EngineEvent;
          if (e.type === "limit-reached") {
            if (e.scope === "day") hitDayCap = true;
            if (e.scope === "run") hitRunCap = true;
          }
        });

        let summary: RunSummary;
        if (this.tui) {
          const dash = new Dashboard({ dryRun: this.dryRun });
          dash.attach(engine);
          try { summary = await engine.run(); } finally { dash.stop(); }
        } else {
          engine.on("event", (raw: unknown) => {
            const e = raw as EngineEvent;
            if (e.type === "applied") this.banner(chalk.green(`✓ ${e.job.title} @ ${e.job.Company?.displayName ?? "?"}`));
            else if (e.type === "apply-failed") this.banner(chalk.red(`✗ ${e.job.title}: ${e.error}`));
            else if (e.type === "intro-sent") this.banner(chalk.cyan(`✉ intro sent → ${e.job.title}`));
            else if (e.type === "log" && e.level !== "info") this.banner(chalk.yellow(`${e.level}: ${e.message}`));
          });
          summary = await engine.run();
        }

        // Day-cap can also be detected from current count (some races miss the event).
        if (this.history.appliedToday(this.cfg.cron.timezone) >= this.cfg.limits.maxAppliesPerDay) {
          hitDayCap = true;
        }

        this.banner(chalk.bold(
          `Run #${this.runs} done — applied ${chalk.green(summary.applied)} / scanned ${summary.scanned} / skipped ${chalk.yellow(summary.skipped)} / failed ${chalk.red(summary.failed)} / intros ${chalk.cyan(summary.introsSent)}`
        ));

        this.consecutiveErrors = 0;
        const next = this.decideNextWait(summary, hitDayCap, hitRunCap);
        await this.sleep(next.ms, next.label);
      } catch (e) {
        if ((e as Error).message === "aborted") break;
        this.consecutiveErrors++;
        const backoff = Math.min(60, 2 ** this.consecutiveErrors) * 60_000; // 2,4,8,16,32,60 min
        this.banner(chalk.red(`run errored (${this.consecutiveErrors}/${this.cfg.auto.maxConsecutiveErrors}): ${(e as Error).message}`));
        if (this.consecutiveErrors >= this.cfg.auto.maxConsecutiveErrors) {
          this.banner(chalk.red(`max consecutive errors reached, exiting`));
          break;
        }
        try { await this.sleep(backoff, `backoff after error #${this.consecutiveErrors}`); }
        catch { break; }
      }
    }

    this.banner(chalk.dim(`auto loop stopped after ${this.runs} run(s)`));
  }
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${hr}h${rem}m` : `${hr}h`;
}
