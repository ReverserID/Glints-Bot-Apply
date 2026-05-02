# GlintsAuto

Auto-apply bot for Glints. TypeScript, terminal UI, cron + 24/7 modes.
Talks to the same mobile API the Android app uses.

> Educational. Use on your own account. Don't be a dick.

## What it does

- Pulls jobs from the For-You feed (and "recently added" / nearby as fallbacks).
- Filters by keywords, job type, work arrangement, min experience, fraud flag.
- One-tap-applies with answers from a config bank.
- After each apply, opens the chat channel and sends the saved intro message —
  same flow as the app.
- Live terminal dashboard while it runs.
- **24/7 auto mode**: derives keywords from your profile, loops forever,
  sleeps until next midnight when daily cap hits, exponential backoff on errors.
- Cron mode if you'd rather schedule it.
- Daily and per-run caps. Random delay between applies.
- Local history so it doesn't apply to the same job twice — including
  server-side 409 dedupe (handles "you already applied" without burning retries).

No browser automation. No Selenium. Just HTTP.

## Setup

```bash
# Node 18.17+
npm install

cp .env.example .env
# fill GLINTS_USERNAME and GLINTS_PASSWORD

cp config.example.json config.json
# tweak filters / answers / auto loop / cron
```

## Run

```bash
npx tsx src/cli.ts me               # check login
npx tsx src/cli.ts feed             # peek at the feed
npx tsx src/cli.ts keywords         # preview auto-derived keywords
npx tsx src/cli.ts apply --dry-run  # rehearse, no real apply
npx tsx src/cli.ts apply            # one run, with TUI
npx tsx src/cli.ts auto             # never stop — 24/7 mode
npx tsx src/cli.ts cron             # cron-scheduled runs
```

For long-running on a server:

```bash
# nohup
nohup npx tsx src/cli.ts auto --no-tui > .glints/auto.log 2>&1 &

# or PM2 (auto-restart on crash, survives reboots)
pm2 start --name glints-auto -- npx tsx src/cli.ts auto --no-tui
pm2 save && pm2 startup
```

## Commands

```
me                      show profile
feed [-p N -s SIZE]     list For-You feed
keywords                preview auto-derived keywords
apply [--dry-run]       one run, with TUI
apply --no-tui          one run, plain stdout
dashboard               alias for apply
auto [--dry-run]        24/7 loop — auto keywords, auto cooldowns, auto resume
cron [--once]           cron-scheduled scheduler
history [-n N]          recent applies + today's cap
reset-day               clear today's local history (resets daily cap)
config                  print resolved config
```

## Config

`config.json`. The interesting bits:

```jsonc
{
  "filters": {
    "includeKeywords": ["developer", "engineer"],
    "excludeKeywords": ["sales", "marketing", "intern"],
    "jobTypes": ["FULL_TIME", "CONTRACT"],
    "minYearsOfExperienceMax": 5
  },
  "limits": {
    "maxAppliesPerRun": 20,
    "maxAppliesPerDay": 50,
    "minDelaySeconds": 4,
    "maxDelaySeconds": 12
  },
  "answers": {
    "years_of_relevant_experience_v2": "More than 5 years",
    "skill_set_tools": "Expert",
    "skill_set_foreign_language_v2": ["Bahasa Indonesia", "English"]
  },
  "intro": { "enabled": true },
  "cron": { "schedule": "0 */2 * * *", "timezone": "Asia/Jakarta" },
  "auto": {
    "cooldownMinutes": 30,
    "idleMinutes": 20,
    "refreshKeywordsEvery": 5,
    "autoKeywords": true,
    "maxConsecutiveErrors": 5
  }
}
```

If a job asks a question not in `answers` and it's required, the bot logs
`missing-answers:<name>` and skips. Add it to the bank and rerun.

When `auto.autoKeywords` is true, the loop overrides `filters.includeKeywords`
with terms derived from your work experience titles, skill tags, and job-role
preferences. Run `glints keywords` to preview the list before turning auto on.

## 24/7 mode behavior

| Outcome of a run | What happens next |
|---|---|
| Daily cap hit | Sleeps until next local midnight (`cron.timezone`), resumes |
| Per-run cap hit | Sleeps `auto.cooldownMinutes` (default 30) |
| Feed exhausted / nothing matched | Sleeps `auto.idleMinutes` (default 20) |
| Normal progress | 2-minute breath, then next run |
| Run threw an error | Backoff 2 → 4 → 8 → 16 → 32 → 60 min, bail after `maxConsecutiveErrors` |
| Server returns 409 "already applied" | Recorded as already-applied so it's never retried |

## How it works

```
src/
├── client.ts        HTTP client — REST + 2 GraphQL endpoints
├── queries.ts       captured GraphQL ops
├── types.ts         response types
├── config.ts        config + .env
├── storage.ts       history + session JSON (timezone-aware day boundaries)
├── filters.ts       job filter rules
├── answer-bank.ts   question → answer mapping
├── auto-keywords.ts derive includeKeywords from profile + experiences
├── engine.ts        the actual auto-apply loop
├── auto.ts          24/7 loop wrapper
├── tui.ts           terminal UI (alt-screen, diff render)
├── scheduler.ts     node-cron wrapper
└── cli.ts           commander entry
```

The engine round-robins across feed sources, dedupes against local history,
filters, fetches per-job questions, builds answers, submits, then opens the
chat channel and sends the intro. Events flow through an EventEmitter — the
TUI and cron logger both subscribe.

`auto.ts` wraps the engine in a never-ending loop with smart waits, derives
keywords from your profile periodically, and handles cap/error states so the
process keeps grinding without intervention.

## License

Private.
