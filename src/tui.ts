// Live terminal dashboard for an Engine run.
//
// Anti-flicker strategy:
//   1. Use the alternate screen buffer so scrollback isn't disturbed.
//   2. Diff render: build the frame as an array of lines, compare with the
//      previous frame, and only re-emit lines that actually changed (each
//      with a CR + clear-to-end-of-line, no full-screen clear).
//   3. Only request a render when something interesting happens; a low-rate
//      timer drives the spinner ticks.

import chalk from "chalk";
import Table from "cli-table3";
import figlet from "figlet";
import gradient from "gradient-string";
import type { Engine, EngineEvent, RunSummary } from "./engine.js";
import type { MeFragment, RecommendedJob } from "./types.js";

// Brand gradient — cyan→magenta, matches Glints' neon vibe.
const brand = gradient(["#00e0ff", "#7b5cff", "#ff4db1"]);
const fire = gradient(["#ffd200", "#ff7b00", "#ff2d55"]);
const cool = gradient(["#00ffa3", "#00e0ff"]);

interface Row {
  job: RecommendedJob;
  state: "scanning" | "skipped" | "applying" | "applied" | "failed";
  reason?: string;
  applicationId?: string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const visualLength = (s: string): number => s.replace(ANSI_REGEX, "").length;

export class Dashboard {
  private rows: Row[] = [];
  private logs: string[] = [];
  private me: MeFragment | null = null;
  private currentPage = 0;
  private spinnerFrame = 0;
  private timer: NodeJS.Timeout | null = null;
  private finalSummary: RunSummary | null = null;
  private startedAt = Date.now();
  private status: "idle" | "running" | "finished" = "idle";
  private limitNotice: string | null = null;
  private dryRun: boolean;
  private maxRows = 12;
  private maxLogs = 6;

  private prevFrame: string[] = [];
  private dirty = true;
  private inAltScreen = false;
  private resizeHandler: (() => void) | null = null;
  private bannerLines: string[] = [];

  constructor(opts: { dryRun?: boolean } = {}) {
    this.dryRun = opts.dryRun ?? false;
    this.buildBanner();
  }

  // Render the ASCII-art logo once (figlet is sync) and pre-apply the brand
  // gradient per line so each frame just reuses the cached strings.
  private buildBanner(): void {
    let art: string;
    try {
      art = figlet.textSync("GLINTS", { font: "ANSI Shadow" });
    } catch {
      art = figlet.textSync("GLINTS"); // fallback to default font
    }
    const rows = art.replace(/\n+$/, "").split("\n");
    this.bannerLines = rows.map((l) => brand(l));
  }

  attach(engine: Engine): void {
    engine.on("event", (e: EngineEvent) => this.handle(e));
    this.start();
  }

  start(): void {
    this.status = "running";
    this.startedAt = Date.now();
    // Enter alternate screen, hide cursor, move home.
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[H");
    this.inAltScreen = true;
    this.prevFrame = [];

    this.resizeHandler = () => {
      // Wipe so the next render repaints everything fresh.
      this.prevFrame = [];
      this.dirty = true;
      process.stdout.write("\x1b[2J\x1b[H");
    };
    process.stdout.on("resize", this.resizeHandler);

    // Slow tick — only animates the spinner. Event-driven changes also flip
    // `dirty`, so the visible refresh rate is effectively whatever happens.
    this.timer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.render();
    }, 200);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.resizeHandler) process.stdout.off("resize", this.resizeHandler);
    this.resizeHandler = null;

