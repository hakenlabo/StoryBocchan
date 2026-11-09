/*
 * AP.Audio：カットの音（録音・音のファイル）。
 * card.audio = { src: data URL, name, dur（秒）, over, shift }。セリフと同じく元のカードが持つ（連動カットは共通）。
 *   over：鳴り終わるまで鳴らす（次のカットにかかってもよい）。false ならカット（同じカットにまとめた絵ならまとまり）の終わりで止める。既定は true
 *   shift：カットの頭から何秒ずらして鳴らし始めるか。マイナスなら前のカットのうちから先に鳴る（音の先行）
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
    const end = a.over === false ? Math.min(start + a.dur, cutEnd / fps) : start + a.dur;
    if (end <= start) return null;
    return { src: a.src, start: start, end: end, name: a.name, over: a.over !== false };
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
      info.textContent = a.name + '（' + secLabel(a.dur) + '）';
      const own = Store.get(AP.Draw.openCardId() || cardId);
      const left = own ? own.duration / fps - (a.shift || 0) : 0; // カットの中で鳴れる長さ
      if (own && a.dur > left + 0.001) {
        info.textContent += a.over !== false ? '　→ 次のカットにかかります' : '　→ カットの終わりで切れます';
        fitBtn.hidden = false;
      }
    } else {
      info.textContent = '';
    }
  }

  async function startRecording() {
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
    const r = { mr: mr, stream: stream, chunks: [], t0: performance.now(), cancel: false, target: cardId };
    rec = r;
    mr.ondataavailable = function (e) { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.onstop = async function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      clearInterval(r.timer);
      if (rec === r) rec = null;
      render();
      if (r.cancel || !r.chunks.length) return;
      try {
        const blob = new Blob(r.chunks, { type: (mr.mimeType || type || 'audio/webm').split(';')[0] });
        const audio = await makeAudio(blob, '録音');
        Store.setAudio(r.target, audio);
        U.toast('録音しました（' + secLabel(audio.dur) + '）');
      } catch (e) {
        U.toast('録音を保存できませんでした：' + e.message);
      }
    };
    r.timer = setInterval(function () {
      if ((performance.now() - r.t0) / 1000 >= C.AUDIO_REC_MAX_SEC) stopRecording(false);
      else render();
    }, 200);
    mr.start();
    render();
  }

  function stopRecording(cancel) {
    if (!rec) return;
    rec.cancel = !!cancel;
    try { rec.mr.stop(); } catch (e) { /* 止まっている */ }
  }

  function pickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.mp3,.m4a,.wav,.aac';
    input.addEventListener('change', function () { if (input.files[0]) importFile(input.files[0], cardId); });
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
    preview = new Audio(c.audio.src);
    preview.onended = stopPreview;
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
    Store.setDuration(id, Math.max(C.MIN_DURATION_FRAMES, Math.ceil((c.audio.dur + (c.audio.shift || 0)) * Store.settings().fps)));
    U.toast('尺を音の長さに合わせました');
  }

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
      const offset = Math.max(0, at - cl.start);
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
      const offset = Math.max(0, -cl.start);
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
    document.getElementById('aud-rec').addEventListener('click', function () { rec ? stopRecording(false) : startRecording(); });
    document.getElementById('aud-file').addEventListener('click', pickFile);
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
    prepare: prepare,
    playClips: playClips,
    mix: mix,
    streamDestination: streamDestination,
    stopClips: stopClips,
    buffer: function (src) { return buffers.get(src) || null; },
    toWav: toWav,
  };
})();
