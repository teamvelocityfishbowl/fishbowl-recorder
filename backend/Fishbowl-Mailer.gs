/**
 * Fishbowl Mailer: sends the Fishbowl emails and calendar invites FROM this account.
 *
 * Why: emails from the Fishbowl Gmail land in coworkers' spam. This tiny script lives in a
 * company Google account (e.g. fishbowl@teamvelocitymarketing.com), so every invite, nudge and
 * redo request comes from inside the company. Everything else (sheet, Drive, recorder) stays put.
 *
 * Setup (about 5 minutes, signed in as the company account):
 *   1. script.google.com → New project → name it "Fishbowl Mailer" → paste this whole file → Save.
 *   2. Run "authorize" once (▶ Run) and approve the permissions (email + calendar).
 *   3. Deploy → New deployment → type: Web app → Execute as: Me · Who has access: Anyone → Deploy.
 *   4. Copy the Web app URL. In the Fishbowl tracker: 🐟 Fishbowl → ⚙️ Setup & troubleshooting →
 *      "Connect company email sender…" and paste it.
 *
 * Safety locks:
 *   - Only the tracker that connects first can use it (it's paired with a secret key).
 *     To pair a different tracker, run "resetPairing" here, then connect again from the tracker.
 *   - It only sends to company addresses (ALLOWED_DOMAINS). Anything else is refused.
 *   - At most DAILY_LIMIT emails + invites a day.
 *   - Every send (and every refused attempt) is written to the "Fishbowl Mailer Log" sheet in
 *     this account's Drive, so you can always see what went out under this address.
 */

const ALLOWED_DOMAINS = ['teamvelocitymarketing.com'];
const DAILY_LIMIT = 150;

function authorize() {
  // Touches mail, calendar + the log sheet so Google asks for every permission now, not during a real send.
  MailApp.getRemainingDailyQuota();
  CalendarApp.getDefaultCalendar().getName();
  const log = logSheet_();
  Logger.log('Ready. Sending as ' + Session.getEffectiveUser().getEmail() + '. Every send is logged here: ' +
    log.getParent().getUrl() + '\nNext: Deploy → New deployment → Web app.');
}

function resetPairing() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  Logger.log('Unpaired. Connect from the tracker again.');
}

function doGet() {
  return ContentService.createTextOutput('🐟 Fishbowl Mailer is running. Paste this page\'s address into the tracker: ' +
    '🐟 Fishbowl → ⚙️ Setup & troubleshooting → Connect company email sender…');
}

function doPost(e) {
  let out;
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle_(b);
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(b) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('KEY');
  const given = String(b.key || '');
  if (given.length < 24) throw new Error('Missing key');

  if (b.action === 'pair') {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const now = props.getProperty('KEY');
      if (now && now !== given) throw new Error('This mailer is already connected to another tracker. Run resetPairing in the mailer script first.');
      props.setProperty('KEY', given);
    } finally { lock.releaseLock(); }
    return info_();
  }

  if (!key || key !== given) throw new Error('Not connected: use "Connect company email sender…" in the tracker.');

  if (b.action === 'ping') return info_();

  if (b.action === 'mail') {
    const m = b.msg || {};
    if (!m.to || !m.subject) throw new Error('Email needs a "to" and a subject');
    const msg = { to: String(m.to), subject: String(m.subject).slice(0, 250) };
    ['cc', 'bcc', 'htmlBody', 'body', 'name', 'replyTo'].forEach(k => { if (m[k]) msg[k] = String(m[k]); });
    checkAddresses_('Email', [msg.to, msg.cc, msg.bcc, msg.replyTo], msg);
    countToday_('Email', msg);
    if (!msg.body) msg.body = String(msg.htmlBody || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    MailApp.sendEmail(msg);
    log_('Email', msg, 'Sent');
    return { ok: true, from: Session.getEffectiveUser().getEmail() };
  }

  if (b.action === 'event') {
    const ev = b.event || {};
    const d = String(ev.date || '').split('-').map(Number); // yyyy-mm-dd
    if (d.length !== 3 || !d[0]) throw new Error('Bad event date');
    const entry = { to: String(ev.guests || ''), subject: String(ev.title || 'Fishbowl') + ' (' + ev.date + ')' };
    checkAddresses_('Invite', [entry.to], entry);
    countToday_('Invite', entry);
    const created = CalendarApp.getDefaultCalendar().createAllDayEvent(String(ev.title || 'Fishbowl'), new Date(d[0], d[1] - 1, d[2]), {
      description: String(ev.description || ''),
      location: String(ev.location || ''),
      guests: String(ev.guests || ''),
      sendInvites: true,
    });
    log_('Invite', entry, 'Sent');
    return { ok: true, id: created.getId() };
  }

  throw new Error('Unknown action');
}

function info_() {
  let logUrl = '';
  try { logUrl = logSheet_().getParent().getUrl(); } catch (e) {}
  return { ok: true, email: Session.getEffectiveUser().getEmail(), quota: MailApp.getRemainingDailyQuota(),
           allowed: ALLOWED_DOMAINS, dailyLimit: DAILY_LIMIT, logUrl: logUrl };
}

/** Lock 1: every recipient must be a company address. */
function checkAddresses_(type, fields, entry) {
  const addrs = fields.filter(Boolean).join(',').split(/[,;]/).map(a => a.trim()).filter(Boolean)
    .map(a => { const m = a.match(/<([^>]+)>/); return (m ? m[1] : a).trim().toLowerCase(); });
  if (!addrs.length) throw new Error(type + ' has no recipient');
  const bad = addrs.filter(a => !/^[^@\s]+@[^@\s]+$/.test(a) || ALLOWED_DOMAINS.indexOf(a.split('@')[1]) === -1);
  if (bad.length) {
    log_(type, entry, 'REFUSED: not a company address (' + bad.join(', ') + ')');
    throw new Error('Refused: this mailer only sends to @' + ALLOWED_DOMAINS.join(', @') + ' addresses (' + bad.join(', ') + ')');
  }
}

/** Lock 2: at most DAILY_LIMIT emails + invites per day. */
function countToday_(type, entry) {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const key = 'COUNT_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const n = Number(props.getProperty(key)) || 0;
    if (n >= DAILY_LIMIT) {
      log_(type, entry, 'REFUSED: daily limit of ' + DAILY_LIMIT + ' reached');
      throw new Error('Refused: the mailer\'s daily limit (' + DAILY_LIMIT + ') is reached. It resets tomorrow.');
    }
    props.setProperty(key, String(n + 1));
    Object.keys(props.getProperties()).filter(k => k.indexOf('COUNT_') === 0 && k < key).forEach(k => props.deleteProperty(k));
  } finally { lock.releaseLock(); }
}

/** The "Fishbowl Mailer Log" sheet in this account's Drive (made on first use). */
function logSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('LOG_ID');
  if (id) { try { return SpreadsheetApp.openById(id).getSheets()[0]; } catch (e) {} }
  const ss = SpreadsheetApp.create('Fishbowl Mailer Log');
  const sh = ss.getSheets()[0];
  sh.appendRow(['When', 'Type', 'To', 'CC', 'Subject', 'Result']);
  sh.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#082642').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.setColumnWidth(3, 240); sh.setColumnWidth(5, 320); sh.setColumnWidth(6, 260);
  props.setProperty('LOG_ID', ss.getId());
  return sh;
}

function log_(type, m, result) {
  try {
    const clip = v => String(v || '').slice(0, 300);
    logSheet_().appendRow([new Date(), type, clip(m.to), clip(m.cc), clip(m.subject), result]);
  } catch (e) { /* logging never blocks a send */ }
}
