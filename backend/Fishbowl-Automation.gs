/**
 * THE FISHBOWL: recording invites + reminders
 * ------------------------------------------------------------
 * Paste this into the participants sheet: Extensions > Apps Script.
 * Fill in CONFIG below, save, reload the sheet, and use the new
 * "🐟 Fishbowl" menu.
 *
 * What it does:
 *   1. Sends each tribute an all-day "record your Fishbowl" calendar event on
 *      their recording day (Outlook-compatible), with their personal VideoAsk link.
 *   2. Emails them the morning of their recording day.
 *   3. If the day passes with no video, nudges them every few business days
 *      (CCs their manager from the 2nd nudge, if a Manager Email is listed).
 *   4. After the last nudge, flags them "Needs a human" and emails you.
 *   5. When VideoAsk reports they've finished, marks VIDEO RECEIVED
 *      and stops all reminders.
 */

// ============ CONFIG: edit these ============
const CONFIG = {
  SHEET_NAME: 'Sheet1',

  // Which recorder the invite links open: 'custom' (our free Fishbowl Recorder) or 'videoask'.
  RECORDER: 'custom',

  // The Fishbowl Recorder page on GitHub Pages (GitHub account: teamvelocityfishbowl).
  RECORDER_URL: 'https://teamvelocityfishbowl.github.io/fishbowl-recorder/',

  // Google Drive folder (in this account's Drive) where recordings are saved.
  DRIVE_FOLDER_NAME: 'Fishbowl 2027',

  // Your VideoAsk share link (only used when RECORDER is 'videoask').
  VIDEOASK_URL: 'https://www.videoask.com/fuusftovp', // The Fishbowl 2027 videoask

  // Who gets escalations + the Monday summary. Blank = the account running the script.
  ADMIN_EMAIL: 'teamvelocity.fishbowl@gmail.com',

  // Shown as the sender name on reminder emails.
  SENDER_NAME: 'The Fishbowl',

  // true = once automation is on, ticked rows (with Email + Record Date) are sent automatically
  // every ~10 min from the Fishbowl account, so editors signed into their own accounts can send.
  // false = invites only go out when someone clicks 🐟 Fishbowl → 3. Send invites (Fishbowl account).
  AUTO_SEND_TICKED: false,

  // Nagging rules
  REMINDER_EVERY_BUSINESS_DAYS: 2, // gap between nudges after a missed recording day
  MAX_REMINDERS: 4,                // after this many, flag "Needs a human"
  CC_MANAGER_FROM_REMINDER: 2,     // start CC'ing their manager on this nudge

  // Hour (0-23) the daily check runs, in the script's time zone (Pacific).
  // 6 AM Pacific = 9 AM Eastern, so morning-of emails land at the start of the East Coast day.
  DAILY_CHECK_HOUR: 6,

  // Any random string. It goes on the end of the webhook URL so only VideoAsk can mark rows.
  WEBHOOK_KEY: 'change-me-to-a-random-string',

  // Optional extra line in every invite/reminder (e.g. a link to the question doc)
  EXTRA_NOTE: '',
};
// ============================================

// Column headers the script uses (matched case-insensitively).
// Existing columns are kept; missing ones are added by "Set up columns".
const COL = {
  SEND: 'Send?',
  NAME: 'Employees',
  EMAIL: 'Email',
  MANAGER: 'Manager Email',
  MONTH: 'Month',
  DATE: 'Record Date',
  STATUS: 'Status',
  SENT: 'Request Sent',
  RECEIVED: 'VIDEO RECEIVED',
  REMINDERS: 'Reminders Sent',
  LAST: 'Last Reminder',
  FOLDER: 'Drive Folder',
  EVENT_ID: 'Event ID',
  TOKEN: 'Link Token',
};

const STATUS = {
  NOT_INVITED: 'Not invited',
  INVITED: 'Invited',
  DAY_OF: 'Day-of nudge sent',
  STARTED: 'Started, not finished',
  NEEDS_HUMAN: 'Needs a human',
  RECEIVED: 'Received ✅',
};

// Fishbowl palette (pulled from the video's teal cards + splash aqua)
const THEME = {
  FONT: 'Roboto',
  NAVY: '#123247',      // tracking headers, body text
  TEAL_DARK: '#0E7C86', // people headers
  TEAL: '#16A6A8',      // scheduling headers, tab color
  AQUA: '#5CE1F5',      // the "Send?" action column
  BAND: '#F2FAFB',      // alternating rows
  LINE: '#D5ECEF',
  // [row tint, status-cell fill, status-cell text]
  RECEIVED: ['#E3F6EA', '#BFE8CF', '#1E6B3A'],
  WAITING:  ['#FFF6DD', '#FFE59A', '#7A5A00'],
  HUMAN:    ['#FDE7E6', '#F7BDB8', '#8A1C14'],
  INVITED:  [null,      '#D3F1F4', '#0E5F66'],
  NOT_YET:  [null,      null,      '#8A97A0'],
};

// Display order + header group + column width
const LAYOUT = [
  [COL.SEND,      'action', 64],
  [COL.NAME,      'people', 170],
  [COL.EMAIL,     'people', 250],
  [COL.MANAGER,   'people', 220],
  [COL.MONTH,     'people', 110],
  [COL.DATE,      'schedule', 150],
  [COL.STATUS,    'track', 170],
  [COL.SENT,      'track', 115],
  [COL.RECEIVED,  'track', 135],
  [COL.REMINDERS, 'track', 110],
  [COL.LAST,      'track', 120],
  [COL.FOLDER,    'track', 130],
  [COL.EVENT_ID,  'track', 100],
  [COL.TOKEN,     'track', 100],
];

// ------------------------------------------------------------
// Menu
// ------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🐟 Fishbowl')
    .addItem('➕ Add a new tribute…', 'showAddTribute')
    .addSeparator()
    .addItem('1. Set up / restyle sheet', 'setupColumns')
    .addItem('2. Send test invite + emails to me', 'sendTestToMe')
    .addItem('3. Send invites to ticked rows', 'sendInvites')
    .addSeparator()
    .addItem(CONFIG.AUTO_SEND_TICKED ? 'Turn on automation (auto-send + reminders)' : 'Turn on daily reminders', 'installDailyTrigger')
    .addItem('Turn off daily reminders', 'turnOffReminders')
    .addItem('Run reminder check now', 'runReminderCheckNow')
    .addItem('Mark selected row(s) as received', 'markSelectedReceived')
    .addItem('Show recording link for selected row', 'showSelectedLink')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🧪 Testing')
      .addItem('Fast-forward selected row (next check sends next reminder)', 'testFastForwardSelected')
      .addItem('Simulate VideoAsk finish for selected row', 'testSimulateWebhookSelected')
      .addItem('Run diagnostics (email + calendar check)', 'testDiagnostics'))
    .addToUi();
}

