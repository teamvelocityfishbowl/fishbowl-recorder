/* Fishbowl Recorder
 * One question at a time: count-in → record (auto-stops at the time limit) → review → use take.
 * Each take uploads in the background. Fast path: the backend hands out a one-time Drive upload
 * address and the video goes straight to Drive. Backup path: base64 pieces through the Apps Script backend.
 * No build step and no libraries: plain browser JavaScript.
 */
(() => {
  'use strict';

  const CFG = Object.assign({ backendUrl: '', videoBitsPerSecond: 1500000, audioBitsPerSecond: 96000 }, window.FISHBOWL_CONFIG || {});
  const params = new URLSearchParams(location.search);
  const TOKEN = (params.get('t') || '').trim();
  const PREVIEW = !CFG.backendUrl; // no backend configured → local preview, nothing uploads
  const CHUNK = 4 * 1024 * 1024;   // base64 characters per upload piece (multiple of 4)

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const S = {
    steps: [], photosCfg: { suggested: 3, max: 6 }, est: 15,
    who: null, idx: 0, done: new Set(),
    stream: null, mime: '', ext: 'webm',
    rec: null, parts: [], blob: null, blobUrl: '', timers: [],
    queue: [], uploading: false, uploadErr: '', savedCount: 0, waiters: [], pct: -1,
    direct: null, // null = not tried yet, true = straight-to-Drive works here, false = use pieces
    photos: [], audioCtx: null, meterRaf: 0, screen: 'loading',
    local: {},          // stepId → object URL of a take recorded in this visit (for watch-back)
    redo: new Set(),    // answers the Fishbowl team asked them to redo
    returnTo: null,     // 'list' when a question was opened from the All questions screen
    finished: false,    // true once they've reached the end (or were already Received)
  };

  // ---------------------------------------------------------------- art
  function bowlSvg(level = 0.55, mark = '?', opts = {}) {
    const stroke = opts.stroke || '#ffffff';
    const water = opts.water || '#a0d3e5';
    const ink = opts.ink || '#082642';
    const id = 'b' + Math.random().toString(36).slice(2, 8);
    const top = 92 - Math.max(0, Math.min(1, level)) * 64; // water surface y (28 → 92)
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
      <defs><clipPath id="${id}"><circle cx="50" cy="57" r="35"/></clipPath></defs>
      <g clip-path="url(#${id})">
        <path d="M0 ${top} Q 12.5 ${top - 4} 25 ${top} T 50 ${top} T 75 ${top} T 100 ${top} V 100 H 0 Z" fill="${water}">
          ${opts.still ? '' : `<animateTransform attributeName="transform" type="translate" values="0 0; -12 0; 0 0" dur="5s" repeatCount="indefinite"/>`}
        </path>
      </g>
      <path d="M31 25.5 A35 35 0 1 0 69 25.5" fill="none" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>
      <rect x="27" y="17" width="46" height="8" rx="4" fill="none" stroke="${stroke}" stroke-width="5"/>
      ${mark ? `<text x="50" y="69" text-anchor="middle" font-family="Trebuchet MS, Fira Sans, sans-serif" font-weight="700" font-size="34" fill="${ink}">${mark}</text>` : ''}
    </svg>`;
  }
  const svgUrl = (svg) => 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")';
  const SPLASH_ART = `<svg class="splash-art" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M40 150 C 20 110, 70 95, 82 120 C 90 70, 150 70, 140 118 C 175 100, 190 150, 160 170 C 130 195, 60 195, 40 150 Z" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>
    <path d="M70 60 C 66 42, 88 36, 92 52" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <path d="M128 48 C 132 30, 156 34, 150 52" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <circle cx="112" cy="28" r="6" fill="#fff"/><circle cx="55" cy="88" r="5" fill="#fff"/></svg>`;
  const ARROW = '<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  $('.brand-bowl').style.backgroundImage = svgUrl(bowlSvg(0.55, '', { still: true }));

  // Unmissable banner when the page isn't connected to the backend (nothing is saved)
  if (PREVIEW) {
    const bar = document.createElement('div');
    bar.className = 'preview-bar';
    bar.innerHTML = '⚠️ <b>PREVIEW MODE</b>: nothing you record is being saved. The backend URL is missing from src/config.js.';
    document.body.prepend(bar);
  }

  // ---------------------------------------------------------------- utils
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clearTimers = () => { S.timers.forEach((t) => { clearTimeout(t); clearInterval(t); cancelAnimationFrame(t); }); S.timers = []; };

  function show(name, html) {
    clearTimers();
    // Leaving a question mid-recording (or mid-countdown): drop that take
    if (S.rec && S.rec.state !== 'inactive' && name !== 'question') { S.rec.onstop = null; try { S.rec.stop(); } catch (e) {} keepAwake(false); }
    S.screen = name;
    app.innerHTML = `<section class="screen screen-${name}" data-screen="${name}">${html}</section>`;
    window.scrollTo(0, 0);
    updateRotate();
    setAllBtn(['question', 'photos', 'splashintro'].includes(name));
    return app.firstElementChild;
  }

  function setAllBtn(on) { const b = $('#allBtn'); if (b) b.hidden = !on; }

  function updateProgress() {
    const total = S.steps.length || 16;
    const n = S.done.size;
    const p = $('#progress');
    p.hidden = !['question', 'photos', 'done', 'list'].includes(S.screen);
    $('#progressLabel').textContent = S.screen === 'question' ? `${Math.min(S.idx + 1, total)} of ${total}` : `${n} of ${total} saved`;
    $('#progressBowl').style.backgroundImage = svgUrl(bowlSvg(0.08 + 0.86 * (n / total), '', { still: true }));
  }

  // ---------------------------------------------------------------- backend
  async function api(action, data = {}) {
    if (PREVIEW) return previewApi(action, data);
    const res = await fetch(CFG.backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request: no CORS preflight
      body: JSON.stringify(Object.assign({ action, t: TOKEN }, data)),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('Server responded ' + res.status);
    const json = await res.json();
    if (!json.ok && json.missing === undefined) throw new Error(json.error || 'Something went wrong');
    return json;
  }

  async function previewApi(action, data) {
    await sleep(action === 'chunk' ? 250 : 350);
    if (action === 'start') return { ok: true, name: 'Preview Tribute', first: 'there', demo: true, done: [], takes: {}, redo: [], photos: 0, received: false, locked: false };
    if (action === 'finish') return { ok: true, bytes: 0 };
    if (action === 'direct') return { ok: false, error: 'Preview mode' };
    if (action === 'log') return { ok: true };
    return { ok: true };
  }

  async function withRetry(fn, tries = 5) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (err) { last = err; await sleep(1500 * Math.pow(2, i)); }
    }
    throw last;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------- upload queue
  // ---------------------------------------------------------------- upload safety net
  // Every take is kept on the device (IndexedDB) until Drive confirms it, so a closed tab,
  // a phone that went to sleep, or a crash never loses an answer: it finishes on the next visit.
  const STORE = 'fishbowl-pending';
  function db() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(STORE, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('takes', { keyPath: 'key' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function dbDo(mode, fn) {
    const d = await db();
    if (!d) return null;
    return new Promise((resolve) => {
      try {
        const tx = d.transaction('takes', mode);
        const st = tx.objectStore('takes');
        const r = fn(st);
        tx.oncomplete = () => resolve(r && r.result !== undefined ? r.result : true);
        tx.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  const savePending = (item) => {
    item.key = TOKEN + ':' + item.step.id + ':' + Date.now();
    return dbDo('readwrite', (st) => st.put({ key: item.key, token: TOKEN, stepId: item.step.id, blob: item.blob, mime: item.mime, ext: item.ext, at: Date.now() }));
  };
  const dropPending = (key) => key ? dbDo('readwrite', (st) => st.delete(key)) : null;
  const listPending = () => dbDo('readonly', (st) => st.getAll());

  /** Re-queues takes from an earlier visit that never finished uploading. */
  async function resumePending() {
    const all = ((await listPending()) || []).filter((p) => p.token === TOKEN && p.blob).sort((a, b) => b.at - a.at);
    let n = 0;
    all.forEach((p) => {
      const step = S.steps.find((x) => x.id === p.stepId);
      if (!step || S.queue.some((q) => q.step.id === step.id)) { dropPending(p.key); return; } // older duplicate
      S.queue.push({ step, blob: p.blob, mime: p.mime, ext: p.ext, key: p.key, resumed: true });
      S.done.add(step.id);
      if (!S.local[step.id]) S.local[step.id] = URL.createObjectURL(p.blob);
      n++;
    });
    if (n) { updatePill(); pump(); }
    return n;
  }

  /** A short message at the bottom of the screen. */
  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 4500);
  }

  /** Tells the Fishbowl team what went wrong (shows up in the tracker's "Recorder Log" tab). */
  let logged = 0;
  function report(stepId, where, err, extra) {
    if (PREVIEW || logged++ > 25) return;
    const ua = navigator.userAgent;
    const device = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Other';
    const browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : 'Other';
    api('log', Object.assign({ stepId, where, msg: String((err && err.message) || err).slice(0, 300), device, browser,
      online: navigator.onLine, hidden: document.hidden }, extra || {})).catch(() => {});
  }

  // ---------------------------------------------------------------- upload queue
  function enqueue(item) {
    // Re-recording an answer that's still waiting to upload replaces the older take
    S.queue = S.queue.filter((q, i) => i === 0 && S.uploading ? true : q.step.id !== item.step.id);
    S.queue.push(item);
    savePending(item);
    updatePill();
    keepAwake(true);
    pump();
  }

  async function pump() {
    if (S.uploading) return;
    S.uploading = true;
    while (S.queue.length) {
      const item = S.queue[0];
      try {
        await uploadTake(item);
        S.queue.shift();
        dropPending(item.key);
        S.savedCount++;
        S.pct = -1;
        S.uploadErr = '';
        S.fails = 0;
      } catch (err) {
        S.uploadErr = err.message || String(err);
        S.fails = (S.fails || 0) + 1;
        updatePill();
        // keep trying (never drop a take), backing off a little, and jump in early if the network returns
        await new Promise((r) => { const t = setTimeout(r, Math.min(30000, 3000 * S.fails)); S.wake = () => { clearTimeout(t); r(); }; });
        S.wake = null;
      }
      updatePill();
    }
    S.uploading = false;
    updatePill();
    keepAwake(false);
    S.waiters.splice(0).forEach((w) => w());
  }
  window.addEventListener('online', () => S.wake && S.wake());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.wake) S.wake(); });

  /**
   * Each take tries the fast route (straight to Drive), and if that fails twice in a row,
   * the backup route (small pieces through the Fishbowl script). It keeps alternating until one works.
   */
  async function uploadTake(item) {
    item.tries = (item.tries || 0) + 1;
    const useDirect = S.who && S.who.direct && S.direct !== false && Math.ceil(item.tries / 2) % 2 === 1; // tries 1-2 fast, 3-4 backup, 5-6 fast…
    try {
      const r = useDirect ? await uploadDirect(item) : await uploadChunked(item);
      if (item.tries > 1 || item.resumed) report(item.step.id, 'ok', 'Saved after ' + item.tries + ' tries' + (item.resumed ? ' (finished on a later visit)' : ''), { size: item.blob.size, attempt: item.tries, route: useDirect ? 'fast' : 'backup' });
      return r;
    } catch (err) {
      report(item.step.id, useDirect ? 'direct' : 'pieces', err, { size: item.blob.size, attempt: item.tries });
      throw err;
    }
  }

  async function uploadDirect({ step, blob, mime, ext }) {
    const info = { stepId: step.id, title: step.file, mime, ext };
    const s = await withRetry(() => api('direct', Object.assign({ size: blob.size, origin: location.origin }, info)), 2);
    const file = await putToDrive(s.uploadUrl, blob, mime);
    return withRetry(() => api('saved', Object.assign({ fileId: file.id, totalSteps: S.steps.length }, info)));
  }

  /** PUTs the take to Drive. Gives up (so the next route can try) if no progress for 45 s. */
  function putToDrive(url, blob, mime) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let last = Date.now();
      const watch = setInterval(() => { if (Date.now() - last > 45000) { clearInterval(watch); xhr.abort(); reject(new Error('Upload stalled')); } }, 5000);
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', (mime || 'video/webm').split(';')[0]);
      xhr.upload.onprogress = (e) => { last = Date.now(); if (e.lengthComputable) { S.pct = Math.round((e.loaded / e.total) * 100); updatePill(); } };
      xhr.onload = () => {
        clearInterval(watch);
        let json = null;
        try { json = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && json && json.id) resolve(json);
        else reject(new Error('Drive responded ' + xhr.status + ' ' + String(xhr.responseText || '').slice(0, 120)));
      };
      xhr.onerror = () => { clearInterval(watch); reject(new Error('Upload blocked or offline')); };
      xhr.onabort = () => { clearInterval(watch); };
      xhr.send(blob);
    });
  }

  /** Base64 of one slice of the blob (slices are a multiple of 3 bytes, so the pieces join cleanly). */
  function sliceToBase64(blob, start, end) { return blobToBase64(blob.slice(start, end)); }

  async function uploadChunked({ step, blob, mime, ext }) {
    const BYTES = (CHUNK / 4) * 3; // 3 MB of video per piece
    const total = Math.max(1, Math.ceil(blob.size / BYTES));
    const uploadId = step.id + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const send = (i) => withRetry(async () => api('chunk', { uploadId, index: i, total, data: await sliceToBase64(blob, i * BYTES, Math.min(blob.size, (i + 1) * BYTES)) }));
    // two pieces at a time (gentle on phone memory)
    const todo = [...Array(total).keys()];
    let sent = 0;
    await Promise.all(Array.from({ length: Math.min(2, total) }, async () => {
      while (todo.length) { await send(todo.shift()); S.pct = Math.round((++sent / total) * 90); updatePill(); }
    }));
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await withRetry(() => api('finish', {
        uploadId, total, stepId: step.id, title: step.file, mime, ext, totalSteps: S.steps.length,
      }));
      if (res.ok) return res;
      if (res.missing !== undefined) { await send(res.missing); continue; }
      throw new Error(res.error || 'Could not save');
    }
    throw new Error('Could not save after several tries');
  }

  const idle = () => (S.queue.length || S.uploading ? new Promise((r) => S.waiters.push(r)) : Promise.resolve());

  function updatePill() {
    const pill = $('#uploadPill');
    const n = S.queue.length;
    pill.classList.remove('ok', 'err');
    if (n) {
      pill.hidden = false;
      if (S.uploadErr) { pill.classList.add('err'); $('#uploadText').textContent = 'Connection hiccup, retrying…'; }
      else $('#uploadText').textContent = `Saving ${n} answer${n > 1 ? 's' : ''}…` + (S.pct > 0 && S.pct < 100 ? ` ${S.pct}%` : '');
    } else if (S.savedCount) {
      pill.hidden = false;
      pill.classList.add('ok');
      $('#uploadText').textContent = 'All answers saved';
      clearTimeout(updatePill.t);
      updatePill.t = setTimeout(() => { if (!S.queue.length) pill.hidden = true; }, 3500);
    } else pill.hidden = true;
  }

  window.addEventListener('beforeunload', (e) => {
    if (S.queue.length || S.uploading) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- camera
  function pickMime() {
    const list = [
      ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'mp4'],
      ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
      ['video/mp4;codecs=avc1', 'mp4'],
      ['video/mp4', 'mp4'],
      ['video/webm;codecs=vp9,opus', 'webm'],
      ['video/webm;codecs=vp8,opus', 'webm'],
      ['video/webm', 'webm'],
    ];
    if (!window.MediaRecorder) return null;
    for (const [m, ext] of list) { try { if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext }; } catch (e) {} }
    return { mime: '', ext: 'webm' };
  }

  async function startCamera() {
    if (S.stream && S.stream.active) return S.stream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return S.stream;
  }

  function stopCamera() {
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
    if (S.audioCtx) { try { S.audioCtx.close(); } catch (e) {} S.audioCtx = null; }
  }

  function attachLive(video) {
    video.srcObject = S.stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.classList.add('mirror');
    video.play().catch(() => {});
  }

  // ---------------------------------------------------------------- phone orientation
  const isPhone = () => (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches) && Math.min(screen.width, screen.height, window.innerWidth, window.innerHeight) < 600;
  function updateRotate() {
    const needs = ['check', 'question'].includes(S.screen) && isPhone() && window.innerHeight > window.innerWidth;
    $('#rotate').hidden = !needs;
  }
  window.addEventListener('resize', updateRotate);
  window.addEventListener('orientationchange', () => setTimeout(updateRotate, 300));

  // ---------------------------------------------------------------- screens
  function errorScreen(title, body) {
    show('error', `<div class="center stagger" style="gap:18px">
      <div class="hero-bowl">${bowlSvg(0.3, '!')}</div>
      <h2>${esc(title)}</h2><p class="lede">${body}</p></div>`);
  }

  function welcome() {
    const resumed = S.done.size > 0;
    const first = esc(S.who.first || 'there');
    const total = S.steps.length;
    const el = show('welcome', `<div class="center welcome stagger">
      <div class="hero-bowl">${bowlSvg(0.55, '?')}</div>
      <p class="eyebrow">${resumed ? 'Welcome back' : "You're in the Fishbowl"}</p>
      <h1>${resumed ? `Hi again, ${first}!` : `Hi ${first}! Ready to jump in?`}</h1>
      <p class="lede">${resumed
        ? `You've saved ${S.done.size} of ${total} answers. Let's pick up where you left off.`
        : `Your coworkers are about to get to know you a little better. It's ${total} quick questions, one at a time, and you can re-record any answer.`}</p>
      <div class="facts"><span class="chip">⏱ About ${S.est} minutes</span><span class="chip">💦 5-question Splash Round</span><span class="chip">🔁 Unlimited re-records</span></div>
      <div class="tips">
        <div class="tip"><span class="ico">💻</span><strong>Laptop or sideways phone</strong>Landscape only, please.</div>
        <div class="tip"><span class="ico">💡</span><strong>Light in front of you</strong>Face a window or lamp, not behind you.</div>
        <div class="tip"><span class="ico">🤫</span><strong>Somewhere quiet</strong>Headphones off, so the mic can hear you.</div>
      </div>
      <div class="row" style="justify-content:center;margin-top:6px">
        <button class="btn btn-primary" id="go">${resumed ? 'Keep going' : "Let's go"} ${ARROW}</button>
      </div>
      ${PREVIEW ? '<p class="small">Preview mode: nothing is uploaded. Add the backend URL in src/config.js to go live.</p>' : (S.who.demo ? '<p class="small">Demo link: answers go to a test folder, not the tracker.</p>' : '')}
    </div>`);
    $('#go', el).addEventListener('click', cameraCheck);
  }

  /** Runs fn once the camera is on (shows the camera check first if it isn't). */
  function withCamera(fn) {
    if (S.stream && S.stream.active) return fn();
    cameraCheck(fn);
  }

  async function cameraCheck(after) {
    const el = show('check', `<div class="check">
      <div class="camera"><video id="live" autoplay muted playsinline></video>
        <div class="cam-note" id="camNote">Asking for your camera and microphone…</div></div>
      <div class="panel stagger">
        <p class="eyebrow">Quick check</p>
        <h2>How do you look?</h2>
        <ul class="checklist"><li>Face centered, eyes near the top third</li><li>Light on your face</li><li>Say something: the bar should move</li></ul>
        <div><p class="small" style="margin-bottom:6px">Microphone</p><div class="meter"><i id="meter"></i></div></div>
        <button class="btn btn-primary" id="ready" disabled>Looks good ${ARROW}</button>
      </div></div>`);
    try {
      await startCamera();
    } catch (err) {
      return cameraError(err);
    }
    const rec = pickMime();
    if (!rec) return errorScreen("This browser can't record video", 'Please open your link in <b>Chrome</b> or <b>Safari</b> (on a computer or phone) and try again.');
    S.mime = rec.mime; S.ext = rec.ext;
    attachLive($('#live', el));
    $('#camNote', el).textContent = 'This is just a preview. Nothing records until you press Record.';
    startMeter($('#meter', el));
    const btn = $('#ready', el);
    btn.disabled = false;
    btn.addEventListener('click', () => { stopMeter(); (typeof after === 'function' ? after : nextQuestion)(); });
  }

  function cameraError(err) {
    const name = err && err.name;
    let body;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      body = `Your browser blocked the camera. Click the <b>camera icon</b> in the address bar (or <b>Safari → Settings for This Website</b>), choose <b>Allow</b> for camera and microphone, then reload this page.`;
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      body = `We couldn't find a camera. Plug in or turn on your webcam, then reload this page.`;
    } else if (name === 'NotReadableError' || name === 'AbortError') {
      body = `Another app is using your camera (Zoom, Teams, FaceTime…). Close it, then reload this page.`;
    } else {
      body = `This browser can't use the camera here. Please open your link in <b>Chrome</b> or <b>Safari</b>.`;
    }
    errorScreen('We need your camera', body + `<br><br><button class="btn btn-primary" onclick="location.reload()">Try again</button>`);
  }

  function startMeter(bar) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      S.audioCtx = new Ctx();
      const src = S.audioCtx.createMediaStreamSource(S.stream);
      const an = S.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        bar.style.width = Math.min(100, (peak / 64) * 100) + '%';
        S.meterRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { /* meter is a nice-to-have */ }
  }
  function stopMeter() { cancelAnimationFrame(S.meterRaf); }

  /** Next unanswered question after the current one, wrapping back to any that were skipped. Photos once all are done. */
  function nextQuestion() {
    const n = S.steps.length;
    for (let k = 0; k < n; k++) {
      const i = (Math.max(0, S.idx) + k) % n;
      if (!S.done.has(S.steps[i].id)) { S.idx = i; return question(S.steps[i], 'ready'); }
    }
    S.idx = n;
    photos();
  }

  /** "Dogs or cats?" → ["Dogs", "Cats"] (for the one-word example). */
  function choices(text) {
    const m = String(text).replace(/\?$/, '').split(/\s+or\s+/i);
    return m.length === 2 ? m.map((x) => x.trim().replace(/^./, (c) => c.toUpperCase())) : null;
  }

  /** Once per visit, right before the first Splash Round question: the one-word rule, loud and clear. */
  function splashIntro(step) {
    S.splashBriefed = true;
    const n = S.steps.filter((x) => x.section === 'splash').length;
    const el = show('splashintro', `<div class="center splash-intro stagger">
      <p class="eyebrow">Next up</p>
      <h1 class="splash-big">💦 Splash Round</h1>
      <p class="lede">${n} quick this-or-that questions. Answer each with <b>ONE&nbsp;WORD</b>. That's it.</p>
      <div class="splash-examples">
        <div class="ex good"><span class="ex-mark">✓</span><span class="ex-label">Perfect</span><span class="ex-say">"Dogs."</span></div>
        <div class="ex bad"><span class="ex-mark">✕</span><span class="ex-label">Too much</span><span class="ex-say">"Ooh, well, I grew up with dogs, so…"</span></div>
      </div>
      <p class="small">You only get ${step.seconds} seconds, and the recording stops on its own.</p>
      <button class="btn btn-primary" id="gotIt">Got it: one word ${ARROW}</button>
    </div>`);
    $('#gotIt', el).addEventListener('click', () => question(step, 'ready'));
  }

  function sectionMeta(step) {
    const same = S.steps.filter((s) => s.section === step.section);
    const n = same.indexOf(step) + 1;
    if (step.section === 'splash') return `Splash Round · ${n} of ${same.length}`;
    if (step.section === 'deep') return `Question ${n} of ${same.length}`;
    return "Let's start";
  }

  function question(step, state) {
    const splash = step.section === 'splash';
    if (splash && state === 'ready' && !S.splashBriefed) return splashIntro(step);
    const pair = splash ? choices(step.text) : null;
    const limit = step.seconds;
    const hint = state === 'review'
      ? 'Happy with it? Use this take, or record it again.'
      : splash ? (pair ? `Just say "${pair[0]}" or "${pair[1]}". Nothing else!` : `One word only. You've got ${limit} seconds!`) : `Short and sweet: up to ${limit} seconds, after a 3-2-1 countdown.`;
    const el = show('question', `<div class="stage">
      <div class="camera" id="cam">
        <video id="live" autoplay muted playsinline></video>
        <div class="timer" id="timer" hidden>
          <svg viewBox="0 0 76 76"><circle class="track" cx="38" cy="38" r="33" fill="none" stroke-width="7"/>
          <circle class="bar" id="ring" cx="38" cy="38" r="33" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="207.3" stroke-dashoffset="0"/></svg>
          <span id="secs">${limit}</span></div>
        <div class="cam-badge" id="badge" hidden><span class="live"></span>REC</div>
        ${splash ? '<div class="one-word" aria-hidden="true">ONE WORD</div>' : ''}
        ${step.section === 'intro' && state === 'ready' ? '<div class="cam-note">Tip: look at your camera lens, not the screen</div>' : ''}
      </div>
      <div class="card ${splash ? 'splash' : ''}">
        ${splash ? SPLASH_ART : ''}
        <div class="q-head">
          <div class="q-bowl">${splash ? bowlSvg(0.6, '?', { stroke: '#082642', water: '#ffffff' }) : bowlSvg(0.55, '?')}</div>
          <div class="q-meta">${esc(sectionMeta(step))}</div>
        </div>
        ${splash ? '<span class="splash-tag">☝️ ONE WORD ONLY</span>' : ''}
        <div class="q-text">${esc(step.text)}</div>
        <p class="q-hint">${esc(hint)}</p>
        <div class="controls" id="controls"></div>
      </div></div>`);
    updateProgress();
    const video = $('#live', el);
    const controls = $('#controls', el);

    if (state === 'review') {
      video.srcObject = null;
      video.classList.remove('mirror');
      video.muted = false;
      video.controls = true;
      video.src = S.blobUrl;
      video.play().catch(() => {});
      controls.innerHTML = `<button class="btn btn-primary" id="use">Use this take ${ARROW}</button>
        <button class="btn btn-ghost" id="redo">Re-record</button>`;
      $('#use', el).addEventListener('click', () => useTake(step));
      $('#redo', el).addEventListener('click', () => question(step, 'ready'));
      $('#use', el).focus({ preventScroll: true });
      return;
    }

    attachLive(video);
    controls.innerHTML = `<button class="btn btn-rec" id="rec"><span class="rec-dot"></span>Record</button>`;
    $('#rec', el).addEventListener('click', () => countIn(step, el));
  }

  // Recording buffers: start a moment before "go" and keep rolling a moment after Stop / time's up,
  // so first and last words are never clipped. Dead air is trimmed later in Premiere.
  const PRE_ROLL_MS = 800;
  const POST_ROLL_MS = 1200;

  function countIn(step, el) {
    setAllBtn(false);
    keepAwake(true);
    const cam = $('#cam', el);
    $('#controls', el).innerHTML = `<button class="btn btn-ghost" disabled>Get ready…</button>`;
    const box = document.createElement('div');
    box.className = 'countin';
    cam.appendChild(box);
    let n = 3, rec = null;
    const tick = () => {
      if (S.screen !== 'question') { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } return; }
      if (n === 0) { box.remove(); return record(step, el, rec); }
      box.innerHTML = `<span>${n}</span>`;
      if (n === 1) {
        // Pre-roll: quietly start recording during the last second of the countdown
        S.timers.push(setTimeout(() => { if (S.screen === 'question') { rec = startRecorder(step); S.rec = rec; } }, Math.max(0, 1000 - PRE_ROLL_MS)));
      }
      n--;
      S.timers.push(setTimeout(tick, 1000));
    };
    tick();
  }

  /** Creates and starts a MediaRecorder (no time slices: Safari drops the last slice when they're used). */
  function startRecorder(step) {
    S.parts = [];
    let rec;
    try {
      const opts = { videoBitsPerSecond: CFG.videoBitsPerSecond, audioBitsPerSecond: CFG.audioBitsPerSecond };
      if (S.mime) opts.mimeType = S.mime;
      rec = new MediaRecorder(S.stream, opts);
    } catch (err) {
      try { rec = new MediaRecorder(S.stream); S.mime = rec.mimeType || ''; } catch (e) { return null; }
    }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) S.parts.push(e.data); };
    try { rec.start(); } catch (e) { return null; }
    return rec;
  }

  function record(step, el, rec) {
    rec = rec || startRecorder(step);
    if (!rec) return errorScreen("Recording isn't working in this browser", 'Please open your link in <b>Chrome</b> or <b>Safari</b> and try again.');
    S.rec = rec;
    rec.onstop = () => {
      const type = (rec.mimeType || S.mime || 'video/webm').split(';')[0];
      S.ext = /mp4/.test(type) ? 'mp4' : 'webm';
      S.mime = rec.mimeType || type;
      S.blob = new Blob(S.parts, { type });
      if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
      S.blobUrl = URL.createObjectURL(S.blob);
      if (S.screen === 'question') question(step, 'review');
    };

    const limit = step.seconds * 1000;
    const started = performance.now();
    $('#badge', el).hidden = false;
    $('#timer', el).hidden = false;
    const ring = $('#ring', el);
    const secs = $('#secs', el);
    const timer = $('#timer', el);
    const controls = $('#controls', el);
    controls.innerHTML = `<button class="btn btn-rec btn-stop" id="stop" disabled><span class="rec-dot"></span>Stop</button>`;
    const stopBtn = $('#stop', el);
    S.timers.push(setTimeout(() => { stopBtn.disabled = false; }, step.section === 'splash' ? 600 : 1500));
    stopBtn.addEventListener('click', stop);

    // A plain interval (not animation frames, which phones pause when the screen dims)
    let stopping = false;
    const tickTimer = () => {
      const t = performance.now() - started;
      const left = Math.max(0, limit - t);
      ring.setAttribute('stroke-dashoffset', String(207.3 * Math.min(1, t / limit)));
      secs.textContent = Math.ceil(left / 1000);
      timer.classList.toggle('low', left < Math.min(5000, limit * 0.3));
      if (left <= 0) stop();
    };
    const iv = setInterval(tickTimer, 100);
    S.timers.push(iv);
    tickTimer();

    function stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(iv);
      // Post-roll: keep recording a beat so the last word isn't clipped
      stopBtn.disabled = true;
      stopBtn.innerHTML = '<span class="rec-dot"></span>Saving the ending…';
      setTimeout(() => {
        if (rec.state !== 'inactive') { try { rec.stop(); } catch (e) {} }
        keepAwake(false);
      }, POST_ROLL_MS);
    }
  }

  // Keep the phone screen on while recording or uploading (where supported)
  let wakeLock = null, wakeWanted = false;
  async function keepAwake(on) {
    wakeWanted = on || S.queue.length > 0 || S.uploading;
    try {
      if (wakeWanted && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      else if (!wakeWanted && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && wakeWanted) keepAwake(true); });

  function useTake(step) {
    enqueue({ step, blob: S.blob, mime: S.mime, ext: S.ext });
    if (S.local[step.id]) URL.revokeObjectURL(S.local[step.id]);
    S.local[step.id] = URL.createObjectURL(S.blob);
    S.done.add(step.id);
    S.redo.delete(step.id);
    S.blob = null;
    if (S.returnTo) { S.returnTo = null; return burstThen(() => allQuestions()); }
    S.idx++;
    burstThen(nextQuestion);
  }

  /**
   * Opens one question from the All questions screen. Redoing a saved answer (or anything after
   * they've finished) comes back to the list; recording a new one carries on to the next question.
   */
  function openStep(step) {
    S.idx = S.steps.indexOf(step);
    S.returnTo = (S.finished || S.done.has(step.id)) ? 'list' : null;
    withCamera(() => question(step, 'ready'));
  }

  const canRecord = (step) => !S.who.locked || S.redo.has(step.id);
  const allDone = () => S.steps.every((st) => S.done.has(st.id));

  function burstThen(fn) {
    const card = $('.card');
    if (!card) return fn();
    card.style.transition = 'transform .45s var(--ease), opacity .45s var(--ease)';
    card.style.transform = 'translateX(-24px)';
    card.style.opacity = '0';
    setTimeout(fn, 260);
  }

  // ---------------------------------------------------------------- photos
  function photos() {
    const max = S.photosCfg.max || 6;
    const el = show('photos', `<div class="photos">
      <div>
        <label class="drop" id="drop">
          <span class="big">📸</span>
          <h2>Add a few photos</h2>
          <p class="small">${esc(S.photosCfg.prompt || 'Family, pets, hobbies, anything fun!')}</p>
          <span class="btn btn-ghost" style="margin-top:6px">Choose photos</span>
          <input type="file" id="file" accept="image/*,.heic,.heif" multiple hidden>
        </label>
        <p class="small photo-types">JPG, PNG or iPhone photos (HEIC) all work. Tap ✕ on a photo to remove it.</p>
        <div class="thumbs" id="thumbs"></div>
      </div>
      <div class="panel stagger">
        <p class="eyebrow">Last step</p>
        <h2>Show us your world</h2>
        <p class="small">These get dropped into your Fishbowl video next to your answers: kids, pets, partner, travels, hobbies. Up to ${max}.</p>
        <button class="btn btn-primary" id="finish">Finish ${ARROW}</button>
        <button class="link-btn" id="skip">Skip photos</button>
      </div></div>`);
    updateProgress();
    const input = $('#file', el);
    const drop = $('#drop', el);
    const thumbs = $('#thumbs', el);
    let photoChain = Promise.resolve();
    const isPhoto = (f) => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name);
    const add = (files) => {
      const list = [...files];
      const skipped = list.filter((f) => !isPhoto(f));
      list.filter(isPhoto).forEach((file) => {
        if (S.photos.length >= max) { toast(`That's the max of ${max} photos. Remove one to add another.`); return; }
        const item = { file, state: 'up' };
        S.photos.push(item);
        const div = document.createElement('div');
        div.className = 'thumb';
        div.innerHTML = `<img alt=""><span class="state">…</span><button class="thumb-x" type="button" aria-label="Remove this photo" title="Remove">✕</button>`;
        thumbs.appendChild(div);
        item.el = div;
        // Preview: browsers that can't show iPhone (HEIC) photos get the converted JPEG once it's ready
        if (!isHeic(file)) div.querySelector('img').src = URL.createObjectURL(file);
        div.querySelector('.thumb-x').addEventListener('click', () => removePhoto(item));
        // One photo at a time, in the order they were picked (parallel uploads raced each other)
        photoChain = photoChain.catch(() => {}).then(() => (item.removed ? null : uploadPhoto(item)));
        item.promise = photoChain.then(
          (r) => {
            if (item.removed) { if (r && r.fileId) deletePhoto(r.fileId); return; } // removed while it was uploading
            if (r && r.fileId) item.fileId = r.fileId;
            item.state = 'ok'; div.querySelector('.state').textContent = '✓';
          },
          (err) => { if (item.removed) return; report('photo', 'photo', err, { size: item.file.size, route: item.file.type || item.file.name.split('.').pop() }); item.state = 'err'; div.querySelector('.state').textContent = '!'; div.title = 'This photo didn\'t upload. Remove it and try again, or try a JPG.'; });
      });
      if (skipped.length) toast(`${skipped.length === 1 ? 'That file isn\'t' : 'Some files aren\'t'} a photo we can use. Try a JPG, PNG or iPhone photo.`);
    };
    const removePhoto = (item) => {
      item.removed = true;
      S.photos = S.photos.filter((x) => x !== item);
      if (item.el) item.el.remove();
      if (item.fileId) deletePhoto(item.fileId);
      input.value = ''; // so picking the same photo again works
    };
    input.addEventListener('change', () => add(input.files));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => add(e.dataTransfer.files));
    $('#finish', el).addEventListener('click', finish);
    $('#skip', el).addEventListener('click', finish);
  }

  function isHeic(file) { return /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name); }

  /** iPhone photos (HEIC) → JPEG. Safari decodes them itself; other browsers load a converter only when needed. */
  let heicLib = null;
  async function heicToJpeg(file) {
    try { const bmp = await createImageBitmap(file); return await drawToJpeg(bmp, 2400); } catch (e) { /* not natively supported */ }
    if (!heicLib) {
      heicLib = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
        sc.onload = () => resolve(window.heic2any);
        sc.onerror = () => { heicLib = null; reject(new Error('Couldn\'t load the iPhone photo converter')); };
        document.head.appendChild(sc);
      });
    }
    const conv = await heicLib;
    const out = await conv({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    return Array.isArray(out) ? out[0] : out;
  }

  async function drawToJpeg(bmp, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  }

  function deletePhoto(fileId) {
    withRetry(() => api('photoDelete', { fileId }), 3).catch((e) => report('photo', 'photoDelete', e));
  }

  async function shrinkImage(file, maxDim = 2400) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    } catch (e) {
      return file; // fall back to the original if the browser can't decode it
    }
  }

  async function uploadPhoto(item) {
    let blob;
    if (isHeic(item.file)) {
      blob = await heicToJpeg(item.file);
      if (item.removed) return null;
      blob = await shrinkImage(blob); // converter output can be huge; resize like any other photo
      const img = item.el && item.el.querySelector('img');
      if (img && !img.src) img.src = URL.createObjectURL(blob);
    } else {
      blob = await shrinkImage(item.file);
    }
    const data = await blobToBase64(blob);
    const name = item.file.name.replace(/\.(heic|heif)$/i, '.jpg');
    return withRetry(() => api('photo', { name, mime: blob.type || 'image/jpeg', data }), 4);
  }

  async function finish() {
    const el = show('done', `<div class="center done stagger">
      <div class="spinner"></div><h2>Saving your last answers…</h2>
      <p class="lede">Keep this tab open for a moment.</p></div>`);
    await Promise.all(S.photos.map((p) => p.promise).filter(Boolean));
    await idle();
    try { await withRetry(() => api('complete', {}), 5); }
    catch (err) {
      return errorScreen('Almost there!', 'Your answers are saved, but we couldn\'t mark you as finished. Check your connection and <a href="" style="color:#4cd7fe">reload this page</a>.');
    }
    stopCamera();
    doneScreen();
  }

  function doneScreen(already) {
    S.finished = true;
    S.already = !!already;
    allQuestions();
  }

  // ---------------------------------------------------------------- All questions
  const SECTIONS = [['intro', 'Intro'], ['splash', 'Splash Round'], ['deep', 'Questions']];

  function allQuestions() {
    const fin = S.finished, locked = S.who.locked, label = S.who.lockLabel;
    const until = label ? `until ${esc(label)}` : 'until the end of your Fishbowl month';
    let eyebrow, title, lede;
    if (!fin) {
      eyebrow = 'All questions'; title = 'Jump to any question';
      lede = 'Tap one to record it, or redo one you already saved. Saved answers can be watched back.';
    } else if (locked) {
      eyebrow = 'Locked in'; title = 'Your Fishbowl is locked in';
      lede = `Answers closed on ${esc(label)}, so you can watch them but not change them. Need a change? Reply to your invite email.`;
    } else if (S.already) {
      eyebrow = 'Already in the bowl'; title = `Welcome back, ${esc(S.who.first || 'friend')}!`;
      lede = `Your Fishbowl is saved. You can watch or redo any answer ${until}.`;
    } else {
      eyebrow = 'All done'; title = `That's a wrap, ${esc(S.who.first || 'friend')}!`;
      lede = PREVIEW ? '⚠️ Preview mode: this run was NOT saved anywhere. Connect the backend in src/config.js to save recordings.'
        : `Your answers are saved and on their way to the Fishbowl team. Want to change one? Watch or redo any answer ${until}.`;
    }
    const redoNote = S.redo.size
      ? `<div class="notice ask">The Fishbowl team asked you to redo ${S.redo.size > 1 ? `${S.redo.size} answers` : 'one answer'}. Tap <b>Redo</b> next to ${S.redo.size > 1 ? 'each one' : 'it'} below. Everything else stays as is.</div>` : '';
    const row = (st) => {
      const saved = S.done.has(st.id), ask = S.redo.has(st.id);
      const n = S.steps.filter((x) => x.section === st.section).indexOf(st) + 1;
      const tag = st.section === 'intro' ? 'Intro' : st.section === 'splash' ? `S${n}` : `Q${n}`;
      const rec = canRecord(st) ? `<button class="btn btn-small ${ask ? 'btn-primary' : 'btn-ghost'}" data-rec="${st.id}">${saved ? 'Redo' : 'Record'}</button>` : '';
      return `<div class="ov-row${saved ? ' saved' : ''}${ask ? ' ask' : ''}">
        <span class="ov-tag">${tag}</span>
        <span class="ov-text">${esc(st.text)}</span>
        <span class="ov-state">${ask ? 'Redo requested' : saved ? '✓ Saved' : 'Not recorded'}</span>
        <span class="ov-actions">${saved ? `<button class="btn btn-small btn-ghost" data-watch="${st.id}">▶ Watch</button>` : ''}${rec}</span>
      </div>`;
    };
    const groups = SECTIONS.map(([sec, name]) => {
      const list = S.steps.filter((st) => st.section === sec);
      return list.length ? `<h3 class="ov-group">${name}</h3>${list.map(row).join('')}` : '';
    }).join('');
    const photoRow = fin && !locked ? `<h3 class="ov-group">Photos</h3><div class="ov-row"><span class="ov-tag">📸</span>
      <span class="ov-text">Add a few more photos</span><span class="ov-state"></span>
      <span class="ov-actions"><button class="btn btn-small btn-ghost" id="morePhotos">Add photos</button></span></div>` : '';
    const primary = !fin
      ? (allDone() ? `<button class="btn btn-primary" id="next">Continue to photos ${ARROW}</button>` : `<button class="btn btn-primary" id="next">Keep going ${ARROW}</button>`)
      : (locked && !S.redo.size ? '' : `<button class="btn btn-primary" id="allSet">I'm all set</button>`);
    const el = show('list', `<div class="overview stagger">
      <div class="ov-head ${fin ? 'center done' : ''}">
        ${fin ? `<div class="burst small-burst"><div class="hero-bowl" style="width:100%">${bowlSvg(0.95, '🐟')}</div></div>` : ''}
        <p class="eyebrow">${eyebrow}</p>
        <h1>${title}</h1>
        <p class="lede">${lede}</p>
      </div>
      ${redoNote}
      <div class="ov-list">${groups}${photoRow}</div>
      <div class="ov-foot">${primary}<span class="small" id="footNote">${fin ? 'You can close this tab when the Saving… pill says saved.' : ''}</span></div>
    </div>`);
    updateProgress();
    el.querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => openStep(S.steps.find((st) => st.id === b.dataset.rec))));
    el.querySelectorAll('[data-watch]').forEach((b) => b.addEventListener('click', () => watch(S.steps.find((st) => st.id === b.dataset.watch))));
    const next = $('#next', el);
    if (next) next.addEventListener('click', () => (allDone() ? photos() : withCamera(() => { S.idx = 0; nextQuestion(); })));
    const more = $('#morePhotos', el);
    if (more) more.addEventListener('click', photos);
    const set = $('#allSet', el);
    if (set) set.addEventListener('click', async () => {
      set.disabled = true; set.textContent = 'Saving…';
      await idle();
      try { await withRetry(() => api('complete', {}), 4); } catch (e) {}
      stopCamera();
      set.textContent = '✓ All saved';
      $('#footNote', el).textContent = 'Thanks! You can close this tab.';
    });
  }

  // ---------------------------------------------------------------- watch back
  async function watch(step) {
    const box = document.createElement('div');
    box.className = 'player';
    box.innerHTML = `<div class="player-card"><div class="player-head"><span>${esc(step.text)}</span>
      <button class="link-btn" id="closePlayer">Close</button></div>
      <div class="player-body"><div class="spinner"></div><p class="small" id="loadPct">Loading your answer…</p></div></div>`;
    document.body.appendChild(box);
    const close = () => { box.remove(); };
    box.querySelector('#closePlayer').addEventListener('click', close);
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    try {
      const url = S.local[step.id] || (S.local[step.id] = await fetchClip(step, (pct) => {
        const t = box.querySelector('#loadPct'); if (t) t.textContent = `Loading your answer… ${pct}%`;
      }));
      if (!box.isConnected) return;
      const body = box.querySelector('.player-body');
      body.innerHTML = '<video controls playsinline autoplay></video>';
      body.querySelector('video').src = url;
    } catch (err) {
      const t = box.querySelector('#loadPct');
      if (t) t.textContent = "Couldn't load that answer. Check your connection and try again.";
    }
  }

  async function fetchClip(step, onPct) {
    const parts = [];
    let offset = 0, size = 1, mime = 'video/mp4';
    for (;;) {
      const r = await withRetry(() => api('clip', { stepId: step.id, offset }), 3);
      const bin = atob(r.data || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      parts.push(bytes);
      size = r.size || 1; mime = r.mime || mime;
      offset += bytes.length;
      onPct(Math.min(100, Math.round((offset / size) * 100)));
      if (r.done || !bytes.length) break;
    }
    return URL.createObjectURL(new Blob(parts, { type: mime }));
  }

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    if (S.screen !== 'question' || e.target.closest('input, textarea')) return;
    if (e.code === 'Space') {
      const b = $('#rec') || $('#stop:not([disabled])');
      if (b) { e.preventDefault(); b.click(); }
    }
  });

  // ---------------------------------------------------------------- boot
  async function boot() {
    try {
      const cfg = await fetch('config/questions.json', { cache: 'no-store' }).then((r) => r.json());
      S.steps = cfg.steps;
      S.photosCfg = cfg.photos || S.photosCfg;
      S.est = cfg.estimatedMinutes || 15;
    } catch (err) {
      return errorScreen("The Fishbowl didn't load", 'Please reload the page. If it keeps happening, reply to your invite email.');
    }
    if (!TOKEN && !PREVIEW) {
      return errorScreen('Use your personal link', 'Open the <b>Record</b> link from your Fishbowl calendar invite or email. It\'s unique to you.');
    }
    try {
      S.who = await withRetry(() => api('start'), 3);
    } catch (err) {
      return errorScreen("We couldn't open your Fishbowl", esc(err.message || 'Check your connection and reload the page.'));
    }
    (S.who.done || []).forEach((id) => S.done.add(id));
    (S.who.redo || []).forEach((id) => S.redo.add(id));
    await resumePending();
    if (S.who.received) return doneScreen(true);
    welcome();
  }

  $('#allBtn').addEventListener('click', () => {
    if (S.rec && S.rec.state === 'recording') return;
    clearTimers();
    S.returnTo = null;
    allQuestions();
  });

  // exposed for automated tests only
  window.__fishbowl = { S, api, CHUNK, photos };
  boot();
})();
