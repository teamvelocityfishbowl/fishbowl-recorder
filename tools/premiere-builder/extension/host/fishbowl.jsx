/*
 * Fishbowl Builder: Premiere Pro host script (ExtendScript, ES3).
 *
 * Takes the Fishbowl template sequence and two tribute folders (as downloaded from
 * Drive: "01 January - Colin Knox/01 Intro.mp4, S1 ..., Q01 ..., Photos/"), then builds a
 * copy of the template with every answer cut in after its question slide:
 *
 *   Fishbowl-Intro  → 01 (T1) → 01 (T2) → Splash Round Intro → S1 (T1) → S1 (T2) → Splash Round 2 → …
 *   … → Question 11 → Q10 (T1) → Q10 (T2) → Outro            Photos go on V2 after the outro.
 *
 * Only V1/A1 change. Graphics (V2/V3) and the music bed (A2) are left exactly as they are.
 */

var FB = {};

// ------------------------------------------------------------------ small helpers (ES3)
FB.TPS = 254016000000; // Premiere ticks per second

FB.str = function (v) {
  // Minimal JSON.stringify (ExtendScript in Premiere has no JSON object)
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  if (Object.prototype.toString.call(v) === '[object Array]') {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(FB.str(v[i]));
    return '[' + a.join(',') + ']';
  }
  var parts = [];
  for (var k in v) { if (v.hasOwnProperty(k)) parts.push(FB.str(k) + ':' + FB.str(v[k])); }
  return '{' + parts.join(',') + '}';
};
FB.parse = function (s) { return eval('(' + s + ')'); };
FB.has = function (arr, x) { for (var i = 0; i < arr.length; i++) { if (arr[i] === x) return true; } return false; };
FB.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
FB.ticks = function (time) { return Number(time.ticks); };
FB.timeFromTicks = function (ticks) { var t = new Time(); t.ticks = String(Math.round(ticks)); return t; };
FB.secs = function (ticks) { return ticks / FB.TPS; };
FB.fmt = function (ticks) {
  var s = Math.max(0, ticks / FB.TPS), m = Math.floor(s / 60);
  return m + ':' + FB.pad2(Math.floor(s - m * 60));
};
FB.decode = function (name) { try { return decodeURI(name); } catch (e) { return name; } };

// ------------------------------------------------------------------ which slide is which question
// Answer files are named "<code> <title>.<ext>": 01, S1–S5, Q01–Q10.
FB.slotFor = function (name) {
  var n = String(name || '');
  if (/fishbowl-?intro/i.test(n)) return '01';
  if (/outro/i.test(n)) return null;
  if (/splash\s*round\s*intro/i.test(n)) return 'S1';
  var m = n.match(/splash\s*round\s*(\d+)/i);
  if (m) return 'S' + Number(m[1]);
  m = n.match(/question\s*(\d+)/i);
  if (m) { var q = Number(m[1]); return q <= 1 ? '01' : 'Q' + FB.pad2(q - 1); }
  return null;
};
FB.ORDER = ['01', 'S1', 'S2', 'S3', 'S4', 'S5', 'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10'];

/** Slide clips on V1 in timeline order: [{id, name, start, end}] (ticks). One per question code. */
FB.slots = function (seq) {
  var v1 = seq.videoTracks[0], out = [], seen = {};
  for (var i = 0; i < v1.clips.numItems; i++) {
    var c = v1.clips[i];
    var nm = c.projectItem ? c.projectItem.name : c.name;
    var id = FB.slotFor(nm);
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push({ id: id, name: nm, start: FB.ticks(c.start), end: FB.ticks(c.end) });
  }
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
};

