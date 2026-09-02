
const store = global.__store;
const H = 60 * 60 * 1000;
const soon = off => new Date(Date.now() + off).toISOString();
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}

CONFIG.SOURCE_CALENDAR_ID = 'personal@gmail.com';
CONFIG.WORK_HOURS_ONLY = false;

const qualifying = {
  id: 'src-keep', status: 'confirmed', summary: 'Dentist',
  start: {dateTime: soon(48 * H)}, end: {dateTime: soon(49 * H)},
};
store.source.push(
  qualifying,
  {id: 'src-allday', status: 'confirmed', summary: 'Vacation',
   start: {date: '2026-09-10'}, end: {date: '2026-09-12'}},
  {id: 'src-free', status: 'confirmed', summary: 'FYI', transparency: 'transparent',
   start: {dateTime: soon(50 * H)}, end: {dateTime: soon(51 * H)}},
  {id: 'src-declined', status: 'confirmed', summary: 'Party',
   attendees: [{email: 'personal@gmail.com', responseStatus: 'declined'}],
   start: {dateTime: soon(52 * H)}, end: {dateTime: soon(53 * H)}},
  {id: 'src-optout', status: 'confirmed', summary: 'Gym #nomirror',
   start: {dateTime: soon(54 * H)}, end: {dateTime: soon(55 * H)}},
  {id: 'src-optout-desc', status: 'confirmed', summary: 'Standing call',
   description: 'happy to move this one\n#NoMirror',
   start: {dateTime: soon(58 * H)}, end: {dateTime: soon(59 * H)}},
  {id: 'src-short', status: 'confirmed', summary: 'Blip',
   start: {dateTime: soon(56 * H)}, end: {dateTime: soon(56 * H + 5 * 60 * 1000)}},
  {id: 'src-past', status: 'confirmed', summary: 'Yesterday',
   start: {dateTime: soon(-48 * H)}, end: {dateTime: soon(-47 * H)}},
  {id: 'src-worklocation', status: 'confirmed', eventType: 'workingLocation', summary: 'Home',
   start: {dateTime: soon(57 * H)}, end: {dateTime: soon(58 * H)}},
  {id: 'src-birthday', status: 'confirmed', eventType: 'birthday', summary: 'Bday',
   start: {date: '2026-09-15'}, end: {date: '2026-09-16'}},
);

console.log('\n--- run 1: only the qualifying event should mirror ---');
check('run 1 stats', syncOooMirror(), {created: 1, updated: 0, deleted: 0, unchanged: 0, failed: 0});
check('one mirror on dest', store.dest.length, 1);
const m = store.dest[0];
check('title is generic', m.summary, CONFIG.OOO_TITLE);
check('no source detail leaked', [m.description, m.location], [undefined, undefined]);
check('eventType', m.eventType, 'outOfOffice');
check('transparency', m.transparency, 'opaque');
check('autoDecline', m.outOfOfficeProperties.autoDeclineMode, 'declineOnlyNewConflictingInvitations');
check('marker + srcId', [m.extendedProperties.private.oooMirror, m.extendedProperties.private.srcId], ['v1', 'src-keep']);
check('times match source', [m.start.dateTime, m.end.dateTime],
      [new Date(qualifying.start.dateTime).toISOString(), new Date(qualifying.end.dateTime).toISOString()]);

console.log('\n--- run 2: idempotent, no churn ---');
check('run 2 stats', syncOooMirror(), {created: 0, updated: 0, deleted: 0, unchanged: 1, failed: 0});
check('still one mirror', store.dest.length, 1);
check('same mirror id', store.dest[0].id, m.id);

console.log('\n--- run 3: source event moved -> mirror patched in place ---');
qualifying.start.dateTime = soon(72 * H);
qualifying.end.dateTime = soon(73 * H);
check('run 3 stats', syncOooMirror(), {created: 0, updated: 1, deleted: 0, unchanged: 0, failed: 0});
check('mirror moved', store.dest[0].start.dateTime, new Date(qualifying.start.dateTime).toISOString());
check('mirror id unchanged', store.dest[0].id, m.id);
check('marker survived patch', store.dest[0].extendedProperties.private.oooMirror, 'v1');

console.log('\n--- run 4: source event marked Free -> mirror removed ---');
qualifying.transparency = 'transparent';
check('run 4 stats', syncOooMirror(), {created: 0, updated: 0, deleted: 1, unchanged: 0, failed: 0});
check('dest empty', store.dest.length, 0);

console.log('\n--- run 5: source deleted entirely -> nothing to do, no crash ---');
delete qualifying.transparency;
check('run 5 recreates', syncOooMirror(), {created: 1, updated: 0, deleted: 0, unchanged: 0, failed: 0});
store.source.splice(store.source.indexOf(qualifying), 1);
check('run 6 deletes orphan', syncOooMirror(), {created: 0, updated: 0, deleted: 1, unchanged: 0, failed: 0});

