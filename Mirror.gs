/**
 * One-way mirror: personal calendar events -> out-of-office blocks on the work
 * primary calendar, so coworkers' "Find a time" sees the conflict.
 *
 * Entry point: syncOooMirror(). Install it on a time-based trigger with
 * installTrigger() from Setup.gs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** Set for the remainder of a run if the tenant rejects OOO event creation. */
let oooUnavailableForRun = false;

/**
 * Reconcile the destination calendar against the source calendar. Safe to run
 * as often as you like: it is idempotent and only ever touches events it made.
 */
function syncOooMirror() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('another run holds the lock; skipping this tick');
    return null;
  }
  try {
    oooUnavailableForRun = false;
    return sync_();
  } finally {
    lock.releaseLock();
  }
}

/** Log what a sync would do, without changing anything. */
function previewSync() {
  const wasDryRun = CONFIG.DRY_RUN;
  CONFIG.DRY_RUN = true;
  try {
    return syncOooMirror();
  } finally {
    CONFIG.DRY_RUN = wasDryRun;
  }
}

function sync_() {
  const tz = resolveTimeZone_();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + CONFIG.WINDOW_DAYS_AHEAD * DAY_MS);

  log_('sync start: source=%s dest=%s tz=%s horizon=%s%s',
      CONFIG.SOURCE_CALENDAR_ID, CONFIG.DEST_CALENDAR_ID, tz,
      windowEnd.toISOString(), CONFIG.DRY_RUN ? ' [DRY RUN]' : '');

  const source = collectDesired_(now, windowEnd, tz);
  const desired = source.desired;
  applyProtection_(desired, collectProtected_(now, windowEnd, tz));
  const mirrors = collectMirrors_(now, windowEnd);

  const stats = {created: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0};

  // Deletions first, so a moved event frees up its slot before the new block
  // lands -- otherwise the two overlap briefly and auto-decline could fire on
  // the wrong meeting.
  const orphans = mirrors.deletable.filter(function(m) { return !desired.has(m.srcId); });
  const dupes = mirrors.duplicates;
  const toDelete = dupes.concat(orphans);

  if (toDelete.length > CONFIG.MAX_DELETES_PER_RUN) {
    throw new Error(Utilities.formatString(
        'refusing to delete %s mirrors in one run (MAX_DELETES_PER_RUN=%s). ' +
        'Verify the source calendar is still readable, then raise the limit if this is expected.',
        toDelete.length, CONFIG.MAX_DELETES_PER_RUN));
  }
  // A source read that returns literally nothing, while mirrors exist, is the
  // signature of lost access to the shared calendar -- not of a cleared
  // schedule. "Read some events, none qualified" is legitimate and proceeds.
  if (source.rawCount === 0 && mirrors.deletable.length > 0 && !CONFIG.ALLOW_EMPTY_SOURCE) {
    throw new Error(Utilities.formatString(
        'source calendar returned 0 events at all but %s live mirrors exist; refusing to ' +
        'delete. Confirm %s is still shared with this account. If the calendar really is ' +
        'empty, set ALLOW_EMPTY_SOURCE = true for one run.',
        mirrors.deletable.length, CONFIG.SOURCE_CALENDAR_ID));
  }

  toDelete.forEach(function(mirror) {
    if (deleteMirror_(mirror)) { stats.deleted++; } else { stats.failed++; }
  });

  desired.forEach(function(want, srcId) {
    const existing = mirrors.bySrcId.get(srcId);
    if (!existing) {
      if (createMirror_(want, tz)) { stats.created++; } else { stats.failed++; }
    } else if (existing.srcSig !== want.sig) {
      if (updateMirror_(existing, want, tz)) { stats.updated++; } else { stats.failed++; }
    } else {
      stats.unchanged++;
    }
  });

  log_('sync done: created=%s updated=%s deleted=%s unchanged=%s failed=%s' +
       ' (source qualified=%s, skipped=%s)',
      stats.created, stats.updated, stats.deleted, stats.unchanged, stats.failed,
      desired.size, JSON.stringify(source.skips));

  if (stats.failed > 0) {
    throw new Error(stats.failed + ' calendar write(s) failed; see log above.');
  }
  return stats;
}