// ------------------------------------------------------------------ tribute folders
/** Reads "01 January - Colin Knox" style folders. */
FB.scanFolder = function (path) {
  var f = new Folder(path);
  if (!f.exists) return { ok: false, error: 'Folder not found: ' + path };
  var label = FB.decode(f.name);
  var m = label.match(/^\s*(\d{1,2})\s+([A-Za-z]+)\s*-\s*(.+?)\s*$/);
  var info = { ok: true, path: f.fsName, folderName: label, name: m ? m[3] : label, month: m ? m[2] : '',
               clips: {}, photos: [], skipped: [], webm: [] };
  var files = f.getFiles();
  for (var i = 0; i < files.length; i++) {
    var it = files[i], nm = FB.decode(it.name);
    if (it instanceof Folder) {
      if (/^photos$/i.test(nm)) {
        var ph = it.getFiles();
        for (var j = 0; j < ph.length; j++) {
          var pn = FB.decode(ph[j].name);
          if (ph[j] instanceof File && /\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(pn)) info.photos.push(ph[j].fsName);
        }
        info.photos.sort();
      }
      continue;
    }
    if (nm.charAt(0) === '.') continue;
    var mm = nm.match(/^(01|S[1-5]|Q(0[1-9]|10))\s.*\.(mp4|mov|m4v|webm)$/i);
    if (!mm) { if (!/^(_|desktop\.ini)/i.test(nm)) info.skipped.push(nm); continue; }
    var code = mm[1].toUpperCase();
    if (/\.webm$/i.test(nm)) info.webm.push(nm);
    // If two files share a code (old + new take synced), keep the newest
    if (info.clips[code]) {
      var prev = new File(info.clips[code]);
      if (prev.modified && it.modified && prev.modified > it.modified) continue;
    }
    info.clips[code] = it.fsName;
  }
  var missing = [];
  for (var k = 0; k < FB.ORDER.length; k++) { if (!info.clips[FB.ORDER[k]]) missing.push(FB.ORDER[k]); }
  info.missing = missing;
  info.count = FB.ORDER.length - missing.length;
  return info;
};

// ------------------------------------------------------------------ project helpers
FB.findBin = function (parent, name) {
  for (var i = 0; i < parent.children.numItems; i++) {
    var c = parent.children[i];
    if (c && c.type === ProjectItemType.BIN && c.name === name) return c;
  }
  return null;
};
FB.bin = function (parent, name) {
  var b = FB.findBin(parent, name);
  if (b) return b;
  var made = parent.createBin(name);
  return made || FB.findBin(parent, name);
};
FB.findItem = function (bin, fileName) {
  for (var i = 0; i < bin.children.numItems; i++) {
    var c = bin.children[i];
    if (c && c.type !== ProjectItemType.BIN && c.name === fileName) return c;
  }
  return null;
};
FB.fileName = function (path) { var p = String(path).split(/[\\\/]/); return p[p.length - 1]; };

/** Imports files into a bin and returns {path: projectItem}. Reuses items already there. */
FB.importInto = function (bin, paths, report) {
  var need = [], out = {};
  for (var i = 0; i < paths.length; i++) { if (!FB.findItem(bin, FB.fileName(paths[i]))) need.push(paths[i]); }
  if (need.length) app.project.importFiles(need, true, bin, false);
  for (var j = 0; j < paths.length; j++) {
    var item = FB.findItem(bin, FB.fileName(paths[j]));
    if (item) out[paths[j]] = item; else report.problems.push('Couldn\'t import ' + FB.fileName(paths[j]));
  }
  return out;
};

FB.sequenceIds = function () {
  var ids = [];
  for (var i = 0; i < app.project.sequences.numSequences; i++) ids.push(app.project.sequences[i].sequenceID);
  return ids;
};

/** Every clip on tracks other than V1/A1, so we can prove they weren't touched. */
FB.snapshotOthers = function (seq) {
  var s = [];
  for (var v = 1; v < seq.videoTracks.numTracks; v++) {
    for (var i = 0; i < seq.videoTracks[v].clips.numItems; i++) {
      var c = seq.videoTracks[v].clips[i];
      s.push('V' + (v + 1) + '|' + c.start.ticks + '|' + c.end.ticks);
    }
  }
  for (var a = 1; a < seq.audioTracks.numTracks; a++) {
    for (var j = 0; j < seq.audioTracks[a].clips.numItems; j++) {
      var d = seq.audioTracks[a].clips[j];
      s.push('A' + (a + 1) + '|' + d.start.ticks + '|' + d.end.ticks);
    }
  }
  return s.join(';');
};

