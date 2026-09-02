// Minimal Apps Script stubs so the mirror logic can be exercised in Node.
const TZ = 'America/Costa_Rica';

global.Utilities = {
  formatString(t, ...a) {
    // Apps Script rejects undefined/null args with "Not enough arguments";
    // mimic that so log_ regressions surface in the tests.
    if (a.some(v => v === undefined || v === null)) throw new Error('Not enough arguments');
    let i = 0;
    return t.replace(/%s/g, () => String(a[i++]));
  },
  formatDate(date, tz, pattern) {
    if (pattern === 'yyyy-MM-dd') {
      return new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
    }
    if (pattern === 'Z') {
      const name = new Intl.DateTimeFormat('en-US', {timeZone: tz, timeZoneName: 'longOffset'})
          .formatToParts(date).find(p => p.type === 'timeZoneName').value; // "GMT-06:00"
      return name.replace('GMT', '').replace(':', '') || '+0000';
    }
    throw new Error('unstubbed pattern ' + pattern);
  },
  sleep() {},
};
global.LockService = {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})};
global.Session = {getScriptTimeZone: () => TZ};

// In-memory calendars.
const store = {source: [], dest: []};
let nextId = 1;
const which = id => (id === 'primary' ? 'dest' : 'source');

global.Calendar = {
  Calendars: {get: () => ({timeZone: TZ})},
  Events: {
    list(calId, opts) {
      const items = store[which(calId)].filter(ev => {
        const start = new Date(ev.start.dateTime || ev.start.date);
        if (opts.timeMin && start < new Date(opts.timeMin)) {
          const end = new Date(ev.end.dateTime || ev.end.date);
          if (end <= new Date(opts.timeMin)) return false;
        }
        if (opts.timeMax && start > new Date(opts.timeMax)) return false;
        if (opts.q) {
          const hay = ((ev.summary || '') + ' ' + (ev.description || '')).toLowerCase();
          if (hay.indexOf(opts.q.toLowerCase()) === -1) return false;
        }
        if (opts.privateExtendedProperty) {
          const [k, v] = opts.privateExtendedProperty.split('=');
          const p = (ev.extendedProperties && ev.extendedProperties.private) || {};
          if (p[k] !== v) return false;
        }
        return true;
      });
      return {items};
    },
    insert(payload, calId) {
      const ev = JSON.parse(JSON.stringify(payload));
      ev.id = 'dest-' + (nextId++);
      ev.status = 'confirmed';
      store[which(calId)].push(ev);
      return ev;
    },
    patch(patch, calId, id) {
      const ev = store[which(calId)].find(e => e.id === id);
      if (!ev) throw new Error('notFound');
      Object.assign(ev, JSON.parse(JSON.stringify(patch)));
      return ev;
    },
    remove(calId, id) {
      const arr = store[which(calId)];
      const i = arr.findIndex(e => e.id === id);
      if (i < 0) throw new Error('notFound: ' + id);
      arr.splice(i, 1);
    },
    get(calId, id) { return store[which(calId)].find(e => e.id === id); },
  },
};
global.__store = store;