// --- Reading the source -----------------------------------------------------

/**
 * Build {desired, rawCount, skips}, where desired maps srcEventId ->
 * {start, end, sig} for every source event that should be blocked out on the
 * work calendar.
 */
function collectDesired_(now, windowEnd, tz) {
  const events = listAllEvents_(CONFIG.SOURCE_CALENDAR_ID, {
    timeMin: now.toISOString(),
    timeMax: windowEnd.toISOString(),
    // Expand recurring series into instances: OOO events cannot be recurring,
    // and instance IDs stay stable across edits, which is what we key on.
    singleEvents: true,
    showDeleted: false,
    maxResults: 2500,
  });

  const desired = new Map();
  const skips = {};
  events.forEach(function(ev) {
    const reason = skipReason_(ev, now, tz);
    if (reason) {
      skips[reason] = (skips[reason] || 0) + 1;
      return;
    }
    const start = new Date(ev.start.dateTime);
    const end = new Date(ev.end.dateTime);
    desired.set(ev.id, {srcId: ev.id, start: start, end: end});
  });

  log_('source: %s events in window, %s qualified, skips=%s',
      events.length, desired.size, JSON.stringify(skips));
  return {desired: desired, rawCount: events.length, skips: skips};
}

/**
 * Returns a short reason string if this source event should NOT be mirrored,
 * or '' if it qualifies.
 */
function skipReason_(ev, now, tz) {
  if (ev.status === 'cancelled') return 'cancelled';
  if (CONFIG.SKIP_EVENT_TYPES.indexOf(ev.eventType) !== -1) return 'eventType:' + ev.eventType;

  // All-day events arrive as start.date; timed events as start.dateTime.
  if (!ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) {
    return CONFIG.SKIP_ALL_DAY ? 'allDay' : 'noTimes';
  }
  if (CONFIG.SKIP_FREE_EVENTS && ev.transparency === 'transparent') return 'markedFree';
  if (hasOptOut_(ev)) return 'optedOut';
  if (CONFIG.SKIP_DECLINED && isDeclinedBySourceOwner_(ev)) return 'declined';

  const start = new Date(ev.start.dateTime);
  const end = new Date(ev.end.dateTime);
  if (end <= now) return 'alreadyOver';
  if (end - start < CONFIG.MIN_DURATION_MIN * MIN_MS) return 'tooShort';
  if (CONFIG.WORK_HOURS_ONLY && !overlapsWorkHours_(start, end, tz)) return 'outsideWorkHours';

  return '';
}

/** True if the opt-out keyword appears in the source event's title or description. */
function hasOptOut_(ev) {
  if (!CONFIG.OPT_OUT_KEYWORD) return false;
  const needle = CONFIG.OPT_OUT_KEYWORD.toLowerCase();
  return [ev.summary, ev.description].some(function(text) {
    return !!text && text.toLowerCase().indexOf(needle) !== -1;
  });
}

/**
 * The attendee `self` flag is relative to the authenticated (work) user, who is
 * not an attendee on personal events -- so match the source calendar's own
 * address instead.
 */
function isDeclinedBySourceOwner_(ev) {
  if (!ev.attendees) return false;
  const owner = CONFIG.SOURCE_CALENDAR_ID.toLowerCase();
  return ev.attendees.some(function(a) {
    return a.email && a.email.toLowerCase() === owner && a.responseStatus === 'declined';
  });
}

/**
 * True if [start, end) overlaps working hours on the event's start date. Only
 * the start date is considered, so a multi-day timed event is judged by its
 * first day.
 */
function overlapsWorkHours_(start, end, tz) {
  const workStart = localHourOnSameDay_(start, CONFIG.WORK_START_HOUR, tz);
  const workEnd = localHourOnSameDay_(start, CONFIG.WORK_END_HOUR, tz);
  return start < workEnd && end > workStart;
}

/**
 * The instant at `hour`:00 local time, on whatever local day `ref` falls on.
 * Both the date and the UTC offset are taken from `ref` itself, so this is
 * correct across DST changes for any day but the transition day.
 */