FB.frameTicks = function (seq) {
  try { return Number(seq.timebase) || FB.TPS / 30; } catch (e) { return FB.TPS / 30; }
};

/**
 * The template leaves a gap after the intro (where the intro answers go). Close any gap that
 * sits between slides on V1/A1 by sliding everything after it to the left.
 */
FB.closeGaps = function (seq, report) {
  var frame = FB.frameTicks(seq);
  var guard = 0;
  while (guard++ < 40) {
    var v1 = seq.videoTracks[0];
    var clips = [];
    for (var i = 0; i < v1.clips.numItems; i++) clips.push(v1.clips[i]);
    clips.sort(function (a, b) { return FB.ticks(a.start) - FB.ticks(b.start); });
    var gapAt = -1, gap = 0;
    for (var k = 1; k < clips.length; k++) {
      var g = FB.ticks(clips[k].start) - FB.ticks(clips[k - 1].end);
      if (g > frame / 2) { gapAt = FB.ticks(clips[k].start); gap = g; break; }
    }
    if (gapAt < 0) return true;
    if (!FB.shiftAfter(seq, gapAt, -gap)) { report.problems.push('Couldn\'t close the gap at ' + FB.fmt(gapAt - gap) + '. Select it and press Delete.'); return false; }
    // Did it work?
    var after = FB.findClipStartingNear(seq.videoTracks[0], gapAt - gap, frame);
    if (!after) { report.problems.push('Couldn\'t close the gap at ' + FB.fmt(gapAt - gap) + '. Select it and press Delete.'); return false; }
  }
  return true;
};

FB.findClipStartingNear = function (track, ticks, tol) {
  for (var i = 0; i < track.clips.numItems; i++) {
    if (Math.abs(FB.ticks(track.clips[i].start) - ticks) <= tol) return track.clips[i];
  }
  return null;
};

/** Moves every V1 and A1 clip that starts at/after `fromTicks` by `delta` ticks (earliest first). */
FB.shiftAfter = function (seq, fromTicks, delta) {
  var frame = FB.frameTicks(seq);
  var tracks = [seq.videoTracks[0], seq.audioTracks[0]];
  // Remember where every affected clip started, before any move (linked clips may move together)
  var plan = [];
  for (var t = 0; t < tracks.length; t++) {
    for (var i = 0; i < tracks[t].clips.numItems; i++) {
      var c = tracks[t].clips[i], st = FB.ticks(c.start);
      if (st >= fromTicks - frame / 2) plan.push({ track: t, start: st });
    }
  }
  plan.sort(function (a, b) { return a.start - b.start || a.track - b.track; });
  for (var p = 0; p < plan.length; p++) {
    var tr = tracks[plan[p].track];
    var clip = FB.findClipStartingNear(tr, plan[p].start, frame / 4);
    if (!clip) continue; // already moved with its linked partner
    clip.move(FB.secs(delta));
    if (p === 0 && !FB.findClipStartingNear(tr, plan[p].start + delta, frame / 2)) return false; // move() didn't do what we expect: stop
  }
  return true;
};

/** Inserts a project item on V1/A1 at `ticks`, pushing everything after it later. */
FB.insertAt = function (seq, item, ticks) {
  var t = FB.timeFromTicks(ticks);
  try {
    return seq.insertClip(item, t, 0, 0) || true;
  } catch (e) {
    return seq.videoTracks[0].insertClip(item, FB.secs(ticks));
  }
};

