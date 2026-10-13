/* Fishbowl Recorder
 * One question at a time: count-in → record (auto-stops at the time limit) → review → use take.
 * Each take uploads in the background, in pieces, to the Apps Script backend, which saves it to Drive.
 * No build step and no libraries: plain browser JavaScript.
 */
(() => {
  'use strict';

  const CFG = Object.assign({ backendUrl: '', videoBitsPerSecond: 2000000, audioBitsPerSecond: 128000 }, window.FISHBOWL_CONFIG || {});
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
    queue: [], uploading: false, uploadErr: '', savedCount: 0, waiters: [],
    photos: [], audioCtx: null, meterRaf: 0, screen: 'loading',
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
    S.screen = name;
    app.innerHTML = `<section class="screen screen-${name}" data-screen="${name}">${html}</section>`;
    window.scrollTo(0, 0);
    updateRotate();
    return app.firstElementChild;
  }

  function updateProgress() {
    const total = S.steps.length || 16;
    const n = S.done.size;
    const p = $('#progress');
    p.hidden = !['question', 'photos', 'done'].includes(S.screen);
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
    if (action === 'start') return { ok: true, name: 'Preview Tribute', first: 'there', demo: true, done: [], photos: 0, received: false };
    if (action === 'finish') return { ok: true, bytes: 0 };
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
  function enqueue(item) {
    S.queue.push(item);
    updatePill();
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
        S.savedCount++;
        S.uploadErr = '';
      } catch (err) {
        S.uploadErr = err.message || String(err);
        updatePill();
        await sleep(8000); // keep trying: never drop a take
      }
      updatePill();
    }
    S.uploading = false;
    updatePill();
    S.waiters.splice(0).forEach((w) => w());
  }

  async function uploadTake({ step, blob, mime, ext }) {
    const b64 = await blobToBase64(blob);
    const total = Math.max(1, Math.ceil(b64.length / CHUNK));
    const uploadId = step.id + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const send = (i) => withRetry(() => api('chunk', { uploadId, index: i, total, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) }));
    for (let i = 0; i < total; i++) await send(i);
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
      else $('#uploadText').textContent = `Saving ${n} answer${n > 1 ? 's' : ''}…`;
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

  async function cameraCheck() {
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
    btn.addEventListener('click', () => { stopMeter(); nextQuestion(); });
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

  function nextQuestion() {
    while (S.idx < S.steps.length && S.done.has(S.steps[S.idx].id)) S.idx++;
    if (S.idx >= S.steps.length) return photos();
    question(S.steps[S.idx], 'ready');
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
    const limit = step.seconds;
    const hint = state === 'review'
      ? 'Happy with it? Use this take, or record it again.'
      : splash ? `One word only. You've got ${limit} seconds!` : `You'll get a 3-2-1 countdown, then up to ${limit} seconds.`;
    const el = show('question', `<div class="stage">
      <div class="camera" id="cam">
        <video id="live" autoplay muted playsinline></video>
        <div class="timer" id="timer" hidden>
          <svg viewBox="0 0 76 76"><circle class="track" cx="38" cy="38" r="33" fill="none" stroke-width="7"/>
          <circle class="bar" id="ring" cx="38" cy="38" r="33" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="207.3" stroke-dashoffset="0"/></svg>
          <span id="secs">${limit}</span></div>
        <div class="cam-badge" id="badge" hidden><span class="live"></span>REC</div>
        ${step.section === 'intro' && state === 'ready' ? '<div class="cam-note">Tip: look at your camera lens, not the screen</div>' : ''}
      </div>
      <div class="card ${splash ? 'splash' : ''}">
        ${splash ? SPLASH_ART : ''}
        <div class="q-head">
          <div class="q-bowl">${splash ? bowlSvg(0.6, '?', { stroke: '#082642', water: '#ffffff' }) : bowlSvg(0.55, '?')}</div>
          <div class="q-meta">${esc(sectionMeta(step))}</div>
        </div>
        ${splash ? '<span class="splash-tag">ONE WORD!</span>' : ''}
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

  function countIn(step, el) {
    const cam = $('#cam', el);
    $('#controls', el).innerHTML = `<button class="btn btn-ghost" disabled>Get ready…</button>`;
    const box = document.createElement('div');
    box.className = 'countin';
    cam.appendChild(box);
    let n = 3;
    const tick = () => {
      if (S.screen !== 'question') return;
      if (n === 0) { box.remove(); return record(step, el); }
      box.innerHTML = `<span>${n}</span>`;
      n--;
      S.timers.push(setTimeout(tick, 1000));
    };
    tick();
  }

  function record(step, el) {
    S.parts = [];
    let rec;
    try {
      const opts = { videoBitsPerSecond: CFG.videoBitsPerSecond, audioBitsPerSecond: CFG.audioBitsPerSecond };
      if (S.mime) opts.mimeType = S.mime;
      rec = new MediaRecorder(S.stream, opts);
    } catch (err) {
      try { rec = new MediaRecorder(S.stream); S.mime = rec.mimeType || ''; } catch (e) {
        return errorScreen("Recording isn't working in this browser", 'Please open your link in <b>Chrome</b> or <b>Safari</b> and try again.');
      }
    }
    S.rec = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) S.parts.push(e.data); };
    rec.onstop = () => {
      const type = (rec.mimeType || S.mime || 'video/webm').split(';')[0];
      S.ext = /mp4/.test(type) ? 'mp4' : 'webm';
      S.mime = rec.mimeType || type;
      S.blob = new Blob(S.parts, { type });
      if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
      S.blobUrl = URL.createObjectURL(S.blob);
      if (S.screen === 'question') question(step, 'review');
    };
    rec.start(1000);

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

    const frame = () => {
      const t = performance.now() - started;
      const left = Math.max(0, limit - t);
      ring.setAttribute('stroke-dashoffset', String(207.3 * (t / limit)));
      secs.textContent = Math.ceil(left / 1000);
      timer.classList.toggle('low', left < Math.min(5000, limit * 0.3));
      if (left <= 0) return stop();
      const id = requestAnimationFrame(frame);
      S.timers.push(id);
    };
    frame();

    function stop() {
      if (rec.state !== 'inactive') { try { rec.requestData(); } catch (e) {} rec.stop(); }
      clearTimers();
    }
  }

  function useTake(step) {
    enqueue({ step, blob: S.blob, mime: S.mime, ext: S.ext });
    S.done.add(step.id);
    S.blob = null;
    S.idx++;
    burstThen(nextQuestion);
  }

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
          <input type="file" id="file" accept="image/*" multiple hidden>
        </label>
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
    const add = (files) => {
      [...files].filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name)).forEach((file) => {
        if (S.photos.length >= max) return;
        const item = { file, state: 'up', url: URL.createObjectURL(file) };
        S.photos.push(item);
        const div = document.createElement('div');
        div.className = 'thumb';
        div.innerHTML = `<img alt="" src="${item.url}"><span class="state">…</span>`;
        thumbs.appendChild(div);
        item.el = div;
        item.promise = uploadPhoto(item).then(
          () => { item.state = 'ok'; div.querySelector('.state').textContent = '✓'; },
          () => { item.state = 'err'; div.querySelector('.state').textContent = '!'; div.title = 'This photo didn\'t upload'; });
      });
    };
    input.addEventListener('change', () => add(input.files));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => add(e.dataTransfer.files));
    $('#finish', el).addEventListener('click', finish);
    $('#skip', el).addEventListener('click', finish);
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
    const blob = await shrinkImage(item.file);
    const data = await blobToBase64(blob);
    return withRetry(() => api('photo', { name: item.file.name, mime: blob.type || 'image/jpeg', data }), 4);
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
    S.screen = 'done';
    show('done', `<div class="center done stagger">
      <div class="burst"><div class="hero-bowl" style="width:100%">${bowlSvg(0.95, '🐟')}</div></div>
      <p class="eyebrow">${already ? 'Already in the bowl' : 'All done'}</p>
      <h1>That's a wrap, ${esc(S.who.first || 'friend')}!</h1>
      <p class="lede">${already
        ? 'Your Fishbowl answers are already saved. Thanks again! If you need to change something, reply to your invite email.'
        : PREVIEW ? '⚠️ Preview mode: this run was NOT saved anywhere. Connect the backend in src/config.js to save recordings.'
        : 'Your answers are saved and on their way to the Fishbowl team. Thanks for jumping in. Your coworkers are going to love it.'}</p>
      <p class="small">You can close this tab.</p></div>`);
    S.done = new Set(S.steps.map((s) => s.id));
    updateProgress();
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
    if (S.who.received) return doneScreen(true);
    welcome();
  }

  // exposed for automated tests only
  window.__fishbowl = { S, api, CHUNK };
  boot();
})();
