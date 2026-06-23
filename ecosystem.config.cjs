// PM2 process config — run the 24/7 auto-apply loop headless (no TUI).
//
//   pm2 start ecosystem.config.cjs
//   pm2 logs glints-auto
//   pm2 restart glints-auto
//   pm2 stop glints-auto
//   pm2 save && pm2 startup   # survive reboots
//
// Uses tsx so no build step is needed. Logs land in ./logs.

module.exports = {
  apps: [
    {
      name: "glints-auto",
      // Run tsx directly (its bin is an ESM cli). args carry the CLI command.
      script: "./node_modules/tsx/dist/cli.mjs",
      args: "src/cli.ts auto --no-tui",
      cwd: __dirname,

      // 24/7 resilience
      autorestart: true,
      restart_delay: 10000,        // wait 10s before respawning after a crash
      max_restarts: 50,            // within min_uptime window
      min_uptime: 60000,           // must stay up 60s to count as "started"
      exp_backoff_restart_delay: 5000,
      kill_timeout: 15000,         // give SIGINT time to flush session/history

      // single long-lived loop — never fork-cluster it
      instances: 1,
      exec_mode: "fork",

      // logs
      output: "./logs/auto.out.log",
      error: "./logs/auto.err.log",
      merge_logs: true,
      time: true,                  // prefix each line with a timestamp

      env: {
        NODE_ENV: "production",
        FAST_TUI: "1",             // no artificial hold; headless anyway
      },
    },
  ],
};