// ------------------------------------------------------------
// 1. Setup + styling (safe to re-run any time)
// ------------------------------------------------------------
function setupColumns() {
  if (!checkSender_()) return;
  const sh = getSheet_();
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(tz_()); // keep sheet + script clocks in sync
  ss.setRecalculationInterval(SpreadsheetApp.RecalculationInterval.HOUR); // keeps the status banner fresh
  if (headerRow_(sh) === 1) { sh.insertRowBefore(1); } // make room for the status banner
  const HR = headerRow_(sh);
  migrateRecordSlot_(sh);

  // Add any missing headers
  let map = headerMap_(sh);
  LAYOUT.forEach(([h]) => {
    if (map[norm_(h)] === undefined) {
      sh.getRange(HR, sh.getLastColumn() + 1).setValue(h);
      map = headerMap_(sh);
    }
  });

  // Put columns in a tidy order (data moves with them; extra columns of yours end up on the right)
  LAYOUT.forEach(([h], i) => {
    const cur = headerMap_(sh)[norm_(h)] + 1;
    if (cur !== i + 1) sh.moveColumns(sh.getRange(HR, cur), i + 1);
  });
  map = headerMap_(sh);
  const c = h => map[norm_(h)] + 1;
  const letter = h => columnLetter_(c(h));

  // Size of the styled area: everyone listed + 25 spare rows
  const named = rows_(sh);
  const lastRow = (named.length ? named[named.length - 1].row : HR) + 25;
  if (sh.getMaxRows() < lastRow) sh.insertRowsAfter(sh.getMaxRows(), lastRow - sh.getMaxRows());
  const first = HR + 1;
  const n = lastRow - HR;
  const width = LAYOUT.length;
  const body = sh.getRange(first, 1, n, width);

  // Base look
  sh.setHiddenGridlines(true);
  sh.setTabColor(THEME.TEAL);
  sh.getRange(1, 1, lastRow, width).setFontFamily(THEME.FONT).setVerticalAlignment('middle');
  body.setFontColor(THEME.NAVY).setFontSize(10)
      .setBorder(null, null, true, null, null, true, THEME.LINE, SpreadsheetApp.BorderStyle.SOLID);
  sh.setRowHeights(first, n, 30);

  // Header row, color-grouped
  const groupColor = { action: [THEME.AQUA, THEME.NAVY], people: [THEME.TEAL_DARK, '#FFFFFF'],
                       schedule: [THEME.TEAL, '#FFFFFF'], track: [THEME.NAVY, '#FFFFFF'] };
  sh.setRowHeight(HR, 42);
  LAYOUT.forEach(([h, group, w]) => {
    const [bg, fg] = groupColor[group];
    sh.getRange(HR, c(h)).setBackground(bg).setFontColor(fg).setFontWeight('bold').setFontSize(10)
      .setWrap(true).setHorizontalAlignment(h === COL.SEND ? 'center' : 'left');
    sh.setColumnWidth(c(h), w);
  });
  sh.setFrozenRows(HR);
  sh.setFrozenColumns(c(COL.NAME));

  // Alternating rows
  sh.getBandings().forEach(b => b.remove());
  body.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false)
      .setFirstRowColor('#FFFFFF').setSecondRowColor(THEME.BAND);

  // Column formats + helpers
  const col = h => sh.getRange(first, c(h), n, 1);
  col(COL.SEND).insertCheckboxes().setHorizontalAlignment('center');
  col(COL.NAME).setFontWeight('bold');
  col(COL.DATE).setNumberFormat('ddd m/d/yyyy').setHorizontalAlignment('center')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true)
      .setHelpText('Double-click for a calendar').build());
  [COL.SENT, COL.RECEIVED, COL.LAST].forEach(h => col(h).setNumberFormat('m/d/yyyy').setHorizontalAlignment('center'));
  col(COL.REMINDERS).setNumberFormat('0').setHorizontalAlignment('center');
  col(COL.STATUS).setFontWeight('bold');
  col(COL.EMAIL).setDataValidation(SpreadsheetApp.newDataValidation().requireTextIsEmail()
    .setAllowInvalid(true).build());
  col(COL.MANAGER).setDataValidation(SpreadsheetApp.newDataValidation().requireTextIsEmail()
    .setAllowInvalid(true).build());
  col(COL.MONTH).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'], true).setAllowInvalid(true).build());
  sh.hideColumns(c(COL.EVENT_ID));
  sh.hideColumns(c(COL.TOKEN));
  col(COL.FOLDER).setHorizontalAlignment('center');

  // Notes on the headers
  sh.getRange(HR, c(COL.SEND)).setNote((CONFIG.AUTO_SEND_TICKED
    ? 'Tick = invite them. Once automation is on, ticked rows (with an Email + Record Date) are sent from the Fishbowl account within ~10 minutes, whoever ticked them. Or send right away with 🐟 Fishbowl → 3. Send invites. Boxes clear once sent.'
    : 'Tick the people to invite, then (signed in as the Fishbowl account) 🐟 Fishbowl → 3. Send invites to ticked rows. Nothing sends until then. Boxes clear once sent.'));
  sh.getRange(HR, c(COL.STATUS)).setNote('Updated automatically.\n\n🟢 Green row = video received\n🟡 Yellow row = reminders going out / started but not finished\n🔴 Red row = got every reminder, needs a personal ping\n🔵 Blue status = invited, waiting for their recording day');
  sh.getRange(HR, c(COL.DATE)).setNote('The day they should record. They get an all-day calendar event + a morning email that day, and can record anytime. Double-click a cell for a calendar. Leave it blank and Send will ask you for one date to use for everyone ticked.');

  // Status colors: status cell first (stronger), then the whole row (light tint)
  const S = letter(COL.STATUS);
  const statusCell = col(COL.STATUS);
  const f = formula => '=' + formula.replace(/@/g, '$' + S + first);
  const groups = [
    [THEME.RECEIVED, 'LEFT(@,8)="Received"'],
    [THEME.HUMAN,    'OR(@="' + STATUS.NEEDS_HUMAN + '",LEFT(@,13)="Invite failed")'],
    [THEME.WAITING,  'OR(LEFT(@,8)="Reminder",LEFT(@,7)="Ticked:",@="' + STATUS.STARTED + '")'],
    [THEME.INVITED,  'OR(@="' + STATUS.INVITED + '",@="' + STATUS.DAY_OF + '",LEFT(@,9)="Recording")'],
    [THEME.NOT_YET,  '@="' + STATUS.NOT_INVITED + '"'],
  ];
  const rules = [];
  groups.forEach(([colors, formula]) => {
    const b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f(formula))
      .setFontColor(colors[2]).setRanges([statusCell]);
    if (colors[1]) b.setBackground(colors[1]);
    rules.push(b.build());
  });
  groups.forEach(([colors, formula]) => {
    if (!colors[0]) return;
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f(formula))
      .setBackground(colors[0]).setRanges([body]).build());
  });
  // Status banner (row 1): reminders on/off + progress
  const bannerRules = buildBanner_(sh, c, letter, first);
  sh.setConditionalFormatRules(bannerRules.concat(rules));

  // Fill blank statuses
  rows_(sh).forEach(r => { if (!r.get(COL.STATUS)) r.set(COL.STATUS, STATUS.NOT_INVITED); });

  toast_('Sheet is set up. Add emails, tick the people to invite, then 3. Send invites.');
}

/**
 * Row 1 banner. A1:B1 = title, C1:(Last Reminder)1 = live status, built from a formula so it
 * stays accurate without the script running: it reads the last time the daily reminder ran
 * (stored in the hidden Event ID column's row-1 cell) and counts received videos.
 */
function buildBanner_(sh, c, letter, first) {
  const lastVisible = c(COL.FOLDER);
  const stampCol = c(COL.EVENT_ID);
  const stamp = '$' + letter(COL.EVENT_ID) + '$1';
  sh.getRange(1, 1, 1, lastVisible).breakApart();
  sh.setRowHeight(1, 38);
  sh.getRange(1, 1, 1, 2).merge().setValue('🐟  THE FISHBOWL')
    .setBackground(THEME.NAVY).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(12)
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  const bannerCell = sh.getRange(1, 3, 1, lastVisible - 2).merge();
  const S = letter(COL.STATUS), N = letter(COL.NAME);
  const progress = '"     ·     " & COUNTIF(' + S + first + ':' + S + ',"Received*") & " of " & COUNTA(' + N + first + ':' + N + ') & " videos received"';
  bannerCell.setFormula('=IF(' + stamp + '="", "⚠️  Daily reminders are OFF  ·  Fishbowl account → 🐟 Fishbowl → Turn on daily reminders", ' +
      'IF(NOW()-' + stamp + '>1.5, "⚠️  Daily reminders may have stopped  ·  last ran " & TEXT(' + stamp + ',"ddd m/d h:mm AM/PM") & "  ·  Fishbowl account → Turn on daily reminders", ' +
      '"✅  Daily reminders are ON  ·  last ran " & TEXT(' + stamp + ',"ddd m/d h:mm AM/PM"))) & ' + progress)
    .setBackground('#FFE59A').setFontColor(THEME.NAVY).setFontWeight('bold').setFontSize(10)
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  sh.getRange(1, stampCol).setNumberFormat('m/d/yyyy h:mm:ss');
  return [SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(' + stamp + '<>"",NOW()-' + stamp + '<=1.5)')
    .setBackground(THEME.TEAL).setFontColor('#FFFFFF').setRanges([bannerCell]).build()];
}

