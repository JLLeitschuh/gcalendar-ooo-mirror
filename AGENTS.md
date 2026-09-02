# Engineering notes

Implementation detail and hard-won API behavior for anyone — human or agent — changing this
project. User-facing documentation lives in [README.md](README.md); this file is the *why*.

Run `./test/run.sh` before and after any change to `Mirror.gs`, `Config.gs`, or `Setup.gs`.

## Architecture

One entry point, `syncOooMirror()` in `Mirror.gs`, run on a 15-minute time-based trigger. Each run
is a full reconcile over a rolling window, not an incremental sync:

1. Resolve the destination calendar's timezone at runtime.
2. List source events in `[now, now + WINDOW_DAYS_AHEAD]` with `singleEvents: true`.
3. Filter to qualifying events (`skipReason_`), producing a `Map` of source event ID → desired block.
4. Resolve each block's auto-decline mode against protected work events (`applyProtection_`).
5. List existing mirrors via the extended-property marker.
6. Diff and apply: delete orphans, insert new, patch changed.

There is no `syncToken` / incremental path. The window is small enough that a full reconcile is
cheap, and it makes the script self-healing: any drift is corrected on the next run without state.

### Identity and idempotency

Every event the script creates carries:

```js
extendedProperties: { private: { oooMirror: 'v1', srcId: <source event id>, srcSig: <signature> } }
```

- `oooMirror` is passed to `events.list` as `privateExtendedProperty: 'oooMirror=v1'`, a
  **server-side** filter. This is what guarantees the script can never read, modify, or delete an
  event it did not create — including out-of-office events the user made by hand.
- `srcId` is the reconcile key. For recurring series this is the *instance* ID
  (`<seriesId>_<originalStartUtc>`), which stays stable when an instance is moved.
- `srcSig` is the change-detection key, built by `signature_()`.

**Bumping `MIRROR_VERSION` orphans every existing mirror** — the list filter will stop matching
them and they become invisible to the script. Run `purgeAllMirrors()` on the old version first.

### The signature contract

`signature_()` must include *every* field the script writes onto an event from configuration.
It currently covers start, end, auto-decline mode, `OOO_TITLE`, and `EVENT_VISIBILITY`.

If you add a config option that lands on the event, you must also:

1. add it to `signature_()`, and
2. add it to the patch body in `updateMirror_()`.

Miss step 1 and existing blocks silently keep the old value forever. Miss step 2 and the signature
changes every run, causing an infinite patch loop.

### Ordering

Deletes run before creates. A personal event that moves within the window produces a delete plus
an insert, and if the insert landed first the two blocks would briefly overlap — enough for
auto-decline to fire against the wrong meeting.

## Google Calendar API behavior worth knowing

Out-of-office events:

- `eventType: 'outOfOffice'` **can** be created via the API, but only on a **primary** calendar.
- They cannot be all-day. `SKIP_ALL_DAY` is therefore not merely a preference.
- `transparency` must be `'opaque'`.
- They are not enabled for every Workspace edition, hence `probeOooSupport()` and
  `FALLBACK_TO_BUSY_EVENT`. `extendedProperties.private` has been verified to round-trip on them.

General:

- **The API omits any field sitting at its default value.** A busy event comes back with no
  `transparency` field at all. This is why `SKIP_FREE_EVENTS` tests for equality with
  `'transparent'` rather than truthiness, and why `log_()` coerces `undefined`/`null` before
  calling `Utilities.formatString`, which otherwise throws `Not enough arguments`.
- **`patch` replaces nested objects wholesale.** `updateMirror_()` resends the complete
  `extendedProperties.private` map, not just the changed key.
- **`attendee.self` is relative to the authenticated user**, who is *not* an attendee on events
  belonging to a shared personal calendar. `isDeclinedBySourceOwner_()` matches on
  `SOURCE_CALENDAR_ID` instead.
- **All-day events carry bare dates** (`start.date`), meaning *local* calendar dates with an
  exclusive end. `new Date('2026-10-12')` parses as UTC midnight, which in a UTC-6 zone is 6pm the
  previous day — so an 8pm event on the intended day falls outside a naive window.
  `localMidnight_()` resolves dates properly by reading the zone offset at midday, when it is
  stable for the whole local day. There are tests pinning both boundaries.
