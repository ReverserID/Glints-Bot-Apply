import cron from "node-cron";
import chalk from "chalk";
import { Engine } from "./engine.js";
import { GlintsClient } from "./client.js";
import type { Config } from "./config.js";
import { History } from "./storage.js";

export interface SchedulerOptions {
  config: Config;
  client: GlintsClient;
  dryRun?: boolean;
  onTick?: (e: Engine) => void;
}

export function startCron(opts: SchedulerOptions): { stop: () => void } {
  const { schedule, timezone } = opts.config.cron;
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }
  const history = new History();
  let running = false;

  console.log(chalk.cyan(`⟢ Cron scheduled: ${chalk.bold(schedule)} (${timezone})`));
  console.log(chalk.dim("Press Ctrl+C to stop.\n"));

  const task = cron.schedule(
    schedule,
    async () => {
      if (running) {
        console.log(chalk.yellow(`[${new Date().toISOString()}] Previous run still in progress — skipping tick.`));
        return;
      }
      running = true;
      const t0 = Date.now();
      console.log(chalk.cyan(`\n[${new Date().toISOString()}] Tick — starting auto-apply run`));
      const engine = new Engine({ client: opts.client, config: opts.config, dryRun: opts.dryRun, history });
      let applied = 0, scanned = 0;
      engine.on("event", (e) => {
        if (e.type === "applied") {
          console.log(chalk.green(`  ✓ Applied: ${e.job.title} @ ${e.job.Company?.displayName ?? "?"}`));
        } else if (e.type === "apply-failed") {
          console.log(chalk.red(`  ✗ Failed: ${e.job.title} — ${e.error}`));
        } else if (e.type === "finished") {
          applied = e.summary.applied;
          scanned = e.summary.scanned;
        }
      });
      opts.onTick?.(engine);
      try {
        await engine.run();
      } catch (e) {
        console.log(chalk.red(`Run errored: ${(e as Error).message}`));
      } finally {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(chalk.cyan(`[${new Date().toISOString()}] Tick done — applied ${applied}/${scanned} in ${dt}s\n`));
        running = false;
      }
    },
    { timezone }
  );

  task.start();
  return { stop: () => task.stop() };
}