/** Records "the daily reminder just ran" for the banner. */
function stampHeartbeat_(clear) {
  try {
    const sh = getSheet_();
    if (headerRow_(sh) !== 2) return; // banner not set up yet
    const col = headerMap_(sh)[norm_(COL.EVENT_ID)];
    if (col === undefined) return;
    sh.getRange(1, col + 1).setValue(clear ? '' : new Date());
  } catch (err) { /* never block the reminders */ }
}

// ------------------------------------------------------------
// 2. Test
// ------------------------------------------------------------
function sendTestToMe() {
  if (!checkSender_()) return;
  const ui = SpreadsheetApp.getUi();
  const me = adminEmail_();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const person = { name: 'Test Tribute', first: 'Test', email: me, month: 'January', day: start, manager: '', token: DEMO_TOKEN };
  const results = [];
  try { createInvite_(person); results.push('✅ All-day calendar event created for ' + fmt_(start)); }
  catch (err) { results.push('❌ Calendar invite failed: ' + err.message); }
  try {
    sendEmail_(person, 'dayof', 0, false);
    for (let n = 1; n <= CONFIG.MAX_REMINDERS; n++) sendEmail_(person, 'reminder', n, false);
    results.push('✅ ' + (CONFIG.MAX_REMINDERS + 1) + ' sample emails handed to Google for delivery');
  } catch (err) { results.push('❌ Emails failed: ' + err.message); }
  ui.alert('Test sent to ' + me, results.join('\n') +
    '\n\nIf it says ✅ but nothing arrives in Outlook within 5 minutes, run 🧪 Testing → Run diagnostics.',
    ui.ButtonSet.OK);
}

// ------------------------------------------------------------
// 3. Send invites to ticked rows
// ------------------------------------------------------------
function sendInvites() {
  checkConfig_();
  if (!checkSender_()) return;
  const ui = SpreadsheetApp.getUi();
  const sh = getSheet_();
  const all = rows_(sh);
  let picked = all.filter(r => r.get(COL.SEND) === true);
  if (!picked.length) {
    const ans = ui.alert('No rows ticked',
      'Tick the "Send?" box on the people you want to invite.\n\n' +
      'Or click YES to invite EVERYONE who has an email + Record Date and hasn\'t been invited yet.',
      ui.ButtonSet.YES_NO);
    if (ans !== ui.Button.YES) return;
    picked = all;
  }

  // Ticked rows with no Record Date: ask once for a date to use for all of them
  const undated = picked.filter(r => r.get(COL.EMAIL) && !dayOf_(r) && !r.get(COL.SENT) && !r.get(COL.RECEIVED));
  if (undated.length) {
    const tomorrow = nextWeekday_(new Date());
    const a = ui.prompt(undated.length + ' row(s) have no Record Date',
      'What day should they record? (M/D/YYYY)\n\nLeave blank for ' + fmt_(tomorrow) +
      '. Click Cancel to skip these rows.', ui.ButtonSet.OK_CANCEL);
    if (a.getSelectedButton() === ui.Button.OK) {
      const txt = a.getResponseText().trim();
      const day = txt ? new Date(txt) : tomorrow;
      if (isNaN(day)) { ui.alert('Could not read that date. Try e.g. 1/5/2027'); return; }
      undated.forEach(r => r.set(COL.DATE, new Date(day.getFullYear(), day.getMonth(), day.getDate())));
    }
  }

  const whyNot = r => !r.get(COL.EMAIL) ? 'no email' : !dayOf_(r) ? 'no Record Date' :
    r.get(COL.RECEIVED) ? 'already received' : r.get(COL.SENT) ? 'already invited' : '';
  const ready = picked.filter(r => !whyNot(r));
  const skipped = picked.filter(r => whyNot(r) && r.get(COL.SEND) === true);
  const skipText = skipped.length ? '\n\nSkipping ' + skipped.length + ':\n' +
    skipped.slice(0, 10).map(r => '• ' + r.get(COL.NAME) + ' (' + whyNot(r) + ')').join('\n') : '';

  if (!ready.length) { ui.alert('Nothing to send', 'None of those rows are ready.' + skipText, ui.ButtonSet.OK); return; }

  const list = ready.slice(0, 15).map(r => '• ' + r.get(COL.NAME) + ' (' + fmt_(dayOf_(r)) + ')').join('\n');
  const ok = ui.alert('Send ' + ready.length + ' invite(s)?',
    list + (ready.length > 15 ? '\n…and ' + (ready.length - 15) + ' more' : '') + skipText, ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  let sent = 0;
  ready.forEach(r => { if (inviteRow_(r)) sent++; });
  toast_('Sent ' + sent + ' invite(s).');
}

/** Sends one row's invite and updates its tracking columns. Returns true on success. */
function inviteRow_(r) {
  try {
    const id = createInvite_(personFromRow_(r));
    r.set(COL.EVENT_ID, id);
    r.set(COL.SENT, new Date());
    r.set(COL.STATUS, STATUS.INVITED);
    r.set(COL.REMINDERS, 0);
    if (r.get(COL.SEND) === true) r.set(COL.SEND, false);
    return true;
  } catch (err) {
    r.set(COL.STATUS, 'Invite failed: ' + err.message);
    return false;
  }
}

// ------------------------------------------------------------
// ➕ Add a new tribute (form dialog)
// ------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

function showAddTribute() {
  // Anyone with edit access can add people. Only the Fishbowl account ever sends (see autoSendTicked).
  const html = `<!doctype html><html><head><base target="_top"><style>
    body{font-family:Roboto,Arial,sans-serif;margin:0;padding:18px 20px;color:${THEME.NAVY}}
    h2{margin:0 0 4px;font-size:18px}p.sub{margin:0 0 16px;color:#5b6b75;font-size:13px}
    label{display:block;font-size:12px;font-weight:700;margin:12px 0 4px;letter-spacing:.02em}
    label span{font-weight:400;color:#7a8a94}
    input,select{width:100%;box-sizing:border-box;background:#fff;padding:9px 10px;border:1px solid #c9dfe3;border-radius:8px;font-size:14px;color:${THEME.NAVY}}
    input:focus,select:focus{outline:2px solid ${THEME.AQUA};border-color:${THEME.TEAL}}
    .row{display:flex;gap:10px}.row>div{flex:1}
    .check{display:flex;align-items:center;gap:8px;margin-top:16px;font-size:14px}
    .check input{width:auto;margin:0}
    .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
    button{border:0;border-radius:20px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer}
    .go{background:${THEME.TEAL};color:#fff}.go:disabled{opacity:.6;cursor:default}
    .cancel{background:#eef5f6;color:${THEME.NAVY}}
    #msg{margin-top:12px;font-size:13px;min-height:18px}.err{color:#b3261e}
  </style></head><body>
    <p class="sub">Adds them to the bottom of the tracker. Tick their Send? box when you're ready to invite them.</p>
    <label>Name</label><input id="name" placeholder="First Last" autofocus>
    <label>Work email</label><input id="email" type="email" placeholder="name@teamvelocitymarketing.com">
    <label>Manager email <span>(optional, CC'd from reminder ${CONFIG.CC_MANAGER_FROM_REMINDER})</span></label>
    <input id="manager" type="email">
    <div class="row">
      <div><label>Month <span>(optional)</span></label><select id="month"><option value=""></option>
        ${MONTHS.map(m => `<option>${m}</option>`).join('')}</select></div>
      <div><label>Record date <span>(optional)</span></label><input id="date" type="date"></div>
    </div>
    <div id="msg"></div>
    <div class="btns"><button class="cancel" onclick="google.script.host.close()">Cancel</button>
      <button class="go" id="go" onclick="submitForm()">Add tribute</button></div>
  <script>
    function v(id){return document.getElementById(id).value.trim()}
    function submitForm(){
      const msg=document.getElementById('msg'), go=document.getElementById('go');
      const data={name:v('name'),email:v('email'),manager:v('manager'),month:v('month'),date:v('date')};
      if(!data.name||!data.email){msg.className='err';msg.textContent='Name and work email are required.';return}
      go.disabled=true;msg.className='';msg.textContent='Adding…';
      google.script.run
        .withSuccessHandler(function(res){if(res.ok){google.script.host.close()}else{go.disabled=false;msg.className='err';msg.textContent=res.message}})
        .withFailureHandler(function(e){go.disabled=false;msg.className='err';msg.textContent=/authoriz/i.test(e.message)?'Google blocked this because the browser is signed into more than one Google account. Open the sheet in a Chrome window (or profile) signed in only as the Fishbowl account and try again.':e.message})
        .addTribute(data);
    }
    document.addEventListener('keydown',function(e){if(e.key==='Enter')submitForm()});
  </script></body></html>`;
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(440).setHeight(440), '🐟 Add a new tribute');
}

