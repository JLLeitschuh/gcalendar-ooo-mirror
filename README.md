# gcalendar-ooo-mirror

Mirror a personal calendar into your work calendar as out-of-office blocks — without leaking a
single event detail.

A Google Apps Script that reads a shared personal calendar and materializes each commitment as a
native **out-of-office event** on your work primary calendar, so coworkers' "Find a time" sees the
conflict and new invitations over your personal time are auto-declined.

## Why this is needed

A personal calendar shared into a work account shows up as an *overlay* — visible to you, but
invisible to everyone else's scheduling assistant and to free/busy lookups. Only events that live
on your own work calendars block bookings. This script materializes real blocks on the work
calendar so the conflict is visible to schedulers.

The mirror is strictly **one-way**. Nothing is ever written to the personal calendar.

## What gets created

| Property | Value |
|---|---|
| Title | `Personal Commitment — OOO` — the same generic string every time. No title, description, location, guests, or conferencing data from the source event is ever copied. |
| Type | `outOfOffice` (Google's native OOO event, shown with the distinctive OOO styling) |
| Busy | `transparency: opaque` |
| Auto-decline | `declineOnlyNewConflictingInvitations` — blocks future bookings, never retroactively declines a meeting you already accepted. Downgraded to `declineNone` on blocks that overlap a protected event (below) |
| Reminders | suppressed |
| Tag | `extendedProperties.private.oooMirror = v1`, plus the source event's ID |

That tag is how the script recognizes its own work. Events on the work calendar without it —
including OOO events created by hand — are never read, modified, or deleted.

## Install

1. Create the project:
   ```bash
   git clone https://github.com/JLLeitschuh/gcalendar-ooo-mirror.git
   cd gcalendar-ooo-mirror

   npm i -g @google/clasp   # once
   clasp login
   clasp create --type standalone --title "Personal OOO Mirror"
   clasp push -f
   ```
   Note that `clasp create` overwrites `appsscript.json` with its own default, dropping the
   Calendar advanced service declaration. Restore this repo's copy before pushing, or `Calendar`
   will be undefined at runtime.
   Or: create a new project at [script.google.com](https://script.google.com), enable the
   **Calendar API** advanced service (Services → Calendar → v3), and paste in `Config.gs`,
   `Mirror.gs`, `Setup.gs`.

2. Set `SOURCE_CALENDAR_ID` in `Config.gs` — it ships as a placeholder. Run `listCalendars()` to
   find the real ID — the personal
   calendar needs at least `reader` access (`freeBusyReader` also works, since no event detail is
   copied anyway).

3. Run `probeOooSupport()`. It creates one throwaway OOO event a year out, reports which fields
   survived, and deletes it. **Do not skip this** — OOO events are not enabled for every Workspace
   edition, and the sync engine depends on `extendedProperties.private` round-tripping. Expect
   `PASS`.

4. Run `previewSync()` (a dry run) and read the log. Confirm the create/skip decisions match your
   actual personal calendar.

5. Run `syncOooMirror()` once for real, check the work calendar in the UI, then
   `installTrigger()` to hand it to the scheduler (every 15 minutes by default).

`appsscript.json` pins `timeZone` to `America/New_York` — change it to yours; it only affects log
timestamps. Event
times are computed from the destination calendar's own timezone, read at runtime.

## Functions

| Function | Purpose |
|---|---|
| `syncOooMirror()` | The sync. Idempotent; safe to run any time. This is what the trigger calls. |
| `previewSync()` | Dry run — logs every decision, changes nothing. |
| `listCalendars()` | Print all visible calendars with IDs, access roles, timezones. |
| `probeOooSupport()` | Verify this account can create tagged OOO events. |
| `installTrigger()` / `removeTrigger()` | Manage the recurring trigger. |
| `previewPurge()` / `purgeAllMirrors()` | Clean uninstall. `purgeAllMirrors()` refuses to run until `ALLOW_PURGE` is set to `true` in `Config.gs`. |

## Which personal events get mirrored

Mirrored: timed events, at least `MIN_DURATION_MIN` long, ending in the future, within
`WINDOW_DAYS_AHEAD`. Recurring series are expanded and each instance mirrored separately (OOO
events cannot be recurring).

Skipped, with a per-reason count in the log:

- **all-day events** — vacations, "field trip", etc. OOO events cannot be all-day, and all-day
  entries are often informational rather than real commitments. To block a vacation, either create
  a timed personal event or use Google's own OOO feature directly.
- events marked **Free**
- events **declined** by the personal account
- `workingLocation` and `birthday` event types
- events whose **title or description** contains `#nomirror` (case-insensitive) — the per-event opt-out
- events shorter than 15 minutes
- events already over
- optionally, events entirely outside working hours (`WORK_HOURS_ONLY`, off by default)

## Never getting declined out of a meeting

Google's OOO auto-decline has no allow-list — you cannot exempt an individual event. Instead,
`PROTECTED_EVENT_TITLES` in `Config.gs` lists **work-calendar** event titles you must stay in:

```js
PROTECTED_EVENT_TITLES: ['No Meeting Day'],
```

(`'No Meeting Day'` ships as the default because a company-wide no-meeting block is the common
case. Set it to `[]` if you have no such events — that also saves an API call per run.)

Matching is a case-insensitive substring of the title, so `'No Meeting Day'` catches
`No Meeting Day!`. Any mirrored block overlapping one of those events is created with
`autoDeclineMode: 'declineNone'` — it still shows you busy, it just declines nothing. If the
protected event later moves or is deleted, the affected blocks are reconciled back to the normal
auto-decline mode on the next run.

Notes:

- The check uses the API's full-text `q` filter, so it costs one extra `events.list` call per
  configured title per run. Set the list to `[]` to skip it entirely.
- All-day protected events are resolved to **local** midnight, so an 8pm personal event on a
  protected day is covered, and an event the following day is not.
- Suppression is per-block, not per-overlap: a personal event that only partly overlaps a
  protected event loses auto-decline for its whole duration.
- Remember that with `declineOnlyNewConflictingInvitations`, meetings you have *already* accepted
  are never auto-declined in the first place. This guard matters for invitations that arrive
  after a block already covers the slot.

## Safety behavior

- **Lock.** Overlapping trigger runs are skipped rather than racing.
- **Delete cap.** More than `MAX_DELETES_PER_RUN` (25) deletions in a single run aborts the run
  before deleting anything.
- **Access-loss guard.** If the source calendar returns *zero events at all* while live mirrors
  exist — the signature of a revoked share — the run aborts rather than wiping the mirrors. If the
  personal calendar genuinely is empty, set `ALLOW_EMPTY_SOURCE = true` for one run.
- **Deletes before creates.** A moved event's old block is removed before the new one lands, so
  auto-decline can't fire against a stale overlap.
- **Backoff.** Transient `429`/`5xx`/rate-limit errors are retried with exponential backoff.
- **Fallback.** If the tenant rejects `outOfOffice`, the script logs a warning and creates plain
  busy events for the rest of the run (`FALLBACK_TO_BUSY_EVENT`). Still blocks free/busy; no
  auto-decline.

## Configuration

All tunables are at the top of `Config.gs`. The ones most likely to matter:

- `OOO_TITLE` / `EVENT_VISIBILITY` — both are part of the change signature, so editing either one
  renames or re-scopes every existing block on the next run, in place. No purge needed.
- `EVENT_VISIBILITY: 'private'` — coworkers see only "busy", not even the generic title.
- `AUTO_DECLINE_MODE: 'declineNone'` — purely visual blocking, nothing auto-declined.
- `AUTO_DECLINE_MODE: 'declineAllConflictingInvitations'` — also drops meetings you already
  accepted. Aggressive; think before enabling.
- `PROTECTED_EVENT_TITLES` — work events never to be auto-declined out of (see above).
- `WINDOW_DAYS_AHEAD` — how far out to mirror (default 60).
- `SYNC_INTERVAL_MINUTES` — re-run `installTrigger()` after changing.

## Tests

```bash
./test/run.sh
```

Runs the real `.gs` sources against a stubbed in-memory Calendar API: create, idempotent re-run,
event moved, event marked Free, orphan cleanup, both safety guards, the work-hours filter, the
busy-event fallback, and protected-event auto-decline suppression including the all-day local
midnight boundary cases. No network, no real calendar touched.

## Limitations

- Hand-editing or deleting a mirrored block is pointless — the next run restores it from source.
  Put `#nomirror` in the *personal* event's title or description instead. On a recurring series,
  editing the series drops all of its instances at once.
- Worst-case lag between booking a personal event and the block appearing is one trigger interval
  (~15 min).
- Events further out than `WINDOW_DAYS_AHEAD` are not mirrored until they enter the window.
- A personal event moved from inside the window to beyond it has its block deleted, then recreated
  later when the new date enters the window.
- Blocks whose start is beyond the scan horizon are reported but never deleted, so an orphan out
  there needs `purgeAllMirrors()` plus a re-sync to clear.
- If the personal calendar overlay is also displayed on your work calendar, you will see each item
  twice — in your own view only. Hide the overlay if that is noisy.

## Contributing

Issues and pull requests welcome. Please run `./test/run.sh` before opening a PR — it needs only
Node, no network and no Google account, and every behavioral change should come with a case.

## License

MIT — see [LICENSE](LICENSE).