/** Frame size of a project item ("1280 x 720") from its metadata, or null. */
FB.mediaSize = function (item) {
  try {
    var md = item.getProjectMetadata();
    var m = md.match(/VideoInfo>\s*(\d+)\s*x\s*(\d+)/i) || md.match(/(\d{3,5})\s*x\s*(\d{3,5})/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  } catch (e) {}
  return null;
};

/**
 * Scales a clip so it fits the sequence frame (like "Set to Frame Size": 720p in a 1080p sequence = 150%).
 * Returns true if the scale was set.
 */
FB.fitToFrame = function (seq, clip) {
  try {
    var size = FB.mediaSize(clip.projectItem);
    var sw = Number(seq.frameSizeHorizontal), sh = Number(seq.frameSizeVertical);
    if (!size || !sw || !sh || !size.w || !size.h) return false;
    var scale = Math.min(sw / size.w, sh / size.h) * 100;
    if (Math.abs(scale - 100) < 0.01) return true;
    for (var i = 0; i < clip.components.numItems; i++) {
      var comp = clip.components[i];
      if (comp.displayName !== 'Motion' && comp.matchName !== 'AE.ADBE Motion') continue;
      var p = comp.properties.getParamForDisplayName('Scale');
      if (!p) { for (var k = 0; k < comp.properties.numItems; k++) { if (comp.properties[k].displayName === 'Scale') p = comp.properties[k]; } }
      if (p) { p.setValue(Math.round(scale * 100) / 100, true); return true; }
    }
  } catch (e) {}
  return false;
};

/**
 * Trims a project item to [inSec, outSec] so the insert only brings in the talking part.
 * The docs disagree on seconds vs ticks, so set it, read it back, and fall back to ticks.
 */
FB.setInOut = function (item, inSec, outSec) {
  function close(t, want) { try { return Math.abs(Number(t.seconds) - want) < 0.05; } catch (e) { return false; } }
  try {
    item.setInPoint(inSec, 4);
    if (!close(item.getInPoint(), inSec)) item.setInPoint(String(Math.round(inSec * FB.TPS)), 4);
    item.setOutPoint(outSec, 4);
    if (!close(item.getOutPoint(), outSec)) item.setOutPoint(String(Math.round(outSec * FB.TPS)), 4);
    return close(item.getInPoint(), inSec) && close(item.getOutPoint(), outSec);
  } catch (e) { return false; }
};

/** Sets a timeline audio clip's Volume > Level to `db` (Premiere stores 10^((dB-15)/20); max +15 dB). */
FB.setLevelDb = function (clip, db) {
  try {
    for (var i = 0; i < clip.components.numItems; i++) {
      var comp = clip.components[i];
      var isVol = /^Internal Volume/i.test(String(comp.matchName || '')) || comp.displayName === 'Volume';
      if (!isVol) continue;
      var p = comp.properties.getParamForDisplayName ? comp.properties.getParamForDisplayName('Level') : null;
      if (!p) { for (var k = 0; k < comp.properties.numItems; k++) { if (/^level$/i.test(comp.properties[k].displayName)) p = comp.properties[k]; } }
      if (!p) continue;
      try { if (p.isTimeVarying && p.isTimeVarying()) return false; } catch (e0) {}
      var v = Math.pow(10, (Math.min(15, db) - 15) / 20);
      p.setValue(v, true);
      return true;
    }
  } catch (e) {}
  return false;
};

FB.MARKER = { t1: 3 /* orange */, t2: 6 /* blue */, warn: 1 /* red */, photos: 4 /* yellow */ };

FB.addMarker = function (seq, ticks, name, color, comment) {
  try {
    var m = seq.markers.createMarker(FB.secs(ticks));
    m.name = name;
    if (comment) m.comments = comment;
    try { m.setColorByIndex(color); } catch (e) {}
  } catch (e2) {}
};

// ------------------------------------------------------------------ entry points (called by the panel)

function fb_pickFolder(prompt) {
  var f = Folder.selectDialog(prompt || 'Choose a tribute folder');
  return f ? f.fsName : '';
}

function fb_scan(path) { return FB.str(FB.scanFolder(path)); }

/** Checks the active sequence looks like the Fishbowl template. */
function fb_inspect() {
  var seq = app.project ? app.project.activeSequence : null;
  if (!seq) return FB.str({ ok: false, error: 'Open the Fishbowl template sequence first (double-click it in the Project panel).' });
  var slots = FB.slots(seq), ids = [];
  for (var i = 0; i < slots.length; i++) ids.push(slots[i].id);
  var missing = [];
  for (var k = 0; k < FB.ORDER.length; k++) { if (!FB.has(ids, FB.ORDER[k])) missing.push(FB.ORDER[k]); }
  return FB.str({ ok: slots.length >= 10, name: seq.name, slots: slots.length, missingSlots: missing,
    error: slots.length >= 10 ? '' : 'This sequence doesn\'t look like the Fishbowl template (found ' + slots.length + ' question slides).' });
}

/**
 * Builds the sequence. args = {t1: path, t2: path, seqName: string}
 * Returns a report the panel shows.
 */
function fb_build(argsJson) {
  var a = FB.parse(argsJson);
  var report = { ok: false, placed: 0, expected: 0, missing: [], problems: [], photos: 0, scaled: 0, notScaled: 0,
                 trimmed: 0, trimmedSecs: 0, pausesCut: 0, trimFailed: 0, leveled: 0, levelFailed: 0, maxedOut: [], seqName: a.seqName };
  try {
    var tpl = app.project.activeSequence;
    if (!tpl) { report.error = 'Open the Fishbowl template sequence first.'; return FB.str(report); }
    if (FB.slots(tpl).length < 10) { report.error = 'The open sequence doesn\'t look like the Fishbowl template.'; return FB.str(report); }

    var tributes = [];
    var paths = [a.t1, a.t2];
    for (var p = 0; p < paths.length; p++) {
      if (!paths[p]) continue;
      var info = FB.scanFolder(paths[p]);
      if (!info.ok) { report.error = info.error; return FB.str(report); }
      tributes.push(info);
    }
    if (!tributes.length) { report.error = 'Choose at least one tribute folder.'; return FB.str(report); }

    // 1) Copy the template, so the template itself is never changed
    var before = FB.sequenceIds();
    tpl.clone();
    var seq = null;
    for (var s = 0; s < app.project.sequences.numSequences; s++) {
      var cand = app.project.sequences[s];
      if (!FB.has(before, cand.sequenceID)) { seq = cand; break; }
    }
    if (!seq) { report.error = 'Couldn\'t copy the template sequence.'; return FB.str(report); }
    try { seq.name = a.seqName; } catch (e) { try { seq.projectItem.name = a.seqName; } catch (e2) {} }
    app.project.openSequence(seq.sequenceID);
    seq = app.project.activeSequence || seq;

    // 2) Import each tribute's clips and photos into their own bins
    var vidRoot = FB.bin(app.project.rootItem, 'Video Interviews');
    var picRoot = FB.bin(app.project.rootItem, 'Pictures');
    for (var t = 0; t < tributes.length; t++) {
      var tr = tributes[t];
      var bin = FB.bin(vidRoot, tr.folderName);
      var list = [];
      for (var code in tr.clips) { if (tr.clips.hasOwnProperty(code)) list.push(tr.clips[code]); }
      var items = FB.importInto(bin, list, report);
      tr.items = {};
      for (var code2 in tr.clips) { if (tr.clips.hasOwnProperty(code2) && items[tr.clips[code2]]) tr.items[code2] = items[tr.clips[code2]]; }
      if (tr.photos.length) {
        var pbin = FB.bin(picRoot, tr.name);
        var pitems = FB.importInto(pbin, tr.photos, report);
        tr.photoItems = [];
        for (var q = 0; q < tr.photos.length; q++) { if (pitems[tr.photos[q]]) tr.photoItems.push(pitems[tr.photos[q]]); }
      } else tr.photoItems = [];
      for (var w = 0; w < tr.webm.length; w++) report.problems.push(tr.name + ': ' + tr.webm[w] + ' is WebM. If it won\'t play, convert it with tools/convert-for-premiere.sh.');
    }

    // 3) Close the template's placeholder gap after the intro
    var othersBefore = FB.snapshotOthers(seq);
    FB.closeGaps(seq, report);

    // 4) Cut each answer in after its slide: last slide first, so earlier positions stay put.
    //    At each slide end we insert Tribute 2, then Tribute 1 at the same spot (T1 lands first).
    var slots = FB.slots(seq);
    var missingAt = [];
    var an_ = a.analysis || {};
    for (var i = slots.length - 1; i >= 0; i--) {
      for (var r = tributes.length - 1; r >= 0; r--) {
        var item = tributes[r].items[slots[i].id];
        report.expected++;
        if (!item) { report.missing.push(tributes[r].name + ' ' + slots[i].id); missingAt.push({ r: r, id: slots[i].id }); continue; }
        var an = an_[tributes[r].clips[slots[i].id]];
        if (an && an.trimmed && a.trim && an.segments && an.segments.length > 1) {
          // Pauses cut: place each kept piece back to back (last piece first, all at the same spot)
          var okSegs = true;
          for (var g = an.segments.length - 1; g >= 0; g--) {
            if (!FB.setInOut(item, an.segments[g].inSec, an.segments[g].outSec)) { okSegs = false; break; }
            FB.insertAt(seq, item, slots[i].end);
          }
          if (okSegs) { report.trimmed++; report.pausesCut += an.pausesCut || 0; report.trimmedSecs += an.removedSecs || 0; report.placed++; continue; }
          report.trimFailed++; // fall through: place it whole (any pieces already placed stay; they're marked)
        }
        if (an && an.trimmed && a.trim && !(an.segments && an.segments.length > 1)) {
          if (FB.setInOut(item, an.inSec, an.outSec)) { report.trimmed++; report.trimmedSecs += (an.dur - (an.outSec - an.inSec)); }
          else report.trimFailed++;
        }
        FB.insertAt(seq, item, slots[i].end);
        report.placed++;
      }
    }
    var othersAfter = FB.snapshotOthers(seq);
    if (othersAfter !== othersBefore) report.problems.push('Something on V2/V3 or A2+ moved during the build. Check the music bed and intro names.');

    // 4b) Even out voices: set each answer's Volume level from its measured loudness
    if (a.level) {
      var a1 = seq.audioTracks[0];
      for (var ac = 0; ac < a1.clips.numItems; ac++) {
        var aclip = a1.clips[ac];
        if (!aclip.projectItem) continue;
        for (var tu = 0; tu < tributes.length; tu++) {
          for (var cd in tributes[tu].items) {
            if (!tributes[tu].items.hasOwnProperty(cd) || tributes[tu].items[cd].nodeId !== aclip.projectItem.nodeId) continue;
            var info2 = an_[tributes[tu].clips[cd]];
            if (!info2 || info2.lufs === null || info2.lufs === undefined) continue;
            if (FB.setLevelDb(aclip, info2.gainDb)) {
              report.leveled++;
              if (info2.gainDb >= 15) report.maxedOut.push(tributes[tu].name + ' ' + cd);
            } else report.levelFailed++;
          }
        }
      }
    }

    // 5) Markers on every answer (orange = Tribute 1, blue = Tribute 2) and on missing ones
    var v1 = seq.videoTracks[0];
    var lastEnd = 0, marked = {};
    for (var c = 0; c < v1.clips.numItems; c++) {
      var clip = v1.clips[c];
      lastEnd = Math.max(lastEnd, FB.ticks(clip.end));
      for (var u = 0; u < tributes.length; u++) {
        for (var code3 in tributes[u].items) {
          if (!tributes[u].items.hasOwnProperty(code3)) continue;
          if (clip.projectItem && clip.projectItem.nodeId === tributes[u].items[code3].nodeId) {
            if (FB.fitToFrame(seq, clip)) report.scaled++; else report.notScaled++;
            if (marked[clip.projectItem.nodeId]) continue; // one marker per answer, on its first piece
            marked[clip.projectItem.nodeId] = true;
            FB.addMarker(seq, FB.ticks(clip.start), tributes[u].name + ' · ' + clip.projectItem.name.replace(/\.[^.]+$/, ''),
              u === 0 ? FB.MARKER.t1 : FB.MARKER.t2);
          }
        }
      }
    }
    var slotsAfter = FB.slots(seq);
    for (var mi = 0; mi < missingAt.length; mi++) {
      var miss = missingAt[mi];
      for (var si = 0; si < slotsAfter.length; si++) {
        if (slotsAfter[si].id !== miss.id) continue;
        // Where this answer would have gone: after the slide and any earlier tribute's answer
        var spot = slotsAfter[si].end;
        for (var before = 0; before < miss.r; before++) {
          if (!tributes[before].items[miss.id]) continue;
          var nextClip = FB.findClipStartingNear(seq.videoTracks[0], spot, FB.frameTicks(seq));
          if (nextClip) spot = FB.ticks(nextClip.end);
        }
        FB.addMarker(seq, spot, 'MISSING: ' + tributes[miss.r].name + ' ' + miss.id, FB.MARKER.warn,
          'No recording found for this answer. Drop it in by hand, or ask for it with Request a redo.');
      }
    }

    // 6) Photos on V2, after everything, ready to drag into place
    if (seq.videoTracks.numTracks > 1) {
      var v2 = seq.videoTracks[1];
      var at = lastEnd + FB.TPS; // 1 s after the outro
      for (var pt = 0; pt < tributes.length; pt++) {
        var photos = tributes[pt].photoItems;
        if (!photos.length) continue;
        FB.addMarker(seq, at, tributes[pt].name + ' photos', FB.MARKER.photos, photos.length + ' photos. Drag them over the answers they go with.');
        for (var ph = 0; ph < photos.length; ph++) {
          v2.overwriteClip(photos[ph], FB.secs(at));
          var placed = FB.findClipStartingNear(v2, at, FB.frameTicks(seq));
          if (placed) FB.fitToFrame(seq, placed);
          at = placed ? FB.ticks(placed.end) : at + 5 * FB.TPS;
          report.photos++;
        }
        at += FB.TPS;
      }
    }

    // 7) The music bed ends where the template left it: flag it if the video is now longer
    var a2 = seq.audioTracks.numTracks > 1 ? seq.audioTracks[1] : null;
    if (a2 && a2.clips.numItems) {
      var musicEnd = 0;
      for (var mc = 0; mc < a2.clips.numItems; mc++) musicEnd = Math.max(musicEnd, FB.ticks(a2.clips[mc].end));
      if (musicEnd < lastEnd) {
        FB.addMarker(seq, musicEnd, 'Music bed ends here', FB.MARKER.warn, 'Extend the music to ' + FB.fmt(lastEnd) + ' (end of the outro).');
        report.musicEnds = FB.fmt(musicEnd);
        report.videoEnds = FB.fmt(lastEnd);
      }
    }

    if (report.trimFailed) report.problems.push(report.trimFailed + ' clip(s) couldn\'t be trimmed automatically; they were placed in full.');
    if (report.levelFailed) report.problems.push(report.levelFailed + ' clip(s) couldn\'t be leveled automatically.');
    if (report.maxedOut.length) report.problems.push('Very quiet, boosted the max (+15 dB): ' + report.maxedOut.join(', ') + '. Add Audio Gain if they still need it.');
    if (report.notScaled) report.problems.push(report.notScaled + ' answer clip(s) couldn\'t be auto-scaled. Right-click → Set to Frame Size.');
    report.ok = true;
    report.tributes = [];
    for (var z = 0; z < tributes.length; z++) report.tributes.push(tributes[z].name);
    return FB.str(report);
  } catch (err) {
    report.error = 'Stopped: ' + err.toString() + (err.line ? ' (line ' + err.line + ')' : '');
    return FB.str(report);
  }
}

/** Re-reads every tribute clip from disk (after a redo comes in through Drive). */
function fb_refresh() {
  var vid = FB.findBin(app.project.rootItem, 'Video Interviews');
  if (!vid) return FB.str({ ok: false, error: 'No "Video Interviews" bin found.' });
  var n = 0;
  for (var i = 0; i < vid.children.numItems; i++) {
    var b = vid.children[i];
    if (!b || b.type !== ProjectItemType.BIN) continue;
    for (var j = 0; j < b.children.numItems; j++) {
      var it = b.children[j];
      if (it && it.type !== ProjectItemType.BIN) { try { it.refreshMedia(); n++; } catch (e) {} }
    }
  }
  return FB.str({ ok: true, refreshed: n });
}