function localHourOnSameDay_(ref, hour, tz) {
  const day = Utilities.formatDate(ref, tz, 'yyyy-MM-dd');
  const rfc822 = Utilities.formatDate(ref, tz, 'Z');       // e.g. -0600
  const offset = rfc822.slice(0, 3) + ':' + rfc822.slice(3); // -> -06:00
  const hh = ('0' + hour).slice(-2);
  return new Date(day + 'T' + hh + ':00:00' + offset);
}

// --- Protected work events --------------------------------------------------

/**
 * Work-calendar events matching PROTECTED_EVENT_TITLES. Uses the API's
 * full-text `q` filter to avoid pulling the whole work calendar, then
 * re-checks the title locally because `q` also matches descriptions.
 */
function collectProtected_(now, windowEnd, tz) {
  const needles = (CONFIG.PROTECTED_EVENT_TITLES || []).map(function(t) {
    return t.toLowerCase();
  });
  if (needles.length === 0) return [];

  const ranges = [];
  const seen = {};
  CONFIG.PROTECTED_EVENT_TITLES.forEach(function(title) {
    listAllEvents_(CONFIG.DEST_CALENDAR_ID, {
      timeMin: now.toISOString(),
      timeMax: windowEnd.toISOString(),
      q: title,
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
    }).forEach(function(ev) {
      if (seen[ev.id] || !ev.summary) return;
      const name = ev.summary.toLowerCase();
      const matches = needles.some(function(n) { return name.indexOf(n) !== -1; });
      if (!matches) return;
      seen[ev.id] = true;
      const bounds = eventBounds_(ev, tz);
      ranges.push({start: bounds.start, end: bounds.end, summary: ev.summary});
    });
  });
  return ranges;
}

/** Decide each block's auto-decline mode based on protected-event overlap. */
function applyProtection_(desired, ranges) {
  let suppressed = 0;
  desired.forEach(function(want) {
    const clash = firstOverlap_(want, ranges);
    want.autoDecline = clash ? 'declineNone' : CONFIG.AUTO_DECLINE_MODE;
    want.sig = signature_(want.start, want.end, want.autoDecline);
    if (clash) {
      suppressed++;
      log_('auto-decline suppressed for block at %s: overlaps protected "%s"',
          want.start.toISOString(), clash.summary);
    }
  });
  if (ranges.length > 0) {
    log_('protected: %s matching work event(s) in window, auto-decline suppressed on %s block(s)',
        ranges.length, suppressed);
  }
}

function firstOverlap_(want, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (want.start < ranges[i].end && want.end > ranges[i].start) return ranges[i];
  }
  return null;
}

/** Start/end of an event, handling both timed and all-day representations. */
function eventBounds_(ev, tz) {
  if (ev.start.dateTime) {
    return {start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime)};
  }
  // All-day events carry local calendar dates, with end exclusive.
  return {start: localMidnight_(ev.start.date, tz), end: localMidnight_(ev.end.date, tz)};
}

/** Local midnight of a yyyy-MM-dd date string, as an instant. */
function localMidnight_(dateStr, tz) {
  // Read the offset at midday, which is stable for the whole local day.
  const rfc822 = Utilities.formatDate(new Date(dateStr + 'T12:00:00Z'), tz, 'Z');
  const offset = rfc822.slice(0, 3) + ':' + rfc822.slice(3);
  return new Date(dateStr + 'T00:00:00' + offset);
}

// --- Reading existing mirrors -----------------------------------------------

/**
 * Find every event this script has previously created. Uses a server-side
 * extended-property filter, so nothing else on the work calendar is in scope.
 */
