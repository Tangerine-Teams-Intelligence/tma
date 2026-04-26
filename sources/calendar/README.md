# `@tangerine/source-calendar`

Calendar source connector for Tangerine. Watches one or more calendars and turns every past + upcoming event into an **atom** in your team-memory tree. The atom format is documented in [`../README.md`](../README.md).

The PRIMARY purpose of this source is **enabling pre-meeting briefs**. When the daemon ticks every 5 min, it checks each configured calendar for events starting in the next 5–10 min and pushes a brief notification.

## Install

This package is part of the Tangerine monorepo and is not published to npm.

```bash
cd sources/calendar
npm install
npm run build
```

The CLI is installed as `tangerine-calendar` if you `npm link` from this directory; otherwise invoke `node dist/cli.js`.

## Quick start (Stage 1 — iCal feed)

The fastest way to ingest a calendar — no OAuth, no app registration. Just paste the iCal URL.

### 1. Get the iCal URL

Most calendar apps publish a "secret" or "public" iCal URL:

- **Google Calendar**: Settings → "Settings for my calendars" → pick the calendar → "Integrate calendar" → copy the **Secret address in iCal format**. Looks like `https://calendar.google.com/calendar/ical/<your-id>/private-<token>/basic.ics`. **Treat it like a password.** Anyone with this URL can read your calendar.
- **Apple iCloud Calendar**: Calendar → right-click the calendar → Share Calendar → "Public Calendar" → copy URL.
- **Outlook**: Calendar → Settings → "Shared calendars" → Publish → copy iCal link.

### 2. Add the feed

```bash
tangerine-calendar add-ical https://calendar.google.com/calendar/ical/abc/private-xyz/basic.ics --name="Daizhe Personal" --projects=v1-launch
# added ical-1k7g3wpqhx (Daizhe Personal) projects=[v1-launch]
```

`--projects` tags every atom from this calendar with the given project IDs.

### 3. Poll

One-shot:

```bash
tangerine-calendar poll
# processed 1 calendar(s) — 47 atom(s) seen, 47 new
#   ical-1k7g3wpqhx (Daizhe Personal): 47 atoms, 47 written, 0 dup, cursor=2026-04-25T15:31:20.000Z
```

Daemon (polls every `poll_interval_sec`, default 60s):

```bash
tangerine-calendar watch
# watching — Ctrl+C to stop
```

`--dry-run`:

```bash
tangerine-calendar poll --dry-run
# [dry-run] processed 1 calendar(s) — 12 atom(s) generated, none written
```

### 4. Inspect upcoming brief triggers

```bash
tangerine-calendar briefs
#   2026-04-25T16:00:00.000Z  T-3m  Investor pitch — Acme Ventures  [ical-1k7g3wpqhx]
```

The daemon's brief-generator extension calls `pollBriefTriggers()` on every heartbeat and pushes a notification + composed brief for each result. See [`src/briefs.ts`](src/briefs.ts) for the daemon integration shape.

## Stage 2 — Google Calendar OAuth (NOT YET IMPLEMENTED)

The `tangerine-calendar add-google` command is reserved but exits with a "Stage 2" notice. To register the OAuth app:

1. Go to <https://console.cloud.google.com/apis/credentials>
2. Create OAuth 2.0 Client ID → application type **Desktop app**
3. Add scope: `https://www.googleapis.com/auth/calendar.readonly`
4. Copy the client id + secret. Set them in the source config (Stage 2 lands the env-var path).

For Stage 1, paste the iCal URL from Google Calendar settings instead — it works against the same backing data and needs no OAuth round trip.

## Atom kinds emitted

| Calendar event              | atom.kind        | thread id              |
| --------------------------- | ---------------- | ---------------------- |
| past event (already happened) | `calendar_event` | `cal-<calendar>-<slug>` |
| upcoming event              | `calendar_event` | `cal-<calendar>-<slug>` |

Recurring events emit one atom per occurrence; the slug includes the start date so each occurrence is unique.

## Pre-meeting brief integration

The daemon's brief-generator extension imports two functions from this package:

```ts
import { pollBriefTriggers, briefForEvent } from "@tangerine/source-calendar";

// every 5 min:
const triggers = await pollBriefTriggers({ memoryRoot });
for (const t of triggers) {
  const md = await briefForEvent(memoryRoot, t);
  pushNotification(t.title, md);
}
```

`pollBriefTriggers` returns events in the [now + lead - window, now + lead] band where `lead` is `brief_lead_minutes` (default 5) and `window` is `upcoming_window_minutes` (default 10). Tunable in `calendar.config.json`.

`briefForEvent` is the Stage 1 brief composer — substring-matches event title against existing thread + timeline files. Stage 2 will swap in semantic retrieval + Claude summarisation against the matched atoms.

## Cursor and config

State lives in three files inside the memory root:

- `<memory>/.tangerine/sources/calendar.config.json` — calendar list, lead/window settings
- `<memory>/.tangerine/sources/calendar.cursor.json` — per-calendar last-poll wall-clock ts
- `<memory>/.tangerine/sources/calendar.identity.json` — email → Tangerine alias map

Delete the config to start over. Delete identity entries to remap aliases.

## AGI hooks

Every atom emitted carries the 8 future-proof fields documented in `STAGE1_AGI_HOOKS.md` Hook 1:

```yaml
embedding: null
concepts: []
confidence: 1.0
alternatives: []
source_count: 1
reasoning_notes: null
sentiment: null
importance: null
```

Stage 2 reasoning loops mutate these in place — no schema migration needed.
