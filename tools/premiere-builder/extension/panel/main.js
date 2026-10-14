/* Fishbowl Builder panel: talks to host/fishbowl.jsx inside Premiere. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { t1: null, t2: null, tplOk: false };
  var NEXT_YEAR_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  /** Runs fbFunction(arg) in Premiere and resolves with its (JSON) result. */
  function host(fn, arg) {
    return new Promise(function (resolve) {
      var call = fn + '(' + (arg === undefined ? '' : JSON.stringify(String(arg))) + ')';
      if (!window.__adobe_cep__) { resolve(JSON.stringify({ ok: false, error: 'Open this panel inside Premiere Pro.' })); return; }
      window.__adobe_cep__.evalScript(call, function (res) { resolve(res); });
    });
  }
  function parse(s) { try { return JSON.parse(s); } catch (e) { return { ok: false, error: String(s || 'No response from Premiere') }; } }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function updateBuild() { $('build').disabled = !(state.tplOk && state.t1); }

  function check() {
    $('tpl').innerHTML = 'Checking…';
    host('fb_inspect').then(function (r) {
      var j = parse(r);
      state.tplOk = !!j.ok;
      $('tpl').innerHTML = j.ok
        ? '<span class="good">✓</span> <b>' + esc(j.name) + '</b> · ' + j.slots + ' question slides found' +
          (j.missingSlots && j.missingSlots.length ? '<br><span class="warn">No slide for ' + esc(j.missingSlots.join(', ')) + '</span>' : '')
        : '<span class="bad">' + esc(j.error) + '</span>';
      updateBuild();
    });
  }

  function suggestName() {
    var t = state.t1 || state.t2;
    if (!t || !t.month) return;
    var m = NEXT_YEAR_MONTHS.indexOf(t.month.toLowerCase());
    var now = new Date();
    var year = now.getFullYear() + (m >= 0 && m < now.getMonth() ? 1 : 0);
    var month = t.month.charAt(0).toUpperCase() + t.month.slice(1).toLowerCase();
    $('seqName').value = 'Fishbowl-' + month + '-' + year + '-v01';
  }

  function pick(n) {
    host('fb_pickFolder', 'Choose Tribute ' + n + "'s folder (e.g. 01 January - Colin Knox)").then(function (path) {
      if (!path) return;
      host('fb_scan', path).then(function (r) {
        var j = parse(r);
        $('path' + n).textContent = path;
        $('path' + n).title = path;
        if (!j.ok) { $('who' + n).innerHTML = '<span class="bad">' + esc(j.error) + '</span>'; state['t' + n] = null; updateBuild(); return; }
        state['t' + n] = j;
        var html = '<b>' + esc(j.name) + '</b>' + (j.month ? ' · ' + esc(j.month) : '') +
          '<div class="meta">' + j.count + ' of 16 answers · ' + j.photos.length + ' photo' + (j.photos.length === 1 ? '' : 's') + '</div>';
        if (j.missing.length) html += '<div class="warn">Missing: ' + esc(j.missing.join(', ')) + '</div>';
        if (j.webm.length) html += '<div class="warn">' + j.webm.length + ' WebM file(s): may need converting</div>';
        $('who' + n).innerHTML = html;
        suggestName();
        updateBuild();
      });
    });
  }

  /** The panel's own folder on disk (for the bundled ffmpeg). */
  function extensionDir() {
    try {
      var p = decodeURI(window.__adobe_cep__.getSystemPath('extension'));
      return p.replace(/^file:\/\//, '');
    } catch (e) { return ''; }
  }

  /** Measures loudness + dead air for every answer clip. Resolves {map, note}. */
  function analyzeClips(log) {
    var wantTrim = $('optTrim').checked, wantLevel = $('optLevel').checked;
    if (!wantTrim && !wantLevel) return Promise.resolve({ map: {}, note: '' });
    if (typeof require !== 'function' || !window.FishbowlAnalyze) return Promise.resolve({ map: {}, note: 'Audio cleanup skipped: this panel can\'t run tools (reinstall it).' });
    var ffmpeg = window.FishbowlAnalyze.findFfmpeg(extensionDir());
    if (!ffmpeg) return Promise.resolve({ map: {}, note: 'Audio cleanup skipped: ffmpeg not found. Re-run the installer.' });
    var files = [];
    [state.t1, state.t2].forEach(function (t) { if (!t) return; for (var k in t.clips) { if (Object.prototype.hasOwnProperty.call(t.clips, k)) files.push(t.clips[k]); } });
    var opts = { targetLufs: Number($('target').value) || -16, padBefore: Number($('padBefore').value) || 0.4, padAfter: Number($('padAfter').value) || 0.6,
      cutPauses: $('optPauses').checked && $('optTrim').checked, maxPause: Number($('maxPause').value) || 0.8 };
    return new Promise(function (resolve) {
      window.FishbowlAnalyze.analyzeAll(ffmpeg, files, opts, function (done, total) {
        log('Listening to answers… ' + done + ' of ' + total);
      }, function (map) { resolve({ map: map, note: '' }); });
    });
  }

  function build() {
    var btn = $('build');
    btn.disabled = true; btn.textContent = 'Building…';
    $('log').innerHTML = '';
    var status = function (t) { $('log').innerHTML = '<span class="meta">' + esc(t) + '</span>'; };
    analyzeClips(status).then(function (an) {
      status('Building the sequence in Premiere… (about a minute)');
      var errs = 0, saved = 0;
      for (var f in an.map) { if (an.map[f].error) errs++; else if (an.map[f].trimmed) saved += an.map[f].dur - (an.map[f].outSec - an.map[f].inSec); }
      var args = JSON.stringify({ t1: state.t1 ? state.t1.path : '', t2: state.t2 ? state.t2.path : '',
        seqName: $('seqName').value.trim() || 'Fishbowl-v01', analysis: an.map, trim: $('optTrim').checked, level: $('optLevel').checked });
      return host('fb_build', args).then(function (r) {
        var j = parse(r);
        btn.textContent = 'Build sequence'; updateBuild();
        if (!j.ok) { $('log').innerHTML = '<span class="bad">' + esc(j.error || 'Something went wrong.') + '</span>'; return; }
        var out = ['<span class="h">✓ Built ' + esc(j.seqName) + '</span>',
          'Placed ' + j.placed + ' of ' + j.expected + ' answers for ' + esc((j.tributes || []).join(' + ')) + '.' +
          (j.scaled ? ' Scaled ' + j.scaled + ' to fit the frame.' : '')];
        if (j.trimmed) out.push('Cut ' + Math.round(j.trimmedSecs) + ' s of dead air from ' + j.trimmed + ' answers' + (j.pausesCut ? ', including ' + j.pausesCut + ' long pauses' : '') + '. Drag a clip\'s edge to get any back.');
        if (j.leveled) out.push('Leveled ' + j.leveled + ' answers to ' + ($('target').value || -16) + ' LUFS.');
        if (an.note) out.push('<span class="warn">' + esc(an.note) + '</span>');
        if (errs) out.push('<span class="warn">' + errs + ' clip(s) couldn\'t be analyzed; placed as is.</span>');
        if (j.photos) out.push(j.photos + ' photos are on V2 after the outro (yellow marker).');
        if (j.missing.length) out.push('<span class="warn">Missing (red markers): ' + esc(j.missing.join(', ')) + '</span>');
        if (j.musicEnds) out.push('<span class="warn">Music bed ends at ' + j.musicEnds + '; the video now runs to ' + j.videoEnds + '. Extend it (red marker).</span>');
        for (var i = 0; i < j.problems.length; i++) out.push('<span class="warn">' + esc(j.problems[i]) + '</span>');
        out.push('<span class="meta">Orange markers = Tribute 1, blue = Tribute 2. Press Shift+M to jump between them.</span>');
        $('log').innerHTML = out.join('\n');
      });
    });
  }

  $('check').addEventListener('click', check);
  $('pick1').addEventListener('click', function () { pick(1); });
  $('pick2').addEventListener('click', function () { pick(2); });
  $('build').addEventListener('click', build);
  $('refresh').addEventListener('click', function () {
    host('fb_refresh').then(function (r) {
      var j = parse(r);
      $('log').innerHTML = j.ok ? 'Refreshed ' + j.refreshed + ' tribute clips from disk.' : '<span class="bad">' + esc(j.error) + '</span>';
    });
  });
  setTimeout(check, 400);
})();
