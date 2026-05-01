# GlintsAuto

Auto-apply bot for Glints. TypeScript, terminal UI, cron scheduling.
Talks to the same mobile API the Android app uses.

> Educational. Use on your own account. Don't be a dick.

## What it does

- Pulls jobs from the For-You feed (and "recently added" / nearby as fallbacks).
- Filters by keywords, job type, work arrangement, min experience, fraud flag.
- One-tap-applies with answers from a config bank.
- After each apply, opens the chat channel and sends the saved intro message —
  same flow as the app.
- Live terminal dashboard while it runs.
- Cron scheduler if you want it to keep going.
- Daily and per-run caps. Random delay between applies.
- Local history so it doesn't apply to the same job twice.

No browser automation. No Selenium. Just HTTP.

## Setup

```bash
# Node 18.17+
npm install

cp .env.example .env
# fill GLINTS_USERNAME and GLINTS_PASSWORD

cp config.example.json config.json
# tweak filters / answers
```

## Run

```bash
npx tsx src/cli.ts me              # check login
npx tsx src/cli.ts feed             # peek at the feed
npx tsx src/cli.ts apply --dry-run  # rehearse, no real apply
npx tsx src/cli.ts apply            # do it for real
npx tsx src/cli.ts cron             # keep running on a schedule
```

## Commands

```
me                      show profile
feed [-p N -s SIZE]     list For-You feed
apply [--dry-run]       one run, with TUI
apply --no-tui          one run, plain stdout
dashboard               alias for apply
cron [--once]           long-running scheduler
history [-n N]          recent applies + today's cap
reset-day               clear today's local history
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
  "cron": { "schedule": "0 */2 * * *", "timezone": "Asia/Jakarta" }
}
```

If a job asks a question not in `answers` and it's required, the bot logs
`missing-answers:<name>` and skips. Add it to the bank and rerun.

## How it works

```
src/
├── client.ts       HTTP client — REST + 2 GraphQL endpoints
├── queries.ts      captured GraphQL ops
├── types.ts        response types
├── config.ts       config + .env
├── storage.ts      history + session JSON
├── filters.ts      job filter rules
├── answer-bank.ts  question → answer mapping
├── engine.ts       the actual auto-apply loop
├── tui.ts          terminal UI (alt-screen, diff render)
├── scheduler.ts    node-cron wrapper
└── cli.ts          commander entry
```

The engine round-robins across feed sources, dedupes against local history,
filters, fetches per-job questions, builds answers, submits, then opens the
chat channel and sends the intro. Events flow through an EventEmitter — the
TUI and cron logger both subscribe.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /oauth2/token` | Login (password grant) |
| `POST /api/graphql?op=getMe` | Profile |
| `GET /v2/api/v3/me/recommend/es/jobs` | For-You feed |
| `GET /v2/api/nearby/jobs` | Nearby jobs |
| `POST /v2/api/graphql?op=getOneTapJobApplyQuestions` | Apply questions |
| `POST /v2/api/v2/jobs/{id}/applications` | Submit application |
| `POST chat.glints.com/api/channel/start` | Open chat for application |
| `POST /api/graphql?op=getMessagingIntroMessage` | Get saved intro |
| `POST chat.glints.com/api/message` | Send intro |

App fingerprint headers it sends:

```
x-app-platform: ANDROID
x-app-version: 1.106.2
x-device-id: <16 hex>
x-glints-country-code: ID
x-user-role: CANDIDATE
user-agent: Dart/3.9 (dart:io)
```

## Notes

- Mobile APIs are usually cleaner than web scraping. No captcha, stable JSON.
- Captured with HTTP Toolkit. Easy to redo if Glints ships a new app version.
- The bot is rate-limited on purpose. Don't lower the delays unless you want
  your account flagged.
- Tokens cache in `.glints/session.json`. History in `.glints/history.json`.
  Nuke the folder to start fresh.

## License

Private.