console.log('\n--- run 7: total access loss -> refuse to delete ---');
store.dest.push({id: 'dest-x', status: 'confirmed', summary: CONFIG.OOO_TITLE,
  start: {dateTime: soon(24 * H)}, end: {dateTime: soon(25 * H)},
  extendedProperties: {private: {oooMirror: 'v1', srcId: 'src-vanished', srcSig: 'x'}}});
const saved = store.source.splice(0, store.source.length);
let threw = '';
try { syncOooMirror(); } catch (e) { threw = e.message; }
check('aborted on empty source', /refusing to\s+delete/.test(threw), true);
check('mirror preserved', store.dest.length, 1);
store.source.push(...saved);

console.log('\n--- run 8: blast-radius guard ---');
CONFIG.MAX_DELETES_PER_RUN = 0;
threw = '';
try { syncOooMirror(); } catch (e) { threw = e.message; }
check('aborted on mass delete', /MAX_DELETES_PER_RUN/.test(threw), true);
CONFIG.MAX_DELETES_PER_RUN = 25;

console.log('\n--- run 9: work-hours filter ---');
CONFIG.WORK_HOURS_ONLY = true;
store.dest.length = 0;
store.source.length = 0;
// 03:00-04:00 local, tomorrow: outside 09:00-17:00 -> skipped
const tomorrow = new Date(Date.now() + 24 * H);
const day = Utilities.formatDate(tomorrow, 'America/Costa_Rica', 'yyyy-MM-dd');
store.source.push({id: 'src-night', status: 'confirmed', summary: 'Late',
  start: {dateTime: `${day}T03:00:00-06:00`}, end: {dateTime: `${day}T04:00:00-06:00`}});
check('night event skipped', syncOooMirror(), {created: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0});
store.source.push({id: 'src-noon', status: 'confirmed', summary: 'Noon',
  start: {dateTime: `${day}T12:00:00-06:00`}, end: {dateTime: `${day}T13:00:00-06:00`}});
check('noon event mirrored', syncOooMirror(), {created: 1, updated: 0, deleted: 0, unchanged: 0, failed: 0});

console.log('\n--- run 10: OOO rejected by tenant -> busy-event fallback ---');
CONFIG.WORK_HOURS_ONLY = false;
store.dest.length = 0;
store.source.length = 0;
store.source.push({id: 'src-fb', status: 'confirmed', summary: 'Thing',
  start: {dateTime: soon(30 * H)}, end: {dateTime: soon(31 * H)}});
const realInsert = Calendar.Events.insert;
Calendar.Events.insert = function(payload, calId) {
  if (payload.eventType === 'outOfOffice') throw new Error('Invalid eventType outOfOffice for this account');
  return realInsert(payload, calId);
};
check('fallback created', syncOooMirror(), {created: 1, updated: 0, deleted: 0, unchanged: 0, failed: 0});
check('fell back to plain busy', [store.dest[0].eventType, store.dest[0].transparency], [undefined, 'opaque']);
check('marker still present', store.dest[0].extendedProperties.private.oooMirror, 'v1');
Calendar.Events.insert = realInsert;

console.log('\n--- protected work events suppress auto-decline ---');
store.dest.length = 0;
store.source.length = 0;
const nmdDay = Utilities.formatDate(new Date(Date.now() + 40 * H), 'America/Costa_Rica', 'yyyy-MM-dd');
const nmdNext = new Date(new Date(nmdDay + 'T12:00:00Z').getTime() + 24 * H).toISOString().slice(0, 10);
// All-day "No Meeting Day!" on the work calendar, not one of our mirrors.
store.dest.push({id: 'nmd', status: 'confirmed', summary: 'No Meeting Day!',
  start: {date: nmdDay}, end: {date: nmdNext}});
store.source.push({id: 'src-on-nmd', status: 'confirmed', summary: 'Errand',
  start: {dateTime: `${nmdDay}T14:00:00-06:00`}, end: {dateTime: `${nmdDay}T15:00:00-06:00`}});

check('block created on protected day', syncOooMirror(), {created: 1, updated: 0, deleted: 0, unchanged: 0, failed: 0});
const guarded = store.dest.find(e => e.extendedProperties);
check('auto-decline suppressed', guarded.outOfOfficeProperties.autoDeclineMode, 'declineNone');
check('still busy', guarded.transparency, 'opaque');
check('protected event untouched', store.dest.filter(e => e.id === 'nmd').length, 1);
check('no churn while protected', syncOooMirror(), {created: 0, updated: 0, deleted: 0, unchanged: 1, failed: 0});

