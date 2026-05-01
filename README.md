# GlintsAuto

Glints auto-apply bot with a live terminal dashboard, multi-source job feeds,
post-apply intro-message sending, daily caps, and cron scheduling.

Reverse-engineered from the Glints Android app (v1.106.2) by capturing the
mobile API traffic and porting the relevant flows to a TypeScript client.

> **Disclaimer**: Use at your own risk. This is unofficial — Glints can change
> their API at any time, and aggressive automation may violate their ToS.

## Features

- **TypeScript** end to end. Strict mode, no `any` in the public surface.
- **Live TUI dashboard** ([src/tui.ts](src/tui.ts)) with diff-rendered ANSI —
  no flicker, runs in the alt-screen buffer, recovers on resize.
- **Auto-apply engine** ([src/engine.ts](src/engine.ts))
  - Multi-source feeds (round-robin): For-You, For-You "recently added",
    nearby-by-GPS, easily extensible to more.
  - Filters: include/exclude keywords, job types, work arrangements,
    `minYearsOfExperience` cap, `remoteOnly`, fraud-flag and already-applied
    skipping.
  - Rate-limited applies with randomized delay between
    `minDelaySeconds`–`maxDelaySeconds`.
  - Per-run and per-day apply caps; daily counter is timezone-aware
    (defaults to `Asia/Jakarta`).
  - Dedupe via local history (`.glints/history.json`).
  - Dry-run mode that exercises every step except the final POST.
- **Post-apply chat flow** mirrors the app: open the chat channel for the new
  application, then send the user's saved intro message.
- **Cron scheduler** ([src/scheduler.ts](src/scheduler.ts)) using `node-cron`
  with timezone support. Re-entrant guard so overlapping ticks skip.
- **Resume upload** ([src/client.ts](src/client.ts)) via the captured
  presigned-PUT flow, with a one-call helper that updates the profile.
- **Persisted session** in `.glints/session.json` so subsequent runs reuse the
  bearer token.

## Quick start

```bash
# 1. Install deps (Node ≥ 18.17)
npm install

# 2. Set credentials
cp .env.example .env
#   GLINTS_USERNAME=you@example.com
#   GLINTS_PASSWORD=...

# 3. (Optional) tune filters / answers / cron
cp config.example.json config.json

# 4. Smoke-test
npx tsx src/cli.ts me
npx tsx src/cli.ts feed

# 5. Rehearse
npx tsx src/cli.ts apply --dry-run

# 6. Run for real
npx tsx src/cli.ts apply

# 7. Run the cron scheduler
npx tsx src/cli.ts cron
```

## CLI

```
glints me                      Show the current candidate profile.
glints feed [-p N -s SIZE]     List the For-You job feed.
glints apply [--dry-run]       One-shot run with the live TUI dashboard.
glints apply --no-tui          Plain stdout output instead of TUI.
glints dashboard               Alias of `apply`.
glints cron [--once] [--dry-run]
                               Long-running cron scheduler.
glints history [-n LIMIT]      Recent applies + today's cap usage.
glints reset-day               Clear today's local apply history (resets cap).
glints config                  Print the resolved config.
```

## Configuration

`config.json` — see [config.example.json](config.example.json):

```jsonc
{
  "feed": {
    "pageName": "for_you",
    "pageSize": 10,
    "maxPages": 20,
    "sources": [
      { "type": "recommend", "pageName": "for_you", "maxPages": 20 },
      { "type": "recommend", "pageName": "for_you", "recentlyAdded": true, "maxPages": 10 },
      { "type": "nearby", "maxPages": 10 }
    ]
  },
  "filters": {
    "includeKeywords": ["developer", "engineer", "fullstack", "backend"],
    "excludeKeywords": ["sales", "marketing", "intern"],
    "jobTypes": ["FULL_TIME", "CONTRACT"],
    "workArrangements": ["REMOTE", "HYBRID", "ONSITE"],
    "minYearsOfExperienceMax": 5,
    "remoteOnly": false,
    "skipApplied": true,
    "skipFraudFlagged": true
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
  "intro": {
    "enabled": true
  },
  "cron": {
    "schedule": "0 */2 * * *",
    "timezone": "Asia/Jakarta"
  }
}
```

The `answers` map feeds the one-tap-apply questions. If a job asks something
not in the bank and the question is required, the engine logs
`missing-answers:<question_name>` and skips — extend the bank to handle it.

## Project layout

```
src/
├── client.ts       GlintsClient + GlintsApiError (typed)
├── queries.ts      captured GraphQL operations
├── types.ts        API response types
├── config.ts       config loader + .env handling
├── storage.ts      history + session persistence
├── filters.ts      job filter rules
├── answer-bank.ts  one-tap question → answer mapper
├── engine.ts       auto-apply engine (event-driven)
├── tui.ts          live ANSI dashboard
├── scheduler.ts    node-cron loop
└── cli.ts          commander entry point
```

## License

Private / unlicensed.