/** Called from the dialog. Returns {ok, message}. */
function addTribute(data) {
  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: 'Please enter a name and a valid email.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_();
    const existing = rows_(sh);
    const dupe = existing.find(r => norm_(r.get(COL.EMAIL)) === norm_(email));
    if (dupe) return { ok: false, message: email + ' is already in the tracker (row ' + dupe.row + ').' };

    const map = headerMap_(sh);
    if (map[norm_(COL.SEND)] === undefined) return { ok: false, message: 'Run "1. Set up / restyle sheet" first.' };
    const HR = headerRow_(sh);
    const row = (existing.length ? existing[existing.length - 1].row : HR) + 1;
    const width = sh.getLastColumn();
    if (row > HR + 1) sh.getRange(row - 1, 1, 1, width).copyTo(sh.getRange(row, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    const sendCell = sh.getRange(row, map[norm_(COL.SEND)] + 1);
    if (!sendCell.getDataValidation()) sendCell.insertCheckboxes();

    const put = (h, v) => sh.getRange(row, map[norm_(h)] + 1).setValue(v);
    put(COL.SEND, false);
    put(COL.NAME, name);
    put(COL.EMAIL, email);
    if (data.manager) put(COL.MANAGER, String(data.manager).trim());
    if (data.month) put(COL.MONTH, data.month);
    if (data.date) { const [y, m, d] = String(data.date).split('-').map(Number); put(COL.DATE, new Date(y, m - 1, d)); }
    put(COL.STATUS, STATUS.NOT_INVITED);
    SpreadsheetApp.flush();

    const note = 'Added ' + name + ' (row ' + row + '). Tick Send? when you\'re ready to invite them.';
    sh.setActiveRange(sh.getRange(row, map[norm_(COL.NAME)] + 1));
    toast_(note);
    return { ok: true, message: note };
  } finally {
    lock.releaseLock();
  }
}

function createInvite_(p) {
  const link = personalLink_(p);
  const ev = CalendarApp.getDefaultCalendar().createAllDayEvent(
    '🐟 Fishbowl recording day (about 15 min)', p.day, {
      description: inviteText_(p, link),
      location: link,
      guests: p.email,
      sendInvites: true,
    });
  return ev.getId();
}

// ------------------------------------------------------------
// Daily check: day-of nudge, reminders, escalation
// ------------------------------------------------------------
function dailyCheck() { stampHeartbeat_(); runCheck_(false); cleanupUploads_(); } // used by the daily trigger
function runReminderCheckNow() { runCheck_(true); }  // menu: runs even on weekends

function runCheck_(manual) {
  const now = new Date();
  const dow = now.getDay();
  if (!manual && (dow === 0 || dow === 6)) return; // no weekend nagging

  const sh = getSheet_();
  const escalated = [];

  rows_(sh).forEach(r => {
    if (r.get(COL.RECEIVED) || !r.get(COL.SENT) || !r.get(COL.EMAIL)) return;
    const day = dayOf_(r);
    if (!day) return;
    const status = String(r.get(COL.STATUS) || '');
    if (status === STATUS.NEEDS_HUMAN) return;

    const p = personFromRow_(r);
    const count = Number(r.get(COL.REMINDERS)) || 0;
    const last = r.get(COL.LAST) instanceof Date ? r.get(COL.LAST) : null;
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

    // Morning of their recording day
    if (sameDay_(day, now) && !last) {
      sendEmail_(p, 'dayof', 0, false);
      r.set(COL.LAST, now);
      r.set(COL.STATUS, STATUS.DAY_OF);
      return;
    }

    // Their day has passed and still nothing
    if (now >= dayEnd) {
      const base = last && last > day ? last : day;
      if (businessDaysBetween_(base, now) < CONFIG.REMINDER_EVERY_BUSINESS_DAYS) return;

      if (count >= CONFIG.MAX_REMINDERS) {
        r.set(COL.STATUS, STATUS.NEEDS_HUMAN);
        escalated.push(p);
        return;
      }
      const n = count + 1;
      const cc = n >= CONFIG.CC_MANAGER_FROM_REMINDER && p.manager;
      sendEmail_(p, 'reminder', n, cc);
      r.set(COL.REMINDERS, n);
      r.set(COL.LAST, now);
      r.set(COL.STATUS, 'Reminder ' + n + ' sent');
    }
  });

  if (escalated.length) {
    MailApp.sendEmail({
      to: adminEmail_(),
      subject: '🐟 Fishbowl: ' + escalated.length + ' tribute(s) need a personal ping',
      htmlBody: '<p>These tributes got every automated reminder and still haven\'t recorded:</p><ul>' +
        escalated.map(p => '<li>' + esc_(p.name) + ' (' + esc_(p.email) + ')</li>').join('') +
        '</ul><p>' + sheetLink_() + '</p>',
      name: CONFIG.SENDER_NAME,
    });
  }

  if (dow === 1) sendWeeklySummary_(sh);
  if (manual) toast_('Reminder check done.');
}

// ------------------------------------------------------------
// Testing helpers (safe to leave in; they only touch the selected row)
// ------------------------------------------------------------
function selectedRows_() {
  const sh = getSheet_();
  const sel = sh.getActiveRange();
  const first = sel.getRow(), count = sel.getNumRows();
  return rows_(sh).filter(r => r.row >= first && r.row < first + count);
}

/** Pushes the row's Record Date / last reminder 5 days into the past so the next check fires the next step. */
function testFastForwardSelected() {
  const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const rows = selectedRows_();
  rows.forEach(r => {
    const day = dayOf_(r);
    if (!day || day > past) r.set(COL.DATE, new Date(past.getFullYear(), past.getMonth(), past.getDate()));
    if (r.get(COL.LAST) instanceof Date) r.set(COL.LAST, past);
  });
  toast_('Fast-forwarded ' + rows.length + ' row(s). Now click "Run reminder check now".');
}

/**
 * Explains where mail is (or isn't) going. Sends one plain email to the admin address AND to a
 * second address you type (e.g. a personal Gmail). If only the second one arrives, Google is
 * sending fine and your company's mail filter is blocking it.
 */
function testDiagnostics() {
  const ui = SpreadsheetApp.getUi();
  const lines = [];
  const user = Session.getEffectiveUser().getEmail();
  lines.push('Script runs as: ' + user);
  lines.push('Admin / reply-to: ' + adminEmail_());
  lines.push('Time zone: ' + tz_());
  try { lines.push('Emails left today: ' + MailApp.getRemainingDailyQuota()); }
  catch (err) { lines.push('❌ Mail quota check failed: ' + err.message); }

  try {
    const cal = CalendarApp.getDefaultCalendar();
    const soon = cal.getEvents(new Date(Date.now() - 26 * 60 * 60 * 1000), new Date(Date.now() + 26 * 60 * 60 * 1000))
      .filter(ev => ev.getTitle().indexOf('Fishbowl') !== -1);
    lines.push('Calendar: ' + cal.getName() + ' (' + soon.length + ' Fishbowl event(s) in the next day)');
    soon.slice(0, 3).forEach(ev => lines.push('   • ' + fmt_(ev.getStartTime()) + ', guests: ' +
      ev.getGuestList().map(g => g.getEmail() + ' [' + g.getGuestStatus() + ']').join(', ')));
  } catch (err) { lines.push('❌ Calendar check failed: ' + err.message); }

  const second = ui.prompt('Optional: second address for a control test',
    'Type a personal email (e.g. a Gmail) to send the same test there too, or leave blank.',
    ui.ButtonSet.OK_CANCEL);
  const extra = second.getSelectedButton() === ui.Button.OK ? second.getResponseText().trim() : '';
  const stamp = Utilities.formatDate(new Date(), tz_(), 'h:mm:ss a');
  [adminEmail_(), extra].filter(Boolean).forEach(addr => {
    try {
      MailApp.sendEmail(addr, 'Fishbowl diagnostic ' + stamp,
        'If you can read this, the Fishbowl script can reach ' + addr + '.\nSent by ' + user + ' at ' + stamp + '.');
      lines.push('✅ Plain test email handed off → ' + addr);
    } catch (err) { lines.push('❌ Test email to ' + addr + ' failed: ' + err.message); }
  });
  lines.push('', 'Look for subject "Fishbowl diagnostic ' + stamp + '".');
  ui.alert('🐟 Fishbowl diagnostics', lines.join('\n'), ui.ButtonSet.OK);
}

/** Sends a fake "completed" VideoAsk webhook for the selected row(s), exactly like VideoAsk would. */
function testSimulateWebhookSelected() {
  const rows = selectedRows_();
  rows.forEach(r => {
    const payload = { event_type: 'form_response', contact: {
      name: String(r.get(COL.NAME)), email: String(r.get(COL.EMAIL)), status: 'completed' } };
    doPost({ parameter: { key: CONFIG.WEBHOOK_KEY, testRow: String(r.row) }, postData: { contents: JSON.stringify(payload) } });
  });
  getSheet_().activate();
  toast_('Simulated VideoAsk finish for ' + rows.length + ' row(s). Check the Status column + "Webhook Log" tab.');
}

function sendWeeklySummary_(sh) {
  const all = rows_(sh);
  const count = s => all.filter(r => String(r.get(COL.STATUS) || '').indexOf(s) === 0).length;
  const received = all.filter(r => r.get(COL.RECEIVED)).length;
  const waiting = all.filter(r => r.get(COL.SENT) && !r.get(COL.RECEIVED));
  const html =
    '<p><b>' + received + ' of ' + all.length + '</b> fishbowls received.</p>' +
    '<p>Invited, waiting: ' + waiting.length +
    ' · In reminders: ' + count('Reminder') +
    ' · Started, not finished: ' + count(STATUS.STARTED) +
    ' · Needs a human: ' + count(STATUS.NEEDS_HUMAN) +
    ' · Not invited yet: ' + all.filter(r => !r.get(COL.SENT)).length + '</p>' +
    (waiting.length ? '<p>Still waiting on:</p><ul>' + waiting.map(r =>
      '<li>' + esc_(r.get(COL.NAME)) + ' (' + esc_(r.get(COL.STATUS)) + ')</li>').join('') + '</ul>' : '') +
    '<p>' + sheetLink_() + '</p>';
  MailApp.sendEmail({ to: adminEmail_(), subject: '🐟 Fishbowl weekly: ' + received + '/' + all.length + ' received',
                      htmlBody: html, name: CONFIG.SENDER_NAME });
}

function installDailyTrigger() {
  if (!checkSender_()) return;
  ScriptApp.getProjectTriggers()
    .filter(t => ['dailyCheck', 'autoSendTicked'].indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyCheck').timeBased().everyDays(1).atHour(CONFIG.DAILY_CHECK_HOUR).create();
  stampHeartbeat_();
  if (CONFIG.AUTO_SEND_TICKED) ScriptApp.newTrigger('autoSendTicked').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getUi().alert(CONFIG.AUTO_SEND_TICKED ? 'Automation is on' : 'Daily reminders are on',
    (CONFIG.AUTO_SEND_TICKED ? '• Every ~10 minutes: ticked rows with an Email + Record Date get their invite, sent from ' +
    Session.getEffectiveUser().getEmail() + ', no matter who ticked them.\n' : '') +
    '• Every weekday around ' + CONFIG.DAILY_CHECK_HOUR + ':00 ' + tz_() + ': morning-of emails, reminders, escalations.\n\n' +
    'Both keep running even when nobody has the sheet open.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function turnOffReminders() {
  if (!checkSender_()) return;
  ScriptApp.getProjectTriggers()
    .filter(t => ['dailyCheck', 'autoSendTicked'].indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  stampHeartbeat_(true);
  toast_('Daily reminders are off. Nothing will send until you turn them back on.');
}

/**
 * Runs every 10 minutes as the Fishbowl account (whoever turned automation on).
 * Lets anyone with edit access add people + tick Send? without sending from their own address.
 */
function autoSendTicked() {
  if (!CONFIG.AUTO_SEND_TICKED || !/^https?:\/\//.test(CONFIG.VIDEOASK_URL)) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const sh = getSheet_();
    rows_(sh).forEach(r => {
      if (r.get(COL.SEND) !== true || r.get(COL.SENT) || r.get(COL.RECEIVED)) return;
      if (!r.get(COL.EMAIL)) { r.set(COL.STATUS, 'Ticked: needs an Email'); return; }
      if (!dayOf_(r)) { r.set(COL.STATUS, 'Ticked: needs a Record Date'); return; }
      inviteRow_(r);
    });
  } finally {
    lock.releaseLock();
  }
}

function markSelectedReceived() {
  const sh = getSheet_();
  const sel = sh.getActiveRange();
  const map = headerMap_(sh);
  for (let i = 0; i < sel.getNumRows(); i++) {
    const row = sel.getRow() + i;
    if (row <= headerRow_(sh)) continue;
    sh.getRange(row, map[norm_(COL.RECEIVED)] + 1).setValue(new Date());
    sh.getRange(row, map[norm_(COL.STATUS)] + 1).setValue(STATUS.RECEIVED);
  }
  toast_('Marked as received.');
}

// ------------------------------------------------------------
// VideoAsk webhook: Deploy > Web app, then give VideoAsk:
//   <web app URL>?key=<WEBHOOK_KEY>
// ------------------------------------------------------------
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_('bad json'); }
  if (body && body.action) return recorderApi_(body); // Fishbowl Recorder page (token-checked)
  if (!e || !e.parameter || e.parameter.key !== CONFIG.WEBHOOK_KEY) return out_('forbidden');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    logWebhook_(body);
    const evt = String(body.event_type || '');
    if (evt && evt.indexOf('form_response') !== 0) return out_('ignored ' + evt);

    const sh = getSheet_();
    const rows = rows_(sh);
    const emails = findEmails_(body);
    const matches = rows.filter(r => emails.indexOf(String(r.get(COL.EMAIL) || '').trim().toLowerCase()) !== -1);
    const testRow = Number(e.parameter.testRow) || 0; // only set by the Testing menu
    const row = matches.find(r => r.row === testRow) || matches.find(r => !r.get(COL.RECEIVED)) || matches[0];
    if (!row) return out_('no matching row');
    if (row.get(COL.RECEIVED)) return out_('already received');

    const status = String((body.contact && body.contact.status) || '').toLowerCase();
    if (!status || status.indexOf('complet') !== -1) {
      row.set(COL.RECEIVED, new Date());
      row.set(COL.STATUS, STATUS.RECEIVED);
    } else {
      row.set(COL.STATUS, STATUS.STARTED);
    }
    return out_('ok');
  } finally {
    lock.releaseLock();
  }
}

function doGet() { return out_('Fishbowl backend is live.'); }

function logWebhook_(body) {
  const ss = SpreadsheetApp.getActive();
  let log = ss.getSheetByName('Webhook Log');
  if (!log) {
    const active = ss.getActiveSheet();
    log = ss.insertSheet('Webhook Log', ss.getNumSheets()); // last tab
    log.appendRow(['Received', 'Event', 'Email', 'VideoAsk status', 'Raw data (for troubleshooting)']);
    log.getRange(1, 1, 1, 5).setBackground(THEME.NAVY).setFontColor('#FFFFFF').setFontWeight('bold');
    log.setFrozenRows(1);
    [150, 140, 260, 130, 500].forEach((w, k) => log.setColumnWidth(k + 1, w));
    log.getRange('A:A').setNumberFormat('m/d/yyyy h:mm am/pm');
    log.getRange('E:E').setWrap(false);
    log.setTabColor('#8A97A0');
    if (active) ss.setActiveSheet(active); // don't pull people off the tracker
  }
  log.appendRow([new Date(), body.event_type || '', findEmails_(body).join(', '),
                 (body.contact && body.contact.status) || '', JSON.stringify(body).slice(0, 45000)]);
}

// ------------------------------------------------------------
// Email copy
// ------------------------------------------------------------
function inviteText_(p, link) {
  return [
    'Hi ' + p.first + '!',
    '',
    "You're one of our Fishbowl tributes" + (p.month ? ' for ' + p.month : '') +
      '. Your recording day is ' + dayPhrase_(p.day) + '. Find 15 minutes anytime, whatever works for you.',
    '',
    '▶ RECORD HERE: ' + link,
    '',
    'Before you start:',
    '• Use your laptop, or turn your phone sideways. Landscape only, please.',
    '• Find a quiet spot with light in front of you, not behind you.',
    '• Splash Round = ONE-WORD answers. Save the stories for the later questions.',
    '• Have 3–6 photos ready to upload (family, pets, hobbies, anything fun).',
    '• It goes one question at a time, and you can re-record any answer before moving on.',
    CONFIG.RECORDER === 'custom' ? '• Open the link in Chrome or Safari and allow your camera + microphone.' : null,
    CONFIG.EXTRA_NOTE ? '• ' + CONFIG.EXTRA_NOTE : null,
    '',
    "Busy that day? The link works anytime. Sooner is better!",
  ].filter(l => l !== null).join('\n');
}

function sendEmail_(p, kind, n, ccManager) {
  const link = personalLink_(p);
  const btn = '<p><a href="' + link + '" style="background:#14a3a8;color:#fff;padding:12px 22px;' +
    'border-radius:24px;text-decoration:none;font-weight:bold;display:inline-block">▶ Record my Fishbowl</a></p>';
  const tips = '<p style="color:#555;font-size:13px">Laptop or phone sideways · quiet spot · ' +
    'Splash Round = one-word answers · have a few photos ready' +
    (CONFIG.EXTRA_NOTE ? ' · ' + esc_(CONFIG.EXTRA_NOTE) : '') + '</p>';

  let subject, body;
  if (kind === 'dayof') {
    subject = '🐟 Today\'s your Fishbowl recording day!';
    body = '<p>Hi ' + esc_(p.first) + ',</p><p>Today\'s your day to record your Fishbowl. Grab <b>15 minutes anytime today</b>. ' +
      'It goes one question at a time, and you can re-record any answer.</p>';
  } else if (n === 1) {
    subject = '🐟 Quick nudge: your Fishbowl recording';
    body = '<p>Hi ' + esc_(p.first) + ',</p><p>Looks like your Fishbowl day came and went. No worries! ' +
      'The link still works anytime. Grab 15 minutes when you can:</p>';
  } else if (n < CONFIG.MAX_REMINDERS) {
    subject = '🐟 Your Fishbowl is still waiting on you';
    body = '<p>Hi ' + esc_(p.first) + ',</p><p>Just checking in: we still need your Fishbowl recording' +
      (p.month ? ' for the <b>' + esc_(p.month) + '</b> town hall' : '') + '. It only takes about 15 minutes.' +
      (ccManager ? ' (Looping in your manager so they can help you carve out the time.)' : '') + '</p>';
  } else {
    subject = '🐟 Last call: Fishbowl recording';
    body = '<p>Hi ' + esc_(p.first) + ',</p><p>This is our last automated reminder. ' +
      'Your coworkers are excited to get to know you, so please record this week if you can. ' +
      'If something\'s in the way, just reply and let us know.</p>';
  }

  const msg = { to: p.email, subject: subject, htmlBody: body + btn + tips, name: CONFIG.SENDER_NAME,
                replyTo: adminEmail_() };
  if (ccManager) msg.cc = p.manager;
  MailApp.sendEmail(msg);
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
/** The link a tribute clicks to record. Custom recorder: a private token link. VideoAsk: prefilled contact. */
function personalLink_(p) {
  if (CONFIG.RECORDER === 'custom') {
    return String(CONFIG.RECORDER_URL).replace(/[?#].*$/, '').replace(/\/?$/, '/') + '?t=' + encodeURIComponent(p.token || DEMO_TOKEN);
  }
  const base = String(CONFIG.VIDEOASK_URL).split('#')[0];
  return base + '#contact_name=' + encodeURIComponent(p.name) + '&contact_email=' + encodeURIComponent(p.email);
}

/** Gives the row a private random token (once) for its recording link. */
function ensureToken_(r) {
  let t = String(r.get(COL.TOKEN) || '').trim();
  if (!t) {
    t = Utilities.getUuid().replace(/-/g, '').slice(0, 22);
    try { r.set(COL.TOKEN, t); } catch (err) { /* column missing until setup runs */ }
  }
  return t;
}

function personFromRow_(r) {
  const name = String(r.get(COL.NAME) || '').trim();
  return {
    name: name,
    first: name.split(/\s+/)[0] || 'there',
    email: String(r.get(COL.EMAIL) || '').trim(),
    month: monthLabel_(r.get(COL.MONTH)),
    day: dayOf_(r),
    manager: String(r.get(COL.MANAGER) || '').trim(),
    token: CONFIG.RECORDER === 'custom' ? ensureToken_(r) : '',
  };
}

function monthLabel_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'MMMM');
  return String(v || '').trim();
}

/** "today, Tuesday, October 13" / "tomorrow, Wednesday, October 14" / "Tuesday, January 5" */
function dayPhrase_(day) {
  const pretty = Utilities.formatDate(day, tz_(), 'EEEE, MMMM d');
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(day.getFullYear(), day.getMonth(), day.getDate()) - t) / 86400000);
  return diff === 0 ? 'today, ' + pretty : diff === 1 ? 'tomorrow, ' + pretty : pretty;
}

