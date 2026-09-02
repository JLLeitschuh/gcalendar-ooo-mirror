/**
 * One-off helpers: run these by hand from the Apps Script editor.
 *
 * Recommended order the first time:
 *   1. listCalendars()      -- confirm the source calendar ID and access level
 *   2. probeOooSupport()    -- confirm this account can create OOO events
 *   3. previewSync()        -- dry run; read the log
 *   4. syncOooMirror()      -- for real, once
 *   5. installTrigger()     -- hand it over to the scheduler
 */

/** Print every calendar this account can see, with its access role. */
function listCalendars() {
  let pageToken = null;
  do {
    const page = Calendar.CalendarList.list({maxResults: 250, pageToken: pageToken});
    (page.items || []).forEach(function(cal) {
      log_('%s | access=%s | tz=%s | primary=%s | %s',
          cal.id, cal.accessRole, cal.timeZone, !!cal.primary, cal.summary);
    });
    pageToken = page.nextPageToken;
  } while (pageToken);
}

/**
 * Create one throwaway out-of-office event far in the future, read it back to
 * see which fields actually survived, then delete it.
 *
 * The sync engine identifies its own events by extendedProperties.private, so
 * if that field does not round-trip on an outOfOffice event, the mirror cannot
 * reconcile and this must be resolved before installing the trigger.
 */
function probeOooSupport() {
  const tz = resolveTimeZone_();
  const start = new Date(Date.now() + 365 * DAY_MS);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 60 * MIN_MS);

  const probe = buildPayload_(
      {srcId: 'probe-' + Date.now(), start: start, end: end,
       autoDecline: CONFIG.AUTO_DECLINE_MODE,
       sig: signature_(start, end, CONFIG.AUTO_DECLINE_MODE)},
      tz, true);
  probe.summary = 'OOO mirror probe (delete me)';

  let created = null;
  try {
    created = Calendar.Events.insert(probe, CONFIG.DEST_CALENDAR_ID);
  } catch (err) {
    log_('FAIL could not create an outOfOffice event: %s', err.message);
    log_('If FALLBACK_TO_BUSY_EVENT is true the mirror will still work, using plain busy events (no auto-decline).');
    return false;
  }

  try {
    const readBack = Calendar.Events.get(CONFIG.DEST_CALENDAR_ID, created.id);
    const props = (readBack.extendedProperties && readBack.extendedProperties.private) || {};
    const ooo = readBack.outOfOfficeProperties || {};

    log_('eventType            = %s (want outOfOffice)', readBack.eventType);
    // The API omits fields left at their default, so a missing transparency
    // means 'opaque' -- which is what we asked for.
    log_('transparency         = %s (want opaque)',
        readBack.transparency || 'opaque (field omitted = default)');
    log_('autoDeclineMode      = %s (want %s)', ooo.autoDeclineMode, CONFIG.AUTO_DECLINE_MODE);
    log_('declineMessage kept  = %s', !!ooo.declineMessage);
    log_('extendedProperties   = %s', JSON.stringify(props));

    const ok = readBack.eventType === 'outOfOffice' && !!props[MIRROR_KEY] && !!props.srcId;
    log_(ok ? 'PASS out-of-office mirroring is fully supported on this account'
            : 'FAIL required fields did not survive -- do not install the trigger yet');
    return ok;
  } finally {
    Calendar.Events.remove(CONFIG.DEST_CALENDAR_ID, created.id);
    log_('probe event deleted');
  }
}

/** Install (or reinstall) the recurring sync trigger. */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger(SYNC_HANDLER)
      .timeBased()
      .everyMinutes(CONFIG.SYNC_INTERVAL_MINUTES)
      .create();
  log_('trigger installed: %s every %s minutes', SYNC_HANDLER, CONFIG.SYNC_INTERVAL_MINUTES);
}

/** Remove the recurring sync trigger. Leaves existing mirrors in place. */
function removeTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === SYNC_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  log_('%s trigger(s) removed', removed);
}

/** List every mirrored event on the destination calendar, past and future. */
function previewPurge() {
  const mirrors = allMirrorsEver_();
  mirrors.forEach(function(ev) {
    log_('%s | %s | %s', ev.id, (ev.start.dateTime || ev.start.date), ev.summary);
  });
  log_('%s mirrored event(s) total. Set CONFIG.ALLOW_PURGE = true then run purgeAllMirrors() to delete them.',
      mirrors.length);
  return mirrors.length;
}

/**
 * Delete every event this script created -- the clean-uninstall path. Only
 * touches events carrying our extended-property marker.
 */
function purgeAllMirrors() {
  if (!CONFIG.ALLOW_PURGE) {
    log_('refusing to purge: set CONFIG.ALLOW_PURGE = true in Config.gs first (run previewPurge() to see what would go)');
    return 0;
  }
  const mirrors = allMirrorsEver_();
  let deleted = 0;
  mirrors.forEach(function(ev) {
    try {
      withRetry_('Events.remove', function() {
        return Calendar.Events.remove(CONFIG.DEST_CALENDAR_ID, ev.id);
      });
      deleted++;
    } catch (err) {
      log_('ERROR deleting %s: %s', ev.id, err.message);
    }
  });
  log_('purged %s of %s mirrored event(s)', deleted, mirrors.length);
  return deleted;
}

function allMirrorsEver_() {
  return listAllEvents_(CONFIG.DEST_CALENDAR_ID, {
    timeMin: new Date(Date.now() - 365 * DAY_MS).toISOString(),
    timeMax: new Date(Date.now() + 730 * DAY_MS).toISOString(),
    privateExtendedProperty: MIRROR_KEY + '=' + MIRROR_VERSION,
    showDeleted: false,
    singleEvents: true,
    maxResults: 2500,
  });
}