- **A moved recurring instance's times differ from its ID.** Instance `..._20260916T230000Z` can
  legitimately start at 22:30. Always read times from the instance, never parse them out of the ID.

## Timezones

`resolveTimeZone_()` reads the destination calendar's timezone on every run, so the script follows
a user who relocates. `TIME_ZONE_OVERRIDE` in `Config.gs` pins it if needed.

The `timeZone` in `appsscript.json` affects only log timestamps and the `Session.getScriptTimeZone()`
fallback — not event times, which are written as absolute instants.

Because signatures are built from UTC instants, changing timezone or crossing a DST boundary does
**not** cause blocks to be rewritten.

## Safety mechanisms

Each of these exists because the failure mode it prevents is destructive and silent:

- **Lock** (`LockService`) — overlapping trigger runs skip rather than race.
- **Delete cap** — more than `MAX_DELETES_PER_RUN` planned deletions aborts the run before
  deleting anything.
- **Access-loss guard** — if the source read returns *zero events at all* while live mirrors exist,
  the run aborts. That is the signature of a revoked calendar share, and without the guard the
  next run would helpfully delete every block. "Read some events, none qualified" is legitimate and
  proceeds; only a completely empty read trips it. `ALLOW_EMPTY_SOURCE` bypasses it for one run.
- **Horizon limit on deletion** — only mirrors starting before `windowEnd` are considered
  orphanable, since the source was only scanned that far. Mirrors beyond it are logged, not
  deleted.
- **Backoff** — `withRetry_()` retries `429`/`5xx`/rate-limit errors up to 5 times.
- **Fallback** — a tenant rejecting `outOfOffice` degrades to plain busy events for the rest of the
  run rather than failing.

## Protected events

`collectProtected_()` uses the API's full-text `q` parameter to narrow the work calendar, then
re-checks the title locally because `q` also matches descriptions. Cost is one extra `events.list`
call per configured title per run; an empty `PROTECTED_EVENT_TITLES` skips the scan entirely.

Suppression is per-block rather than per-overlap: a personal event that only partly overlaps a
protected event loses auto-decline for its whole duration. Splitting the block would be more
precise and considerably more complex to reconcile.

Note that `declineOnlyNewConflictingInvitations` already leaves already-accepted meetings alone, so
this guard only matters for invitations that arrive *after* a block covers the slot.

## Tests

`test/run.sh` concatenates the real `.gs` sources with `test/cases.js` into a single file and runs
it under Node against `test/harness.js`, which stubs `Calendar`, `Utilities`, `LockService`, and
`Session` over an in-memory event store.

Two deliberate details:

- **Concatenation, not `require`.** Apps Script shares one global scope across files, so top-level
  `const CONFIG` is visible everywhere. Node's module scoping is not, so the files are joined into
  one before evaluation.
- **The harness is deliberately strict.** `Utilities.formatString` throws on `undefined`/`null`
  arguments exactly as Apps Script does, and `Events.list` implements the `q`,
  `privateExtendedProperty`, `timeMin`, and `timeMax` filters. Weakening the stubs will hide real
  bugs — the `formatString` strictness was added *after* an undefined argument crashed a live run.

## Working with clasp

- **`clasp create` overwrites `appsscript.json`** with its own default, silently dropping the
  Calendar advanced service declaration and the OAuth scopes. `Calendar` is then undefined at
  runtime. Restore this repo's manifest and `clasp push -f`. The same applies to `clasp pull`.
- `clasp run` is not usable here without extra setup: it needs a standard GCP project, the Apps
  Script API enabled, an API Executable deployment, and — the real blocker — clasp's own OAuth
  token to cover `auth/calendar`, which requires your own OAuth client via `clasp login --creds`.
  Push with clasp, execute from the editor.
- Some Workspace tenants reject clasp's refresh token, making every push after a fresh login fail
  with `invalid_grant`. Re-run `clasp login` per push, or use `clasp login --creds`.
