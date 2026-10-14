/*
 * Fishbowl Builder: audio analysis (runs in the panel's Node.js, using ffmpeg).
 * For each answer clip it measures:
 *   - loudness (integrated LUFS)            → how much to raise/lower the clip to hit the target
 *   - where talking starts and stops        → in/out points that cut the dead air, plus padding
 * Nothing is re-encoded; Premiere just gets in/out points and a volume level.
 */
(function (root) {
  'use strict';

  var DEFAULTS = { targetLufs: -16, padBefore: 0.4, padAfter: 0.6, minGap: 0.35, maxBoost: 15, maxCut: -15,
                   cutPauses: true, maxPause: 0.8, pauseKeep: 0.25 };

  function run(ffmpeg, args, cb) {
    var cp = require('child_process');
    cp.execFile(ffmpeg, args, { maxBuffer: 32 * 1024 * 1024 }, function (err, stdout, stderr) {
      // ffmpeg writes its reports to stderr and exits 0; a non-zero exit is a real failure
      if (err && !stderr) return cb(err);
      cb(null, String(stderr || ''));
    });
  }

  function duration(text) {
    var m = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  }

  function loudness(text) {
    var m = text.match(/\{[\s\S]*"input_i"[\s\S]*?\}/);
    if (!m) return null;
    try {
      var j = JSON.parse(m[0]);
      var i = Number(j.input_i);
      return isFinite(i) ? { i: i, thresh: Number(j.input_thresh) } : null;
    } catch (e) { return null; }
  }

  /** Silence intervals [{start, end}] from silencedetect output (end = null if it runs to the end). */
  function silences(text) {
    var out = [], cur = null, re = /silence_(start|end):\s*(-?[\d.]+)/g, m;
    while ((m = re.exec(text))) {
      var t = Math.max(0, Number(m[2]));
      if (m[1] === 'start') { cur = { start: t, end: null }; out.push(cur); }
      else if (cur) { cur.end = t; cur = null; }
    }
    return out;
  }

  /** Where speech starts/ends, given silence intervals and the clip length. */
  function speechSpan(sil, dur) {
    var start = 0, end = dur;
    if (sil.length && sil[0].start <= 0.05) start = sil[0].end === null ? dur : sil[0].end;
    var last = sil[sil.length - 1];
    if (last && (last.end === null || last.end >= dur - 0.05)) end = Math.min(end, last.start);
    return { start: start, end: end };
  }

  /**
   * Analyzes one file. cb(err, {dur, lufs, gainDb, inSec, outSec, trimmed})
   */
  function analyzeFile(ffmpeg, file, opts, cb) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-sn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], function (err, t1) {
      if (err) return cb(err);
      var dur = duration(t1), loud = loudness(t1);
      if (!dur) return cb(new Error('Couldn\'t read ' + file));
      var res = { dur: dur, lufs: loud ? loud.i : null, gainDb: 0, inSec: 0, outSec: dur, trimmed: false };
      if (loud && loud.i > -60) {
        res.gainDb = Math.max(opts.maxCut, Math.min(opts.maxBoost, Math.round((opts.targetLufs - loud.i) * 10) / 10));
      }
      // "Silence" = quieter than ~20 dB under their own speaking level (clamped to sane bounds)
      var noise = loud && loud.i > -60 ? Math.max(-60, Math.min(-35, loud.i - 20)) : -45;
      run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-sn', '-af', 'silencedetect=noise=' + noise + 'dB:d=' + opts.minGap, '-f', 'null', '-'], function (err2, t2) {
        if (err2) return cb(null, res);
        var sil = silences(t2);
        var span = speechSpan(sil, dur);
        var r3 = function (x) { return Math.round(x * 1000) / 1000; };
        if (span.end - span.start >= 0.3) { // found real speech
          var inS = Math.max(0, span.start - opts.padBefore);
          var outS = Math.min(dur, span.end + opts.padAfter);
          if (inS > 0.05 || outS < dur - 0.05) {
            res.inSec = r3(inS);
            res.outSec = r3(outS);
            res.trimmed = true;
          }
          // Long pauses inside the answer: cut them down, keeping a little air on each side
          if (opts.cutPauses) {
            var segs = [], cur = inS;
            for (var k = 0; k < sil.length; k++) {
              var q = sil[k];
              if (q.end === null || q.start <= span.start + 0.01 || q.end >= span.end - 0.01) continue;
              if (q.end - q.start < opts.maxPause) continue;
              var cutFrom = q.start + opts.pauseKeep, cutTo = q.end - opts.pauseKeep;
              if (cutTo - cutFrom < 0.2) continue;
              if (cutFrom - cur >= 0.2) segs.push({ inSec: r3(cur), outSec: r3(cutFrom) });
              cur = cutTo;
            }
            if (segs.length) {
              segs.push({ inSec: r3(cur), outSec: r3(outS) });
              res.segments = segs;
              res.pausesCut = segs.length - 1;
              res.trimmed = true;
            }
          }
        }
        var kept = res.segments ? res.segments.reduce(function (t, g) { return t + g.outSec - g.inSec; }, 0) : res.outSec - res.inSec;
        res.removedSecs = r3(dur - kept);
        res.noiseDb = noise;
        cb(null, res);
      });
    });
  }

  /** Analyzes many files, a few at a time. onProgress(done, total). cb(resultsByPath) */
  function analyzeAll(ffmpeg, files, opts, onProgress, cb) {
    var results = {}, i = 0, done = 0, active = 0, total = files.length;
    if (!total) return cb(results);
    function next() {
      while (active < 3 && i < total) {
        (function (f) {
          active++;
          analyzeFile(ffmpeg, f, opts, function (err, r) {
            results[f] = err ? { error: String(err.message || err) } : r;
            active--; done++;
            if (onProgress) onProgress(done, total);
            if (done === total) cb(results); else next();
          });
        })(files[i++]);
      }
    }
    next();
  }

  /** Finds ffmpeg: the copy bundled with the panel first, then Homebrew. */
  function findFfmpeg(extensionDir) {
    var fs = require('fs');
    var list = [extensionDir + '/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    for (var k = 0; k < list.length; k++) { try { if (fs.existsSync(list[k])) return list[k]; } catch (e) {} }
    return null;
  }

  var api = { analyzeFile: analyzeFile, analyzeAll: analyzeAll, findFfmpeg: findFfmpeg, DEFAULTS: DEFAULTS,
              _speechSpan: speechSpan, _silences: silences };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FishbowlAnalyze = api;
})(typeof window !== 'undefined' ? window : this);