// Protected event goes away -> the block must get its auto-decline back.
store.dest.splice(store.dest.findIndex(e => e.id === 'nmd'), 1);
check('reconciles when protection lifts', syncOooMirror(), {created: 0, updated: 1, deleted: 0, unchanged: 0, failed: 0});
check('auto-decline restored', guarded.outOfOfficeProperties.autoDeclineMode, 'declineOnlyNewConflictingInvitations');

// A personal event on an adjacent day must NOT be suppressed: all-day bounds
// are resolved to local midnight, not UTC midnight.
store.dest.length = 0;
store.source.length = 0;
store.dest.push({id: 'nmd2', status: 'confirmed', summary: 'No Meeting Day!',
  start: {date: nmdDay}, end: {date: nmdNext}});
store.source.push({id: 'src-day-after', status: 'confirmed', summary: 'Errand',
  start: {dateTime: `${nmdNext}T14:00:00-06:00`}, end: {dateTime: `${nmdNext}T15:00:00-06:00`}});
syncOooMirror();
const adjacent = store.dest.find(e => e.extendedProperties);
check('adjacent day keeps auto-decline', adjacent.outOfOfficeProperties.autoDeclineMode, 'declineOnlyNewConflictingInvitations');

// Late-evening event on the protected day: 20:00-21:00 local is 02:00-03:00 UTC
// the NEXT day, so a UTC-midnight bound would have missed it.
store.dest.length = 0;
store.source.length = 0;
store.dest.push({id: 'nmd3', status: 'confirmed', summary: 'No Meeting Day!',
  start: {date: nmdDay}, end: {date: nmdNext}});
store.source.push({id: 'src-late', status: 'confirmed', summary: 'Evening thing',
  start: {dateTime: `${nmdDay}T20:00:00-06:00`}, end: {dateTime: `${nmdDay}T21:00:00-06:00`}});
syncOooMirror();
const late = store.dest.find(e => e.extendedProperties);
check('late evening on protected day suppressed', late.outOfOfficeProperties.autoDeclineMode, 'declineNone');

// The real "No Meeting Day!" is a timed recurring event from the People team,
// so instances arrive expanded, with instance-style IDs and real start/end times.
store.dest.length = 0;
store.source.length = 0;
store.dest.push({id: 'nmdseries_20261012T150000Z', status: 'confirmed', summary: 'No Meeting Day!',
  start: {dateTime: `${nmdDay}T09:00:00-06:00`}, end: {dateTime: `${nmdDay}T17:00:00-06:00`}});
store.source.push(
  {id: 'src-inside', status: 'confirmed', summary: 'Errand',
   start: {dateTime: `${nmdDay}T14:00:00-06:00`}, end: {dateTime: `${nmdDay}T15:00:00-06:00`}},
  {id: 'src-outside', status: 'confirmed', summary: 'Evening thing',
   start: {dateTime: `${nmdDay}T19:00:00-06:00`}, end: {dateTime: `${nmdDay}T20:00:00-06:00`}},
);
syncOooMirror();
const inside = store.dest.find(e => e.extendedProperties && e.extendedProperties.private.srcId === 'src-inside');
const outside = store.dest.find(e => e.extendedProperties && e.extendedProperties.private.srcId === 'src-outside');
check('timed recurring instance suppresses overlap', inside.outOfOfficeProperties.autoDeclineMode, 'declineNone');
check('outside its hours keeps auto-decline', outside.outOfOfficeProperties.autoDeclineMode, 'declineOnlyNewConflictingInvitations');

console.log('\n--- config changes reconcile existing blocks ---');
store.dest.length = 0;
store.source.length = 0;
store.source.push({id: 'src-rename', status: 'confirmed', summary: 'Thing',
  start: {dateTime: soon(30 * H)}, end: {dateTime: soon(31 * H)}});
syncOooMirror();
const renamed = store.dest.find(e => e.extendedProperties);
check('created with configured title', renamed.summary, CONFIG.OOO_TITLE);
CONFIG.OOO_TITLE = 'Renamed — OOO';
check('title change triggers update', syncOooMirror(), {created: 0, updated: 1, deleted: 0, unchanged: 0, failed: 0});
check('existing block renamed in place', renamed.summary, 'Renamed — OOO');
check('same event, not recreated', store.dest.filter(e => e.extendedProperties).length, 1);
CONFIG.EVENT_VISIBILITY = 'private';
check('visibility change triggers update', syncOooMirror(), {created: 0, updated: 1, deleted: 0, unchanged: 0, failed: 0});
check('visibility applied', renamed.visibility, 'private');

console.log('\n--- log_ tolerates fields the API omits ---');
let logThrew = '';
try { log_('a=%s b=%s', undefined, null); } catch (e) { logThrew = e.message; }
check('undefined/null args do not throw', logThrew, '');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