function nextWeekday_(from) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function businessDaysBetween_(a, b) {
  const d = new Date(a); d.setHours(0, 0, 0, 0);
  const end = new Date(b); end.setHours(0, 0, 0, 0);
  let n = 0;
  while (d < end) {
    d.setDate(d.getDate() + 1);
    const w = d.getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

function findEmails_(obj) {
  const found = [];
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  (function walk(v) {
    if (v == null) return;
    if (typeof v === 'string') { (v.match(re) || []).forEach(m => found.push(decodeURIComponent(m).toLowerCase())); return; }
    if (typeof v === 'object') Object.keys(v).forEach(k => walk(v[k]));
  })(obj);
  // contact.email first if present
  const primary = obj && obj.contact && obj.contact.email ? [String(obj.contact.email).toLowerCase()] : [];
  return primary.concat(found).filter((e, i, a) => a.indexOf(e) === i);
}

function sameDay_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) throw new Error('No tab named "' + CONFIG.SHEET_NAME + '". Update CONFIG.SHEET_NAME.');
  return sh;
}

/** The row's recording day (midnight), or null. */
function dayOf_(r) {
  const d = r.get(COL.DATE);
  if (!(d instanceof Date)) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Upgrades sheets set up by older versions of this script:
 * "Record Slot" (date + time) becomes "Record Date" (date only), and a "Record Time" column is removed.
 */
function migrateRecordSlot_(sh) {
  let map = headerMap_(sh);
  const old = map[norm_('Record Slot')];
  if (old !== undefined && map[norm_(COL.DATE)] === undefined) {
    const HR = headerRow_(sh);
    sh.getRange(HR, old + 1).setValue(COL.DATE);
    const last = sh.getLastRow();
    if (last > HR) {
      const vals = sh.getRange(HR + 1, old + 1, last - HR, 1).getValues()
        .map(([v]) => [v instanceof Date ? new Date(v.getFullYear(), v.getMonth(), v.getDate()) : v]);
      sh.getRange(HR + 1, old + 1, last - HR, 1).setValues(vals);
    }
  }
  map = headerMap_(sh);
  const timeCol = map[norm_('Record Time')];
  if (timeCol !== undefined) sh.deleteColumn(timeCol + 1);
}

function columnLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }

