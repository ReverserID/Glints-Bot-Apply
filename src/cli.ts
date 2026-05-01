#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { GlintsClient } from "./client.js";
import { envCreds, loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { History, SessionStore } from "./storage.js";
import { Dashboard } from "./tui.js";
import { startCron } from "./scheduler.js";

const program = new Command();

program
  .name("glints")
  .description("Glints auto-apply CLI — TUI + cron scheduling.")
  .option("-c, --config <path>", "path to config.json", "config.json");

function makeClient(): GlintsClient {
  const env = envCreds();
  const session = new SessionStore().load();
  const c = new GlintsClient(env);
  if (session.accessToken) c.importSession({ accessToken: session.accessToken, refreshToken: session.refreshToken ?? null });
  return c;
}

function persistSession(c: GlintsClient): void {
  new SessionStore().save(c.exportSession());
}

// ---------- me ----------
program
  .command("me")
  .description("Show the current candidate profile.")
  .action(async () => {
    const c = makeClient();
    const s = ora("Fetching profile…").start();
    try {
      const me = await c.getMe();
      persistSession(c);
      s.succeed(`Logged in as ${chalk.bold(me.firstName + " " + me.lastName)} <${me.email}>`);
      const t = new Table({ head: [chalk.bold("Field"), chalk.bold("Value")] });
      t.push(
        ["id", me.id],
        ["role", me.role],
        ["country", me.CountryCode],
        ["resume", me.resume ?? chalk.red("missing")],
        ["applications", String(me.applicationsCount)],
        ["completion", `${me.profileCompletionPercentage}%`],
        ["location", me.hierarchicalLocation?.formattedName ?? "—"],
      );
      console.log(t.toString());
    } catch (e) {
      s.fail((e as Error).message);
      process.exitCode = 1;
    }
  });

// ---------- feed ----------
program
  .command("feed")
  .description("List the For-You job feed.")
  .option("-p, --page <n>", "page", "1")
  .option("-s, --size <n>", "page size", "10")
  .action(async (opts) => {
    const c = makeClient();
    const s = ora("Fetching feed…").start();
    try {
      const res = await c.getRecommendedJobs({ page: Number(opts.page), pageSize: Number(opts.size) });
      persistSession(c);
      s.succeed(`Got ${res.data.length} jobs`);
      const t = new Table({
        head: [chalk.bold("Title"), chalk.bold("Company"), chalk.bold("Type"), chalk.bold("Loc"), chalk.bold("ID")],
        colWidths: [38, 22, 12, 24, 38],
        wordWrap: true,
      });
      for (const j of res.data) {
        t.push([
          j.title,
          j.Company?.displayName ?? "—",
          j.type,
          j.hierarchicalLocation?.formattedName ?? "—",
          chalk.dim(j.id),
        ]);
      }
      console.log(t.toString());
    } catch (e) {
      s.fail((e as Error).message);
      process.exitCode = 1;
    }
  });

// ---------- apply ----------
program
  .command("apply")
  .description("Run a single auto-apply pass with the live TUI dashboard.")
  .option("--dry-run", "do everything except submit applications", false)
  .option("--no-tui", "plain console output instead of TUI")
  .action(async (opts) => {
    const cfg = loadConfig(program.opts().config as string);
    const c = makeClient();
    const ctrl = new AbortController();
    const onSig = () => { ctrl.abort(); };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    const engine = new Engine({ client: c, config: cfg, dryRun: !!opts.dryRun, signal: ctrl.signal });

    if (opts.tui === false) {
      engine.on("event", (e) => {
        if (e.type === "applied") console.log(chalk.green(`✓ ${e.job.title} @ ${e.job.Company?.displayName ?? "?"}`));
        else if (e.type === "apply-failed") console.log(chalk.red(`✗ ${e.job.title} — ${e.error}`));
        else if (e.type === "skipped") console.log(chalk.dim(`- ${e.job.title}: ${e.reason}`));
        else if (e.type === "log") console.log(`${e.level}: ${e.message}`);
        else if (e.type === "finished") console.log(chalk.cyan(`done — applied ${e.summary.applied}/${e.summary.scanned}`));
      });
      try { await engine.run(); } finally { persistSession(c); }
      return;
    }

    const dash = new Dashboard({ dryRun: !!opts.dryRun });
    dash.attach(engine);
    try {
      await engine.run();
    } finally {
      dash.stop();
      persistSession(c);
    }
  });

// ---------- dashboard (alias) ----------
program
  .command("dashboard")
  .description("Run auto-apply with the live TUI dashboard (alias of `apply`).")
  .option("--dry-run", "do everything except submit applications", false)
  .action(async (opts) => {
    await program.parseAsync(["apply", ...(opts.dryRun ? ["--dry-run"] : [])], { from: "user" });
  });

// ---------- cron ----------
program
  .command("cron")
  .description("Start a long-running scheduler that triggers auto-apply on a cron expression.")
  .option("--dry-run", "do everything except submit applications", false)
  .option("--once", "run a single tick now and exit", false)
  .action(async (opts) => {
    const cfg = loadConfig(program.opts().config as string);
    const c = makeClient();
    if (opts.once) {
      const engine = new Engine({ client: c, config: cfg, dryRun: !!opts.dryRun });
      const dash = new Dashboard({ dryRun: !!opts.dryRun });
      dash.attach(engine);
      try { await engine.run(); } finally { dash.stop(); persistSession(c); }
      return;
    }
    const handle = startCron({ config: cfg, client: c, dryRun: !!opts.dryRun });
    process.on("SIGINT", () => { handle.stop(); persistSession(c); process.exit(0); });
    // keep process alive
    await new Promise<void>(() => undefined);
  });

// ---------- history ----------
program
  .command("history")
  .description("Show recent auto-applied jobs.")
  .option("-n, --limit <n>", "how many to show", "20")
  .action((opts) => {
    const cfg = loadConfig(program.opts().config as string);
    const h = new History();
    const all = h.all().slice(0, Number(opts.limit));
    if (!all.length) {
      console.log(chalk.dim("No applications recorded yet."));
      return;
    }
    const t = new Table({
      head: [chalk.bold("Applied At"), chalk.bold("Title"), chalk.bold("Company"), chalk.bold("Status"), chalk.bold("App ID")],
      colWidths: [22, 36, 24, 12, 38],
      wordWrap: true,
    });
    for (const r of all) {
      t.push([r.appliedAt, r.title, r.company, r.status ?? "—", chalk.dim(r.applicationId ?? "—")]);
    }
    console.log(t.toString());
    const today = h.appliedToday(cfg.cron.timezone);
    const cap = cfg.limits.maxAppliesPerDay;
    const remaining = Math.max(0, cap - today);
    console.log(chalk.dim(
      `Total: ${h.all().length}    Today (${cfg.cron.timezone}): ${today}/${cap}    Remaining: ${remaining}`
    ));
  });

// ---------- reset-day ----------
program
  .command("reset-day")
  .description("Clear today's apply history so the daily cap resets.")
  .action(() => {
    const cfg = loadConfig(program.opts().config as string);
    const h = new History();
    const before = h.appliedToday(cfg.cron.timezone);
    const removed = h.clearDay(cfg.cron.timezone);
    console.log(chalk.green(
      `Cleared ${removed} entries for today (${cfg.cron.timezone}). Was ${before}, now ${h.appliedToday(cfg.cron.timezone)}.`
    ));
  });

// ---------- config ----------
program
  .command("config")
  .description("Print the resolved config.")
  .action(() => {
    const cfg = loadConfig(program.opts().config as string);
    console.log(JSON.stringify(cfg, null, 2));
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(chalk.red(`error: ${(e as Error).message}`));
  process.exit(1);
});
