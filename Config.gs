/**
 * Configuration for the personal -> work out-of-office calendar mirror.
 *
 * Everything tunable lives in this file. Mirror.gs and Setup.gs only read it.
 */
const CONFIG = {
  // --- Calendars -------------------------------------------------------------

  /** Calendar to read personal commitments FROM. Never written to. */
  SOURCE_CALENDAR_ID: 'your-personal-calendar@gmail.com',

  /**
   * Calendar to write OOO blocks TO. The Calendar API only allows
   * eventType:'outOfOffice' on a primary calendar, so leave this as 'primary'
   * unless you also set FALLBACK_TO_BUSY_EVENT.
   */
  DEST_CALENDAR_ID: 'primary',

  /**
   * Timezone used to interpret work hours and to stamp created events.
   * Empty string means "ask the destination calendar at runtime" (recommended).
   */
  TIME_ZONE_OVERRIDE: '',

  // --- What the mirrored events look like ------------------------------------

  /** Title of every mirrored block. Deliberately generic: leaks nothing. */
  OOO_TITLE: 'Personal Commitment — OOO',

  /** 'default' | 'private'. 'private' shows coworkers only "busy", no title. */
  EVENT_VISIBILITY: 'default',

  /**
   * 'declineNone'
   *   | 'declineOnlyNewConflictingInvitations'  <- blocks future bookings only
   *   | 'declineAllConflictingInvitations'      <- also drops already-accepted meetings
   */
  AUTO_DECLINE_MODE: 'declineOnlyNewConflictingInvitations',

  DECLINE_MESSAGE: 'Auto-declined: I have a personal commitment at this time. Please grab another slot and I will be happy to meet.',

  /**
   * If the tenant rejects eventType:'outOfOffice' (it is not enabled for every
   * Workspace edition), fall back to a plain busy event. Still blocks
   * free/busy, but no auto-decline.
   */
  FALLBACK_TO_BUSY_EVENT: true,

  // --- Sync window -----------------------------------------------------------

  /** How far ahead to mirror. */
  WINDOW_DAYS_AHEAD: 60,

  /**
   * How far past windowEnd to look when hunting for orphaned mirrors. Orphans
   * beyond the source scan horizon are logged, never deleted.
   */
  CLEANUP_PAD_DAYS: 30,

  // --- Which source events qualify ------------------------------------------

  /** All-day events are skipped. Also an API requirement: OOO must be timed. */
  SKIP_ALL_DAY: true,

  /** Skip source events marked "Free" (transparency: 'transparent'). */
  SKIP_FREE_EVENTS: true,

  /** Skip source events the personal account has declined. */
  SKIP_DECLINED: true,

  /** Source event types that are not real commitments. */
  SKIP_EVENT_TYPES: ['workingLocation', 'birthday'],

  /** Ignore very short blips. */
  MIN_DURATION_MIN: 15,

  /** Put this in a personal event's title or description to exclude it. */
  OPT_OUT_KEYWORD: '#nomirror',

  /**
   * Work-calendar events you must never be auto-declined from, matched as
   * case-insensitive substrings of the title. A mirrored block that overlaps
   * one of these is created with autoDeclineMode:'declineNone' -- it still
   * shows you busy, it just declines nothing. Set to [] to disable the check
   * and save one API call per run.
   */
  PROTECTED_EVENT_TITLES: ['No Meeting Day'],

  /** Only mirror events that overlap working hours (below). Off by default. */
  WORK_HOURS_ONLY: false,
  WORK_START_HOUR: 9,
  WORK_END_HOUR: 17,

  // --- Safety ----------------------------------------------------------------

  /**
   * Abort rather than delete more than this many mirrors in one run. Guards
   * against a mass wipe caused by a transient permission loss or empty read.
   */
  MAX_DELETES_PER_RUN: 25,

  /**
   * Bypass the "source returned zero events" safety abort. Only set this true
   * for a single run, when you know the personal calendar really is empty.
   */
  ALLOW_EMPTY_SOURCE: false,

  /** Log what would happen; change nothing. */
  DRY_RUN: false,

  /** Must be flipped to true by hand before purgeAllMirrors() will delete. */
  ALLOW_PURGE: false,

  // --- Trigger ---------------------------------------------------------------

  SYNC_INTERVAL_MINUTES: 15,
};

/**
 * Marker written into extendedProperties.private of every event this script
 * creates. Used as a server-side list filter, so hand-made OOO events on the
 * work calendar are never touched. Bumping the version orphans old mirrors --
 * run purgeAllMirrors() first if you ever change it.
 */
const MIRROR_KEY = 'oooMirror';
const MIRROR_VERSION = 'v1';

/** Handler name the time-based trigger points at. */
const SYNC_HANDLER = 'syncOooMirror';