function norm_(s) { return String(s || '').trim().toLowerCase(); }

/** The header row: 1 on sheets set up before the status banner existed, 2 after. */
function headerRow_(sh) {
  const top = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  return top.some(v => norm_(v) === norm_(COL.NAME)) ? 1 : 2;
}

function headerMap_(sh) {
  const headers = sh.getRange(headerRow_(sh), 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h !== '' && map[norm_(h)] === undefined) map[norm_(h)] = i; });
  return map;
}

/** Returns row wrappers for every row with a name: r.get(header), r.set(header, value). */
function rows_(sh) {
  const map = headerMap_(sh);
  const HR = headerRow_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow <= HR) return [];
  const values = sh.getRange(HR + 1, 1, lastRow - HR, sh.getLastColumn()).getValues();
  const nameCol = map[norm_(COL.NAME)];
  if (nameCol === undefined) throw new Error('Missing "' + COL.NAME + '" header.');
  return values.map((vals, i) => ({
    row: i + HR + 1,
    get: h => { const c = map[norm_(h)]; return c === undefined ? '' : vals[c]; },
    set: (h, v) => {
      const c = map[norm_(h)];
      if (c === undefined) throw new Error('Missing "' + h + '" column. Run "Set up columns".');
      vals[c] = v;
      sh.getRange(i + HR + 1, c + 1).setValue(v);
    },
  })).filter(r => String(r.get(COL.NAME)).trim() !== '');
}