function collectMirrors_(now, windowEnd) {
  const scanEnd = new Date(windowEnd.getTime() + CONFIG.CLEANUP_PAD_DAYS * DAY_MS);
  const events = listAllEvents_(CONFIG.DEST_CALENDAR_ID, {
    timeMin: now.toISOString(),
    timeMax: scanEnd.toISOString(),
    privateExtendedProperty: MIRROR_KEY + '=' + MIRROR_VERSION,
    showDeleted: false,
    singleEvents: true,
    maxResults: 2500,
  });

  const bySrcId = new Map();
  const duplicates = [];
  const deletable = [];
  let beyondHorizon = 0;

  events.forEach(function(ev) {
    const props = (ev.extendedProperties && ev.extendedProperties.private) || {};
    const mirror = {
      id: ev.id,
      srcId: props.srcId || '',
      srcSig: props.srcSig || '',
      start: new Date(ev.start.dateTime || ev.start.date),
      summary: ev.summary,
      isOoo: ev.eventType === 'outOfOffice',
    };

    if (!mirror.srcId) {
      // Tagged as ours but unusable: no source to reconcile against.
      duplicates.push(mirror);
      return;
    }
    if (bySrcId.has(mirror.srcId)) {
      duplicates.push(mirror);
      return;
    }
    bySrcId.set(mirror.srcId, mirror);

    // Only mirrors inside the horizon we actually scanned the source for can be
    // judged orphaned. Anything further out we merely report.
    if (mirror.start < windowEnd) {
      deletable.push(mirror);
    } else {
      beyondHorizon++;
    }
  });

  log_('dest: %s live mirrors (%s reconcilable, %s beyond horizon, %s duplicate/untagged)',
      events.length, deletable.length, beyondHorizon, duplicates.length);
  return {bySrcId: bySrcId, deletable: deletable, duplicates: duplicates};
}

// --- Writing --------------------------------------------------------------

function createMirror_(want, tz) {
  if (CONFIG.DRY_RUN) {
    log_('[dry run] would create %s -> %s (src %s)',
        want.start.toISOString(), want.end.toISOString(), want.srcId);
    return true;
  }
  const payload = buildPayload_(want, tz, !oooUnavailableForRun);
  try {
    withRetry_('Events.insert', function() {
      return Calendar.Events.insert(payload, CONFIG.DEST_CALENDAR_ID);
    });
    return true;
  } catch (err) {
    if (CONFIG.FALLBACK_TO_BUSY_EVENT && !oooUnavailableForRun && isOooRejection_(err)) {
      log_('WARN out-of-office events rejected by this account (%s); ' +
           'falling back to plain busy events for the rest of this run', err.message);
      oooUnavailableForRun = true;
      return createMirror_(want, tz);
    }
    log_('ERROR creating mirror for src %s: %s', want.srcId, err.message);
    return false;
  }
}

function updateMirror_(existing, want, tz) {
  if (CONFIG.DRY_RUN) {
    log_('[dry run] would move mirror %s to %s -> %s (src %s)',
        existing.id, want.start.toISOString(), want.end.toISOString(), want.srcId);
    return true;
  }
  // Nested objects are replaced wholesale by patch, so resend the full private
  // property map rather than just the changed key.
  const patch = {
    summary: CONFIG.OOO_TITLE,
    visibility: CONFIG.EVENT_VISIBILITY,
    start: timeField_(want.start, tz),
    end: timeField_(want.end, tz),
    extendedProperties: {private: privateProps_(want)},
  };
  if (existing.isOoo) {
    patch.outOfOfficeProperties = {
      autoDeclineMode: want.autoDecline,
      declineMessage: CONFIG.DECLINE_MESSAGE,
    };
  }
  try {
    withRetry_('Events.patch', function() {
      return Calendar.Events.patch(patch, CONFIG.DEST_CALENDAR_ID, existing.id);
    });
    return true;
  } catch (err) {
    log_('ERROR updating mirror %s (src %s): %s', existing.id, want.srcId, err.message);
    return false;
  }
}

function deleteMirror_(mirror) {
  if (CONFIG.DRY_RUN) {
    log_('[dry run] would delete mirror %s at %s (src %s)',
        mirror.id, mirror.start.toISOString(), mirror.srcId || '<untagged>');
    return true;
  }
  try {
    withRetry_('Events.remove', function() {
      return Calendar.Events.remove(CONFIG.DEST_CALENDAR_ID, mirror.id);
    });
    return true;
  } catch (err) {
    if (/notFound|deleted/i.test(err.message)) {
      log_('mirror %s already gone; treating as deleted', mirror.id);
      return true;
    }
    log_('ERROR deleting mirror %s: %s', mirror.id, err.message);
    return false;
  }
}

