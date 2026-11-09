/*
 * AP.Audio：カットの音（録音・音のファイル）。
 * card.audio = { src: data URL, name, dur（秒）, over, shift }。セリフと同じく元のカードが持つ（連動カットは共通）。
 *   over：鳴り終わるまで鳴らす（次のカットにかかってもよい）。false ならカット（同じカットにまとめた絵ならまとまり）の終わりで止める。既定は true
 *   shift：カットの頭から何秒ずらして鳴らし始めるか。マイナスなら前のカットのうちから先に鳴る（音の先行）
 *   trimIn／trimOut：音の頭・お尻を何秒切るか（タイムラインの音の帯の端をドラッグ）
 * 描画パネルの下の「音」欄で録音・読み込み・試し聞き・外す。Vコンテの再生で鳴らす（Web Audio。重なった音はそのまま混ざる）。
 * タイムラインには、音が実際に鳴る範囲を帯で出す（カットをまたぐのが見える）。
 * どの端末でも鳴るように、mp3・m4a・wav 以外（Chrome の録音の webm など）は WAV に変換して持つ。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let cardId = null;        // 「音」欄が表示しているカード（元のカード）
  let rec = null;           // 録音中 { mr, stream, chunks, t0, timer }
  let preview = null;       // 試し聞き中の Audio 要素
  let ctx = null;           // AudioContext（Vコンテの再生用）
  const buffers = new Map();  // src → AudioBuffer（デコード済み）
  const decoding = new Map(); // src → Promise
  let playingNodes = [];

  // ---- 共通 ----
  function audioCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function dataURLToArrayBuffer(src) {
    return fetch(src).then(function (r) { return r.arrayBuffer(); });
  }

  function decode(arrayBuf) {
    const ac = audioCtx();
    if (!ac) return Promise.reject(new Error('この端末では音を扱えません'));
    // Safari の古い版はコールバック形式しかない
    return new Promise(function (resolve, reject) {
      const p = ac.decodeAudioData(arrayBuf, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // AudioBuffer → モノラル 16bit の WAV（Blob）
  function toWav(buf) {
    const rate = Math.min(buf.sampleRate, C.AUDIO_WAV_RATE);
    const step = buf.sampleRate / rate;
    const n = Math.floor(buf.length / step);
    const ch = [];
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    const out = new DataView(new ArrayBuffer(44 + n * 2));
    function str(o, s) { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i * step);
      let v = 0;
      for (let c = 0; c < ch.length; c++) v += ch[c][k];
      v = U.clamp(v / ch.length, -1, 1);
      out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  // どの端末でもそのまま鳴る形式か
  function portable(type) {
    return /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|wav|x-wav|wave)$/.test(type || '');
  }

  // Blob（録音・ファイル）→ card.audio。長すぎる・大きすぎるものは断る
  async function makeAudio(blob, name) {
    const ab = await blob.arrayBuffer();
    const buf = await decode(ab.slice(0));
    if (buf.duration > C.AUDIO_MAX_SEC) throw new Error('長すぎます（' + C.AUDIO_MAX_SEC + '秒まで）');
    let keep = blob;
    if (!portable(blob.type) || blob.size > C.AUDIO_MAX_BYTES) keep = toWav(buf);
    if (keep.size > C.AUDIO_MAX_BYTES) throw new Error('ファイルが大きすぎます');
    const src = await blobToDataURL(keep);
    buffers.set(src, buf);
    return { src: src, name: name, dur: Math.round(buf.duration * 100) / 100, over: true, shift: 0 };
  }

  // 鳴る範囲（秒）。cutStart：このカードの頭、cutEnd：カット（まとまり）の終わり（どちらもコマ）
  function clip(card, cutStart, cutEnd, fps) {
    const a = card && card.audio;
    if (!a) return null;
    const start = cutStart / fps + (a.shift || 0);
    const len = playLen(a);
    const end = a.over === false ? Math.min(start + len, cutEnd / fps) : start + len;
    if (end <= start) return null;
    return { id: card.id, src: a.src, start: start, end: end, from: a.trimIn || 0, name: a.name, over: a.over !== false };
  }

  // 頭・お尻を切ったあとの長さ（秒）
  function playLen(a) { return Math.max(0, a.dur - (a.trimIn || 0) - (a.trimOut || 0)); }

  // 波形：音の from〜to 秒を n 個に分けた、それぞれの大きさ（0〜1）。まだデコードしていなければ null
  const peakCache = new Map();
  function peaks(src, from, to, n) {
    const buf = buffers.get(src);
    if (!buf) return null;
    const key = src.length + ':' + src.slice(-40) + ':' + from + ':' + to + ':' + n;
    if (peakCache.has(key)) return peakCache.get(key);
    const d = buf.getChannelData(0);
    const i0 = Math.floor(from * buf.sampleRate), i1 = Math.min(d.length, Math.floor(to * buf.sampleRate));
    const per = Math.max(1, Math.floor((i1 - i0) / n));
    const out = new Float32Array(n);
    let max = 0;
    for (let k = 0; k < n; k++) {
      let m = 0;
      const a = i0 + k * per, b = Math.min(i1, a + per);
      for (let i = a; i < b; i += 8) { const v = Math.abs(d[i]); if (v > m) m = v; }
      out[k] = m;
      if (m > max) max = m;
    }
    if (max > 0) for (let k = 0; k < n; k++) out[k] /= max;
    if (peakCache.size > 200) peakCache.clear();
    peakCache.set(key, out);
    return out;
  }

  function setOpt(patch) {
    const c = card();
    if (!c || !c.audio) return;
    Store.setAudio(c.id, Object.assign({}, c.audio, patch));
  }

  function secLabel(s) { return (Math.round(s * 10) / 10).toFixed(1) + '秒'; }

  // ---- 「音」欄 ----
  function card() { return cardId ? Store.get(cardId) : null; }

  function fill(id) {
    if (rec && id !== cardId) stopRecording(true);
    stopPreview();
    cardId = id;
    render();
  }

  function render() {
    const box = document.getElementById('draw-audio');
    if (!box) return;
    const c = card();
    const a = c && c.audio;
    const fps = Store.settings().fps;
    document.getElementById('aud-rec').textContent = rec ? '■ 止める' : '🎙 録音';
    document.getElementById('aud-rec').classList.toggle('recording', !!rec);
    document.getElementById('aud-file').disabled = !!rec;
    document.getElementById('aud-play').hidden = !a || !!rec;
    document.getElementById('aud-play').textContent = preview ? '■' : '▶ 聞く';
    document.getElementById('aud-del').hidden = !a || !!rec;
    document.getElementById('aud-opts').hidden = !a || !!rec;
    if (a) {
      document.getElementById('aud-over').checked = a.over !== false;
      const sh = document.getElementById('aud-shift');
      if (document.activeElement !== sh) sh.value = String(a.shift || 0);
    }
    const info = document.getElementById('aud-info');
    const fitBtn = document.getElementById('aud-fit');
    fitBtn.hidden = true;
    if (rec) {
      info.textContent = '録音中… ' + secLabel((performance.now() - rec.t0) / 1000);
    } else if (a) {
      info.textContent = a.name + '（' + secLabel(playLen(a)) + ((a.trimIn || a.trimOut) ? '・切ってあります' : '') + '）';
      const own = Store.get(AP.Draw.openCardId() || cardId);
      const left = own ? own.duration / fps - (a.shift || 0) : 0; // カットの中で鳴れる長さ
      if (own && playLen(a) > left + 0.001) {
        info.textContent += a.over !== false ? '　→ 次のカットにかかります' : '　→ カットの終わりで切れます';
        fitBtn.hidden = false;
      }
    } else {
      info.textContent = '';
    }
  }

  // target：音を付けるカード（元のカード）。hooks（Vコンテのアフレコ用）：
  //   onStart()：録音が実際に始まった瞬間、patch(audio)：保存の前に足すもの（ずらしなど）、onStop()：止まったとき
  async function startRecording(target, hooks) {
    hooks = hooks || {};
    if (rec) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return U.toast('この端末・ブラウザでは録音できません');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      return U.toast('マイクが使えません（ブラウザの設定でマイクを許可してください）');
    }
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(function (t) {
      return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t);
    });
    const mr = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    const r = { mr: mr, stream: stream, chunks: [], t0: performance.now(), cancel: false, target: target || cardId, hooks: hooks };
    rec = r;
    mr.ondataavailable = function (e) { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.onstop = async function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      clearInterval(r.timer);
      if (rec === r) rec = null;
      render();
      if (hooks.onStop) hooks.onStop();
      if (r.cancel || !r.chunks.length) return;
      try {
        const blob = new Blob(r.chunks, { type: (mr.mimeType || type || 'audio/webm').split(';')[0] });
        const audio = await makeAudio(blob, '録音');
        if (hooks.patch) Object.assign(audio, hooks.patch(audio));
        const had = !!(Store.get(r.target) && Store.get(r.target).audio);
        Store.checkpoint();
        Store.setAudio(r.target, audio);
        U.toast('録音しました（' + secLabel(audio.dur) + '）' + (had ? '。前の音は ⌘Z で戻せます' : ''));
      } catch (e) {
        U.toast('録音を保存できませんでした：' + e.message);
      }
    };
    r.timer = setInterval(function () {
      if ((performance.now() - r.t0) / 1000 >= C.AUDIO_REC_MAX_SEC) stopRecording(false);
      else render();
    }, 200);
    mr.onstart = function () { r.t0 = performance.now(); if (hooks.onStart) hooks.onStart(); };
    mr.start();
    render();
  }

  function stopRecording(cancel) {
    if (!rec) return;
    rec.cancel = !!cancel;
    try { rec.mr.stop(); } catch (e) { /* 止まっている */ }
  }

  function pickFile(target) {
    const id = typeof target === 'string' ? target : cardId;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.mp3,.m4a,.wav,.aac';
    input.addEventListener('change', function () { if (input.files[0]) importFile(input.files[0], id); });
    input.click();
  }

  async function importFile(file, id) {
    try {
      const audio = await makeAudio(file, file.name);
      Store.setAudio(id, audio);
      U.toast('音を読み込みました（' + secLabel(audio.dur) + '）');
    } catch (e) {
      U.toast('この音は読み込めませんでした：' + e.message);
    }
  }

  function togglePreview() {
    if (preview) return stopPreview();
    const c = card();
    if (!c || !c.audio) return;
    const a = c.audio;
    preview = new Audio(a.src);
    preview.onended = stopPreview;
    preview.currentTime = a.trimIn || 0;
    preview.ontimeupdate = function () { if (preview && preview.currentTime >= a.dur - (a.trimOut || 0)) stopPreview(); };
    preview.play().catch(function () { stopPreview(); U.toast('再生できませんでした'); });
    render();
  }

  function stopPreview() {
    if (preview) { preview.pause(); preview = null; }
    render();
  }

  function remove() {
    stopPreview();
    if (cardId) Store.setAudio(cardId, null);
    U.toast('音を外しました（取り消しで戻せます）');
  }

  // カットの尺を音の長さに合わせる（いま開いているカット）
  function fitDuration() {
    const c = card();
    if (!c || !c.audio) return;
    const id = AP.Draw.openCardId() || cardId;
    Store.setDuration(id, Math.max(C.MIN_DURATION_FRAMES, Math.ceil((playLen(c.audio) + (c.audio.shift || 0)) * Store.settings().fps)));
    U.toast('尺を音の長さに合わせました');
  }

  // ---- 音の帯（タイムラインと Vコンテで共通）：波形つき。ドラッグ＝ずらす、端＝頭・お尻を切る、タップ ----
  // opts: { container, left, width（CSSの値）, widthPx, lane, pxPerSec(), fps, onStart(), onEnd(next|null, moved) }
  // onEnd の next は動かしたあとの card.audio（動かさなかったら null）。保存は呼んだ側でする
  function makeStrip(cl, opts) {
    const bar = document.createElement('div');
    bar.className = 'tl-audio' + (cl.over ? '' : ' cut');
    bar.style.left = opts.left;
    bar.style.width = opts.width;
    bar.style.marginTop = (opts.lane * C.TL_AUDIO_LANE_PX) + 'px';
    bar.title = '🔊 ' + cl.name + '：ドラッグでタイミングを動かす／端をドラッグで頭・お尻を切る／タップで試聴';
    bar.innerHTML = '<canvas></canvas><span class="tl-aud-name"></span><div class="tl-aud-edge l"></div><div class="tl-aud-edge r"></div>';
    bar.querySelector('.tl-aud-name').textContent = '🔊 ' + cl.name;
    opts.container.appendChild(bar);
    bar.addEventListener('pointerdown', function (e) { stripDown(e, bar, cl, opts); });
    return { el: bar, drawn: drawWave(bar, cl, opts.widthPx) };
  }

  function drawWave(bar, cl, w) {
    const cv = bar.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    const h = 16;
    w = Math.max(1, Math.min(8000, w));
    const n = Math.max(1, Math.min(2000, Math.round(w / 2)));
    const p = peaks(cl.src, cl.from, cl.from + (cl.end - cl.start), n);
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.round(h * dpr);
    if (!p) return false;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#f08c00';
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.04, p[i]) * (h - 2) / 2;
      g.fillRect(i * bw, h / 2 - v, Math.max(1, bw - 0.5), v * 2);
    }
    return true;
  }

  let sDrag = null;
  function stripDown(e, bar, cl, opts) {
    if (sDrag) return;
    e.stopPropagation();
    e.preventDefault();
    const card = Store.get(cl.id);
    if (!card || !card.audio) return;
    const r = bar.getBoundingClientRect();
    const grab = C.TL_AUDIO_EDGE_PX * (e.pointerType === 'mouse' ? 1 : 1.8);
    const mode = e.clientX - r.left < grab ? 'in' : (r.right - e.clientX < grab ? 'out' : 'move');
    const d = sDrag = { pointerId: e.pointerId, bar: bar, opts: opts, mode: mode, x0: e.clientX, a0: Object.assign({}, card.audio),
      left0: bar.offsetLeft, width0: bar.offsetWidth, moved: false, next: null, tip: null };
    function move(ev) { if (ev.pointerId === d.pointerId) stripMove(ev, d); }
    function up(ev) {
      if (ev.pointerId !== d.pointerId || sDrag !== d) return;
      sDrag = null;
      ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t, k) { bar.removeEventListener(t, k ? up : move); });
      if (d.tip) d.tip.remove();
      bar.classList.remove('dragging');
      const ok = ev.type !== 'pointercancel';
      opts.onEnd(ok && d.moved ? d.next : null, ok && d.moved);
    }
    bar.setPointerCapture(e.pointerId);
    bar.addEventListener('pointermove', move);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { bar.addEventListener(t, up); });
    opts.onStart();
  }

  function stripMove(e, d) {
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < C.DRAG_THRESHOLD_MOUSE_PX) return;
    d.moved = true;
    d.bar.classList.add('dragging');
    const fps = d.opts.fps;
    const pps = d.opts.pxPerSec();
    const a = d.a0;
    const trimIn = a.trimIn || 0, trimOut = a.trimOut || 0, shift = a.shift || 0;
    let sec = Math.round(dx / pps * fps) / fps; // 1コマ刻み
    const next = Object.assign({}, a);
    let label;
    if (d.mode === 'move') {
      next.shift = round2(shift + sec);
      d.bar.style.left = (d.left0 + sec * pps) + 'px';
      label = 'ずらし ' + signed(next.shift) + '秒';
    } else if (d.mode === 'in') {
      sec = U.clamp(sec, -trimIn, a.dur - trimIn - trimOut - C.AUDIO_MIN_LEN_SEC);
      next.trimIn = round2(trimIn + sec);
      next.shift = round2(shift + sec);
      d.bar.style.left = (d.left0 + sec * pps) + 'px';
      d.bar.style.width = Math.max(6, d.width0 - sec * pps) + 'px';
      label = '頭を ' + next.trimIn.toFixed(2) + '秒 切る';
    } else {
      sec = U.clamp(sec, -(a.dur - trimIn - trimOut - C.AUDIO_MIN_LEN_SEC), trimOut);
      next.trimOut = round2(trimOut - sec);
      d.bar.style.width = Math.max(6, d.width0 + sec * pps) + 'px';
      label = 'お尻を ' + next.trimOut.toFixed(2) + '秒 切る';
    }
    d.next = next;
    if (!d.tip) { d.tip = document.createElement('div'); d.tip.className = 'tl-aud-tip'; d.bar.parentNode.appendChild(d.tip); }
    d.tip.textContent = label + '（長さ ' + playLen(next).toFixed(2) + '秒）';
    d.tip.style.left = Math.max(0, d.bar.offsetLeft) + 'px';
    d.tip.style.top = (d.bar.offsetTop - 18) + 'px';
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function signed(v) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(2); }

  // ---- Vコンテの再生 ----
  // 使う音を前もってデコードしておく
  function prepare(srcs) {
    return Promise.all(srcs.map(function (src) {
      if (buffers.has(src)) return null;
      if (!decoding.has(src)) {
        decoding.set(src, dataURLToArrayBuffer(src).then(decode).then(function (b) { buffers.set(src, b); })
          .catch(function () { /* 鳴らせない音は飛ばす */ }));
      }
      return decoding.get(src);
    }));
  }

  // clips: [{ src, start, end }]（秒。Vコンテの時間）。いまの位置 at（秒）から鳴らす
  // dest：鳴らす先（ムービーの録画用。なければスピーカー）
  function playClips(clips, at, dest) {
    stopClips();
    const ac = audioCtx();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    const now = ac.currentTime + 0.03;
    clips.forEach(function (cl) {
      const buf = buffers.get(cl.src);
      if (!buf || cl.end <= at) return;
      const offset = (cl.from || 0) + Math.max(0, at - cl.start);
      if (offset >= buf.duration) return;
      const node = ac.createBufferSource();
      node.buffer = buf;
      node.connect(dest || ac.destination);
      const when = now + Math.max(0, cl.start - at);
      node.start(when, offset);
      node.stop(now + (cl.end - at));
      playingNodes.push(node);
    });
  }

  function stopClips() {
    playingNodes.forEach(function (n) { try { n.stop(); } catch (e) { /* 終わっている */ } });
    playingNodes = [];
  }

  // ムービー書き出し用：音を1本にまとめる（先に prepare しておくこと）。totalSec の長さのモノラル。音がなければ null
  async function mix(clips, totalSec, rate) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC || !clips.length) return null;
    const len = Math.max(1, Math.ceil(totalSec * rate));
    const oc = new OAC(1, len, rate);
    let any = false;
    clips.forEach(function (cl) {
      const buf = buffers.get(cl.src);
      if (!buf || cl.end <= 0 || cl.start >= totalSec) return;
      const node = oc.createBufferSource();
      node.buffer = buf;
      node.connect(oc.destination);
      const offset = (cl.from || 0) + Math.max(0, -cl.start);
      if (offset >= buf.duration) return;
      node.start(Math.max(0, cl.start), offset);
      node.stop(Math.min(totalSec, cl.end));
      any = true;
    });
    if (!any) return null;
    return new Promise(function (resolve, reject) {
      oc.oncomplete = function (e) { resolve(e.renderedBuffer); };
      const p = oc.startRendering();
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // 録画用の鳴らし先（MediaStream の音声トラックになる）
  function streamDestination() {
    const ac = audioCtx();
    if (!ac || !ac.createMediaStreamDestination) return null;
    if (ac.state === 'suspended') ac.resume();
    return ac.createMediaStreamDestination();
  }

  function init() {
    document.getElementById('aud-rec').addEventListener('click', function () { rec ? stopRecording(false) : startRecording(cardId); });
    document.getElementById('aud-file').addEventListener('click', function () { pickFile(cardId); });
    document.getElementById('aud-play').addEventListener('click', togglePreview);
    document.getElementById('aud-del').addEventListener('click', remove);
    document.getElementById('aud-fit').addEventListener('click', fitDuration);
    document.getElementById('aud-over').addEventListener('change', function (e) { setOpt({ over: e.target.checked }); });
    const sh = document.getElementById('aud-shift');
    sh.step = String(C.AUDIO_SHIFT_STEP);
    sh.addEventListener('change', function () {
      const v = Math.round((parseFloat(sh.value) || 0) * 100) / 100;
      sh.value = String(v);
      setOpt({ shift: v });
    });
    Store.subscribe(function (reason) {
      if (reason === 'audio' || reason === 'duration' || reason === 'load' || reason === 'undo' || reason === 'redo') render();
    });
  }

  AP.Audio = {
    init: init,
    fill: fill,
    close: function () { stopRecording(true); stopPreview(); cardId = null; },
    importFile: importFile,
    clip: clip,
    playLen: playLen,
    peaks: peaks,
    makeStrip: makeStrip,
    startRecording: startRecording,
    stopRecording: stopRecording,
    isRecording: function () { return !!rec; },
    pickFile: pickFile,
    prepare: prepare,
    playClips: playClips,
    mix: mix,
    streamDestination: streamDestination,
    stopClips: stopClips,
    buffer: function (src) { return buffers.get(src) || null; },
    toWav: toWav,
  };
})();