/**
 * Invites must come from the Fishbowl account (the one that runs setup). If someone uses the menu
 * while signed in as a different account, stop before anything is sent from the wrong address.
 */
function checkSender_(silent) {
  const props = PropertiesService.getScriptProperties();
  const me = Session.getEffectiveUser().getEmail();
  const sender = props.getProperty('SENDER');
  if (!sender) { props.setProperty('SENDER', me); return true; }
  if (!me || norm_(me) === norm_(sender)) return true;
  const msg = 'You\'re signed in as ' + me + ', but Fishbowl invites are sent from ' + sender + '.\n\n' +
    'Open this sheet in a Chrome window signed in only as ' + sender + ', then try again.';
  if (silent) throw new Error(msg);
  SpreadsheetApp.getUi().alert('Wrong Google account', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  return false;
}

function checkConfig_() {
  if (CONFIG.RECORDER === 'custom') {
    if (/USERNAME/.test(CONFIG.RECORDER_URL)) throw new Error('Put your GitHub username into CONFIG.RECORDER_URL first.');
    return;
  }
  if (!/^https?:\/\//.test(CONFIG.VIDEOASK_URL)) throw new Error('Paste your VideoAsk link into CONFIG.VIDEOASK_URL first.');
}
function adminEmail_() { return CONFIG.ADMIN_EMAIL || Session.getEffectiveUser().getEmail(); }
function tz_() { return Session.getScriptTimeZone(); }
function fmt_(d) { return Utilities.formatDate(d, tz_(), 'EEE M/d'); }


function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function sheetLink_() { return '<a href="' + SpreadsheetApp.getActive().getUrl() + '">Open the Fishbowl tracker</a>'; }
function toast_(m) { SpreadsheetApp.getActive().toast(m, '🐟 Fishbowl', 8); }
function out_(s) { return ContentService.createTextOutput(s); }


// ============================================================
// FISHBOWL RECORDER BACKEND
// The recording page (GitHub Pages) talks to this web app. Every request carries the
// tribute's private token from their link; nothing is accepted without a valid one.
//   start    → who they are + which answers are already saved (for resume)
//   direct   → fast path: a one-time Drive upload address; the page sends the video straight to Drive
//   saved    → fast path: confirms that upload, replaces any older take, updates the tracker
//   chunk    → backup path: one piece of an answer (base64 text), stored temporarily
//   finish   → backup path: joins the pieces into "<NN Question>.<ext>" in their Drive folder
//   photo    → one photo into their Photos folder
//   complete → marks VIDEO RECEIVED ✅ and links their Drive folder in the sheet
// ============================================================
const DEMO_TOKEN = 'demo';
const CHUNK_CHARS = 4 * 1024 * 1024; // must match the page; a multiple of 4 keeps base64 pieces joinable

function recorderApi_(body) {
  try {
    const who = whoIs_(String(body.t || ''));
    if (!who) return json_({ ok: false, error: 'This link isn\'t valid anymore. Use the newest link from your Fishbowl invite.' });
    switch (body.action) {
      case 'start':    return json_(apiStart_(who));
      case 'chunk':    return json_(apiChunk_(who, body));
      case 'finish':   return json_(apiFinish_(who, body));
      case 'direct':   return json_(apiDirect_(who, body));
      case 'saved':    return json_(apiSaved_(who, body));
      case 'photo':    return json_(apiPhoto_(who, body));
      case 'complete': return json_(apiComplete_(who, body));
      default:         return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Token → {token, row, name, first, demo}. Cached for 10 minutes so uploads don't re-read the sheet. */
function whoIs_(token) {
  if (!token || token.length > 64) return null;
  if (token === DEMO_TOKEN) return { token: token, row: 0, name: 'Demo Tribute', first: 'there', demo: true };
  const cache = CacheService.getScriptCache();
  const hit = cache.get('tok_' + token);
  if (hit) return JSON.parse(hit);
  const r = rows_(getSheet_()).find(x => String(x.get(COL.TOKEN) || '').trim() === token);
  if (!r) return null;
  const name = String(r.get(COL.NAME) || '').trim();
  const who = { token: token, row: r.row, name: name, first: name.split(/\s+/)[0] || 'there', demo: false };
  cache.put('tok_' + token, JSON.stringify(who), 600);
  return who;
}

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DRIVE_ROOT_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (err) {} }
  const it = DriveApp.getRootFolder().getFoldersByName(CONFIG.DRIVE_FOLDER_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(CONFIG.DRIVE_FOLDER_NAME);
  props.setProperty('DRIVE_ROOT_ID', f.getId());
  return f;
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function personFolder_(who) {
  const root = rootFolder_();
  if (who.demo) return childFolder_(childFolder_(root, '_Demo Recordings'), Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'));
  return childFolder_(root, safeName_(who.name));
}

function tempFolder_() { return childFolder_(rootFolder_(), '_uploads-in-progress'); }

function safeName_(s) { return String(s || 'Unknown').replace(/[\\/:*?"<>|#%]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Unknown'; }

/** Step ids already saved in the folder: files are named "<id> <Title>.<ext>". */
function savedSteps_(folder) {
  const done = {};
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    const n = f.getName();
    const m = n.match(/^([A-Za-z]?\d{1,2})\s/);
    if (m) done[m[1]] = true;
  }
  return Object.keys(done);
}

function photoCount_(folder) {
  const it = folder.getFoldersByName('Photos');
  if (!it.hasNext()) return 0;
  let n = 0; const files = it.next().getFiles();
  while (files.hasNext()) { if (!files.next().isTrashed()) n++; }
  return n;
}

function apiStart_(who) {
  const folder = personFolder_(who);
  const done = who.demo ? [] : savedSteps_(folder);
  let received = false;
  if (!who.demo) {
    const r = rows_(getSheet_()).find(x => x.row === who.row);
    received = !!(r && r.get(COL.RECEIVED));
  }
  return { ok: true, name: who.name, first: who.first, demo: !!who.demo, done: done,
           photos: who.demo ? 0 : photoCount_(folder), received: received, chunkChars: CHUNK_CHARS, direct: true };
}

function apiChunk_(who, b) {
  const uploadId = String(b.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const index = Number(b.index), total = Number(b.total);
  if (!uploadId || !(index >= 0) || !(total > 0) || index >= total || total > 200) throw new Error('Bad chunk');
  const data = String(b.data || '');
  if (!data || data.length > CHUNK_CHARS + 16 || /[^A-Za-z0-9+/=]/.test(data.slice(0, 200))) throw new Error('Bad chunk data');
  const tmp = tempFolder_();
  const name = who.token + '_' + uploadId + '_' + ('000' + index).slice(-4) + '.b64';
  const old = tmp.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true); // a retried chunk replaces the earlier copy
  tmp.createFile(name, data, MimeType.PLAIN_TEXT);
  return { ok: true, index: index };
}

function apiFinish_(who, b) {
  const uploadId = String(b.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const total = Number(b.total);
  const stepId = String(b.stepId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
  const title = safeName_(b.title || stepId);
  const ext = /^(mp4|webm|mov)$/.test(b.ext) ? b.ext : 'webm';
  const mime = /^video\/(mp4|webm|quicktime)/.test(b.mime || '') ? String(b.mime).split(';')[0] : 'video/' + ext;
  if (!uploadId || !(total > 0) || !stepId) throw new Error('Bad finish');

  const tmp = tempFolder_();
  const parts = [];
  for (let i = 0; i < total; i++) {
    const it = tmp.getFilesByName(who.token + '_' + uploadId + '_' + ('000' + i).slice(-4) + '.b64');
    if (!it.hasNext()) return { ok: false, missing: i, error: 'Missing piece ' + (i + 1) + ' of ' + total };
    parts.push(it.next());
  }
  const b64 = parts.map(f => f.getBlob().getDataAsString()).join('');
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, stepId + ' ' + title + '.' + ext);

  const folder = personFolder_(who);
  const file = folder.createFile(blob);
  parts.forEach(f => f.setTrashed(true));
  trashOtherTakes_(folder, stepId, file.getId()); // a re-recorded answer replaces the earlier take
  markProgress_(who, folder, b.totalSteps);
  return { ok: true, fileId: file.getId(), bytes: Math.floor(b64.length * 3 / 4) };
}

/**
 * Fast path: asks Drive for a one-time upload address for this one answer, so the
 * browser can send the video straight to Drive (no base64, no pieces through this script).
 * The address only accepts this single file, into this person's folder.
 */
function apiDirect_(who, b) {
  const v = takeInfo_(b);
  const size = Number(b.size);
  if (!(size > 0) || size > 1024 * 1024 * 1024) throw new Error('Bad size');
  const origin = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(b.origin || '') ? b.origin
               : (String(CONFIG.RECORDER_URL).match(/^https?:\/\/[^/]+/) || [''])[0];
  const folder = personFolder_(who);
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': v.mime,
      'X-Upload-Content-Length': String(size),
      Origin: origin, // lets the recorder page (and only that site) send the bytes
    },
    payload: JSON.stringify({ name: v.name, mimeType: v.mime, parents: [folder.getId()] }),
    muteHttpExceptions: true,
  });
  const h = res.getAllHeaders();
  const url = h.Location || h.location;
  if (res.getResponseCode() !== 200 || !url) throw new Error('Drive upload unavailable (' + res.getResponseCode() + ')');
  return { ok: true, uploadUrl: url };
}

/** Fast path, step 2: the browser finished sending; tidy up and update the tracker. */
function apiSaved_(who, b) {
  const v = takeInfo_(b);
  const fileId = String(b.fileId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!fileId) throw new Error('Bad file');
  const folder = personFolder_(who);
  const file = DriveApp.getFileById(fileId);
  let inFolder = false;
  const ps = file.getParents();
  while (ps.hasNext()) { if (ps.next().getId() === folder.getId()) inFolder = true; }
  if (!inFolder || file.getName().indexOf(v.stepId + ' ') !== 0) throw new Error('Upload not found');
  trashOtherTakes_(folder, v.stepId, fileId);
  markProgress_(who, folder, b.totalSteps);
  return { ok: true, fileId: fileId, bytes: file.getSize() };
}

/** Cleans the step id / title / type the page sends and builds "<id> <Title>.<ext>". */
function takeInfo_(b) {
  const stepId = String(b.stepId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
  if (!stepId) throw new Error('Bad step');
  const title = safeName_(b.title || stepId);
  const ext = /^(mp4|webm|mov)$/.test(b.ext) ? b.ext : 'webm';
  const mime = /^video\/(mp4|webm|quicktime)/.test(b.mime || '') ? String(b.mime).split(';')[0] : 'video/' + ext;
  return { stepId: stepId, title: title, ext: ext, mime: mime, name: stepId + ' ' + title + '.' + ext };
}

function trashOtherTakes_(folder, stepId, keepId) {
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && f.getId() !== keepId && f.getName().indexOf(stepId + ' ') === 0) f.setTrashed(true);
  }
}

/** Status → "Recording n/16" and links their folder (real tributes only). */
function markProgress_(who, folder, totalSteps) {
  if (who.demo) return;
  const n = savedSteps_(folder).length;
  const total = Number(totalSteps) || 16;
  withSheetLock_(sh => {
    const r = rows_(sh).find(x => x.row === who.row);
    if (r && !r.get(COL.RECEIVED)) {
      r.set(COL.STATUS, 'Recording ' + Math.min(n, total) + '/' + total);
      if (!r.get(COL.FOLDER)) r.set(COL.FOLDER, folderLink_(folder));
    }
  });
}

function apiPhoto_(who, b) {
  const data = String(b.data || '');
  if (!data || data.length > 12 * 1024 * 1024) throw new Error('Photo too large');
  const mime = /^image\/(jpeg|png|webp|heic|heif)$/.test(b.mime || '') ? b.mime : 'image/jpeg';
  const photos = childFolder_(personFolder_(who), 'Photos');
  let n = 0; const it = photos.getFiles(); while (it.hasNext()) { if (!it.next().isTrashed()) n++; }
  if (n >= 12) throw new Error('That\'s plenty of photos, thanks!');
  const base = safeName_(String(b.name || 'photo').replace(/\.[^.]+$/, '')).slice(0, 40);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const file = photos.createFile(Utilities.newBlob(Utilities.base64Decode(data), mime, ('0' + (n + 1)).slice(-2) + ' ' + base + '.' + ext));
  return { ok: true, fileId: file.getId(), count: n + 1 };
}

function apiComplete_(who, b) {
  const folder = personFolder_(who);
  if (who.demo) return { ok: true, folder: folder.getUrl() };
  const done = savedSteps_(folder);
  withSheetLock_(sh => {
    const r = rows_(sh).find(x => x.row === who.row);
    if (!r) return;
    r.set(COL.FOLDER, folderLink_(folder));
    if (!r.get(COL.RECEIVED)) {
      r.set(COL.RECEIVED, new Date());
      r.set(COL.STATUS, STATUS.RECEIVED);
    }
  });
  return { ok: true, saved: done.length };
}

function folderLink_(folder) { return '=HYPERLINK("' + folder.getUrl() + '","📁 Open")'; }

function withSheetLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { fn(getSheet_()); } finally { lock.releaseLock(); }
}

function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/** Removes upload pieces older than a day (abandoned uploads). Runs with the daily check. */
function cleanupUploads_() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const it = tempFolder_().getFiles();
    while (it.hasNext()) { const f = it.next(); if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true); }
  } catch (err) { /* never block reminders */ }
}

/** Menu: shows (and lets you copy) the selected row's personal recording link. */
function showSelectedLink() {
  const rows = selectedRows_();
  if (!rows.length) { SpreadsheetApp.getUi().alert('Click a tribute\'s row first.'); return; }
  const lines = rows.map(r => r.get(COL.NAME) + ':\n' + personalLink_(personFromRow_(r)));
  SpreadsheetApp.getUi().alert('Recording link', lines.join('\n\n') +
    '\n\nTry it yourself any time with the demo link:\n' + personalLink_({ token: DEMO_TOKEN }), SpreadsheetApp.getUi().ButtonSet.OK);
}