function buildPayload_(want, tz, asOutOfOffice) {
  const payload = {
    summary: CONFIG.OOO_TITLE,
    start: timeField_(want.start, tz),
    end: timeField_(want.end, tz),
    transparency: 'opaque',
    visibility: CONFIG.EVENT_VISIBILITY,
    // Mirrored blocks are a scheduling signal, not something to be nagged about.
    reminders: {useDefault: false, overrides: []},
    extendedProperties: {private: privateProps_(want)},
  };
  if (asOutOfOffice) {
    payload.eventType = 'outOfOffice';
    payload.outOfOfficeProperties = {
      autoDeclineMode: want.autoDecline || CONFIG.AUTO_DECLINE_MODE,
      declineMessage: CONFIG.DECLINE_MESSAGE,
    };
  }
  return payload;
}

function privateProps_(want) {
  const props = {srcId: want.srcId, srcSig: want.sig};
  props[MIRROR_KEY] = MIRROR_VERSION;
  return props;
}

function timeField_(date, tz) {
  return {dateTime: date.toISOString(), timeZone: tz};
}

/**
 * Change-detection key. Beyond the source event's times it includes every
 * config-driven field written onto the block, so that changing OOO_TITLE,
 * EVENT_VISIBILITY or the auto-decline mode -- or a protected work event
 * appearing -- reconciles blocks that already exist.
 */
function signature_(start, end, autoDecline) {
  return [
    start.toISOString(),
    end.toISOString(),
    autoDecline,
    CONFIG.OOO_TITLE,
    CONFIG.EVENT_VISIBILITY,
  ].join('|');
}

function isOooRejection_(err) {
  return /outOfOffice|eventType|out of office|invalid.*event type/i.test(err.message || '');
}

// --- Plumbing ---------------------------------------------------------------

/** events.list with pagination folded in. */
function listAllEvents_(calendarId, params) {
  const all = [];
  let pageToken = null;
  do {
    const opts = Object.assign({}, params);
    if (pageToken) opts.pageToken = pageToken;
    const page = withRetry_('Events.list ' + calendarId, function() {
      return Calendar.Events.list(calendarId, opts);
    });
    (page.items || []).forEach(function(item) { all.push(item); });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all;
}

function resolveTimeZone_() {
  if (CONFIG.TIME_ZONE_OVERRIDE) return CONFIG.TIME_ZONE_OVERRIDE;
  try {
    const cal = withRetry_('Calendars.get', function() {
      return Calendar.Calendars.get(CONFIG.DEST_CALENDAR_ID);
    });
    if (cal && cal.timeZone) return cal.timeZone;
  } catch (err) {
    log_('WARN could not read destination calendar timezone (%s); using script timezone', err.message);
  }
  return Session.getScriptTimeZone();
}

/** Retry transient Calendar API failures with exponential backoff. */
function withRetry_(label, fn) {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isTransient_(err)) throw err;
      const waitMs = Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 250);
      log_('%s failed (attempt %s/%s): %s -- retrying in %sms',
          label, attempt, maxAttempts, err.message, waitMs);
      Utilities.sleep(waitMs);
    }
  }
}

function isTransient_(err) {
  const msg = String((err && err.message) || err);
  return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|backendError|internal error|try again|timed out|\b429\b|\b50[0234]\b/i.test(msg);
}

function log_(template) {
  // Utilities.formatString throws "Not enough arguments" on an undefined arg,
  // and the Calendar API omits any field sitting at its default value -- so
  // coerce before formatting rather than at every call site.
  const args = Array.prototype.slice.call(arguments, 1).map(function(arg) {
    return (arg === undefined || arg === null) ? String(arg) : arg;
  });
  console.log('[ooo-mirror] ' + (args.length ? Utilities.formatString(template, ...args) : template));
}