    // One last render, then leave alt-screen and print a static summary.
    this.dirty = true;
    this.render();
    // If the run terminated almost instantly (e.g. day-cap hit), the user has
    // no chance to read the dashboard. Hold for a beat unless intentionally
    // skipped via FAST_TUI=1.
    if (!process.env.FAST_TUI) {
      const elapsed = Date.now() - this.startedAt;
      if (elapsed < 1500) {
        const wait = 1500 - elapsed;
        const until = Date.now() + wait;
        // Busy-spin via Atomics.wait on a SharedArrayBuffer would be cleaner,
        // but a synchronous-ish poll keeps deps simple.
        while (Date.now() < until) {
          // do nothing — we're inside stop(), can't await
        }
      }
    }
    if (this.inAltScreen) {
      // Restore cursor + leave alternate screen.
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      this.inAltScreen = false;
    }
    if (this.finalSummary) {
      process.stdout.write(this.renderSummary(this.finalSummary) + "\n");
    }
  }

  private handle(e: EngineEvent): void {
    switch (e.type) {
      case "started":
        this.pushLog("info", `Run started — ${e.runId}${this.dryRun ? " [dry-run]" : ""}`);
        break;
      case "me":
        this.me = e.me;
        this.pushLog("info", `Logged in as ${e.me.firstName} ${e.me.lastName} (${e.me.applicationsCount} previous applications)`);
        break;
      case "page":
        this.currentPage = e.page;
        this.pushLog("info", `[${e.sourceLabel}] page ${e.page} → ${e.got} jobs`);
        break;
      case "candidate":
        this.upsertRow(e.job, { state: "scanning" });
        break;
      case "skipped":
        this.upsertRow(e.job, { state: "skipped", reason: e.reason });
        break;
      case "applying":
        this.upsertRow(e.job, { state: "applying" });
        break;
      case "applied":
        this.upsertRow(e.job, { state: "applied", applicationId: e.applicationId });
        this.pushLog("info", `✓ Applied to ${e.job.title} @ ${e.job.Company?.displayName ?? "?"}`);
        break;
      case "apply-failed":
        this.upsertRow(e.job, { state: "failed", reason: e.error });
        this.pushLog("error", `✗ ${e.job.title}: ${e.error}`);
        break;
      case "intro-sent":
        this.introsSent++;
        this.pushLog("info", `✉ intro sent → ${e.job.title} (channel ${e.channelId.slice(0, 8)})`);
        break;
      case "intro-failed":
        this.pushLog("warn", `intro failed for ${e.job.title}: ${e.error}`);
        break;
      case "limit-reached":
        this.limitNotice = `${e.scope}-cap reached at ${e.count}`;
        this.pushLog("warn", `Limit reached (${e.scope}=${e.count})`);
        break;
      case "log":
        this.pushLog(e.level, e.message);
        break;
      case "finished":
        this.finalSummary = e.summary;
        this.status = "finished";
        this.pushLog("info", `Run finished — applied ${e.summary.applied}/${e.summary.scanned}`);
        break;
    }
    this.dirty = true;
  }

  private upsertRow(job: RecommendedJob, patch: Partial<Row>): void {
    const idx = this.rows.findIndex((r) => r.job.id === job.id);
    if (idx >= 0) {
      this.rows[idx] = { ...this.rows[idx]!, ...patch, job };
    } else {
      this.rows.unshift({ job, state: patch.state ?? "scanning", reason: patch.reason, applicationId: patch.applicationId });
    }
    if (this.rows.length > this.maxRows) this.rows.length = this.maxRows;
  }

  private pushLog(level: "info" | "warn" | "error", message: string): void {
    const ts = new Date().toLocaleTimeString();
    const tagColor = level === "error" ? chalk.red : level === "warn" ? chalk.yellow : chalk.gray;
    this.logs.unshift(`${chalk.dim(ts)} ${tagColor(level.toUpperCase().padEnd(5))} ${message}`);
    if (this.logs.length > this.maxLogs) this.logs.length = this.maxLogs;
  }

  // -------- diff rendering --------

  private buildFrame(): string[] {
    const lines: string[] = [];
    // ASCII-art banner (cached, gradient pre-applied)
    lines.push(...this.bannerLines);
    // Header
    lines.push(...this.renderHeader());
    lines.push("");
    // Job table
    const table = this.renderTable();
    for (const l of table.split("\n")) lines.push(l);
    lines.push("");
    // Logs
    lines.push(cool("▍ Logs"));
    if (!this.logs.length) {
      lines.push(chalk.dim("  (no events yet)"));
    } else {
      for (const l of this.logs) lines.push(l);
    }
    return lines;
  }

  // Unicode block progress bar for applied/scanned.
  private progressBar(done: number, total: number, width = 24): string {
    const ratio = total > 0 ? Math.min(1, done / total) : 0;
    const filled = Math.round(ratio * width);
    const bar = cool("█".repeat(filled)) + chalk.dim("░".repeat(width - filled));
    return `${bar} ${chalk.bold(`${Math.round(ratio * 100)}%`)}`;
  }

  private render(): void {
    if (!this.dirty && this.status !== "running") return;

    const frame = this.buildFrame();
    const cols = process.stdout.columns ?? 120;
    const out: string[] = [];

    const max = Math.max(frame.length, this.prevFrame.length);
    for (let i = 0; i < max; i++) {
      const next = frame[i] ?? "";
      const prev = this.prevFrame[i];
      if (next === prev) continue;
      // Move to row i+1, col 1, clear to end of line, write new content.
      // If the new line is shorter than the column count, the clear-to-EOL
      // handles erasing residue; if longer, terminal wraps.
      const trimmed = visualLength(next) > cols ? truncateAnsi(next, cols) : next;
      out.push(`\x1b[${i + 1};1H\x1b[2K${trimmed}`);
    }
    // If new frame is shorter than previous, clear the leftover lines.
    if (frame.length < this.prevFrame.length) {
      for (let i = frame.length; i < this.prevFrame.length; i++) {
        out.push(`\x1b[${i + 1};1H\x1b[2K`);
      }
    }

    if (out.length) {
      // Park the cursor at the bottom-left so it never lands mid-table.
      out.push(`\x1b[${frame.length + 1};1H`);
      process.stdout.write(out.join(""));
    }
    this.prevFrame = frame;
    this.dirty = false;
  }

  // -------- header / table / summary --------

  private renderHeader(): string[] {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
    const s = (elapsed % 60).toString().padStart(2, "0");
    const sp = this.status === "running" ? chalk.cyan(SPINNER[this.spinnerFrame]) :
               this.status === "finished" ? chalk.green("✓") : chalk.gray("○");
    const dry = this.dryRun ? chalk.yellow(" DRY-RUN") : "";
    const who = this.me ? `${this.me.firstName} ${this.me.lastName}` : "...";

    const stats = this.finalSummary ?? this.liveStats();
    const subtitle = brand("⟢ Auto-Apply Engine") + dry;
    const right = chalk.dim(`⏱ ${m}:${s}`);
    const top = `${sp}  ${subtitle}  ${chalk.dim("·")}  ${chalk.bold.white(who)}  ${chalk.dim("·")}  ${right}`;
    const counts =
      chalk.dim(`page ${this.currentPage}   `) +
      chalk.green(`● applied ${chalk.bold(stats.applied)}`) + "   " +
      chalk.cyan(`✉ intros ${chalk.bold(stats.introsSent)}`) + "   " +
      chalk.yellow(`▲ skipped ${chalk.bold(stats.skipped)}`) + "   " +
      chalk.red(`✗ failed ${chalk.bold(stats.failed)}`) + "   " +
      chalk.dim(`scanned ${stats.scanned}`);
    const progress = chalk.dim("apply ") + this.progressBar(stats.applied, stats.scanned || 1);
    return [top, counts, progress];
  }

  private introsSent = 0;

  private liveStats(): RunSummary {
    const applied = this.rows.filter((r) => r.state === "applied").length;
    const skipped = this.rows.filter((r) => r.state === "skipped").length;
    const failed = this.rows.filter((r) => r.state === "failed").length;
    return {
      runId: "", startedAt: "", finishedAt: "",
      scanned: this.rows.length, applied, skipped, failed,
      introsSent: this.introsSent, reasons: {},
    };
  }

  private renderTable(): string {
    const t = new Table({
      head: [cool("◆ State"), cool("Job"), cool("Company"), cool("Type"), cool("Note")],
      colWidths: [11, 34, 20, 15, 24],
      wordWrap: false,
      style: { head: [], border: ["cyan"] },
      chars: {
        top: "─", "top-mid": "┬", "top-left": "╭", "top-right": "╮",
        bottom: "─", "bottom-mid": "┴", "bottom-left": "╰", "bottom-right": "╯",
        left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼", right: "│", "right-mid": "┤",
        middle: "│",
      },
    });
    if (!this.rows.length) {
      t.push([chalk.dim("—"), chalk.dim("waiting for jobs…"), "", "", ""]);
    }
    for (const row of this.rows) {
      const titleColor = row.state === "applied" ? chalk.white.bold
        : row.state === "failed" ? chalk.red
        : row.state === "skipped" ? chalk.dim
        : chalk.white;
      t.push([
        this.stateBadge(row.state),
        titleColor(truncate(row.job.title, 32)),
        chalk.cyan(truncate(row.job.Company?.displayName ?? row.job.Company?.name ?? "—", 18)),
        this.typeBadge(row.job.type),
        this.noteCell(row),
      ]);
    }
    return t.toString();
  }

  // Job type → colored glyph + short label (width-1 glyphs keep table aligned).
  private typeBadge(type?: string): string {
    switch ((type ?? "").toUpperCase()) {
      case "FULL_TIME":     return chalk.green("● Full-time");
      case "PART_TIME":     return chalk.cyan("◐ Part-time");
      case "CONTRACT":      return chalk.yellow("▣ Contract");
      case "INTERNSHIP":    return chalk.blue("✎ Intern");
      case "PROJECT_BASED": return chalk.magenta("◈ Project");
      case "FREELANCE":     return chalk.white("✦ Freelance");
      case "TEMPORARY":     return chalk.gray("⧗ Temp");
      case "DAILY":         return chalk.gray("☀ Daily");
      default:              return chalk.dim(type ? `• ${titleCase(type)}` : "—");
    }
  }

  // Humanize the Note column — drop raw UUIDs, map reasons to icon + text.
  private noteCell(row: Row): string {
    if (row.state === "applied") return chalk.green("✓ submitted");
    if (row.state === "applying") return chalk.blue("… sending");
    if (row.state === "scanning") return chalk.dim("scanning…");
    const r = row.reason ?? "";
    if (r.startsWith("fraud")) return chalk.red("⚠ fraud-flagged");
    if (r.startsWith("already-in-history")) return chalk.gray("↻ already applied");
    if (r.startsWith("already-applied")) return chalk.gray("↻ already applied");
    if (r.startsWith("no-include-keyword")) return chalk.yellow("✗ off-keyword");
    if (r.startsWith("excluded")) return chalk.yellow(`✗ ${r.replace("excluded:", "excl ")}`);
    if (r.startsWith("type=")) return chalk.yellow(`✗ type ${r.slice(5)}`);
    if (r.startsWith("arrangement=")) return chalk.yellow(`✗ ${r.slice(12)}`);
    if (r.startsWith("status=")) return chalk.yellow(`✗ ${r.slice(7).toLowerCase()}`);
    if (r.startsWith("not-remote")) return chalk.yellow("✗ on-site");
    if (r.startsWith("min-exp")) return chalk.yellow(`✗ exp ${r.replace("min-exp=", "")}y`);
    if (r.startsWith("missing-answers")) return chalk.yellow("✎ needs info");
    if (r.startsWith("questions-failed")) return chalk.red("✗ form error");
    if (row.state === "failed") return chalk.red(`✗ ${truncate(r, 30)}`);
    return chalk.dim(truncate(r, 32));
  }

  private stateBadge(state: Row["state"]): string {
    switch (state) {
      case "scanning": return chalk.bgCyan.black.bold(" SCAN ");
      case "applying": return chalk.bgBlue.white.bold(`${SPINNER[this.spinnerFrame]} APPLY`);
      case "applied":  return chalk.bgGreen.black.bold(" ✓ DONE");
      case "skipped":  return chalk.bgYellow.black.bold(" SKIP ");
      case "failed":   return chalk.bgRed.white.bold(" ✗ FAIL");
    }
  }

  private renderSummary(s: RunSummary): string {
    const lines: string[] = [];
    lines.push(fire("═══ RUN SUMMARY ═══"));
    lines.push(`  scanned ${chalk.bold(s.scanned)}   ${chalk.green(`● applied ${chalk.bold(s.applied)}`)}   ${chalk.cyan(`✉ intros ${chalk.bold(s.introsSent)}`)}   ${chalk.yellow(`▲ skipped ${chalk.bold(s.skipped)}`)}   ${chalk.red(`✗ failed ${chalk.bold(s.failed)}`)}`);
    if (this.limitNotice) {
      lines.push(chalk.bgYellow.black(` ${this.limitNotice} `));
    }
    if (s.scanned === 0 && s.applied === 0) {
      lines.push(chalk.yellow(
        "  No jobs scanned. Likely causes: daily cap reached (try `glints reset-day`), no resume on profile, or login failed."
      ));
    }
    const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]);
    if (reasons.length) {
      lines.push(chalk.dim("  reasons: ") + reasons.map(([k, v]) => `${k}=${v}`).join(", "));
    }
    return lines.join("\n");
  }
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Truncate an ANSI-styled string to a visual column count without breaking
// escape sequences.
function truncateAnsi(s: string, max: number): string {
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i);
      if (end >= 0) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    if (visible >= max) break;
    out += ch;
    visible++;
    i++;
  }
  return out;
}
