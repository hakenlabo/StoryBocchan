/*
 * AP.Movie：Vコンテをムービー（MP4）に書き出す。
 * - 1コマずつ AP.Vconte.renderFrame で描いて、WebCodecs の VideoEncoder（H.264）で符号化し、AP.Mp4 で箱詰めする。
 *   再生しながら録るのではないので、尺より早く終わる。画面のVコンテと同じ絵（シーン構成・尺・カメラワーク・重ね表示）になる。
 * - VideoEncoder が使えないブラウザでは、キャンバスを実時間で録画する（MediaRecorder。尺と同じだけ時間がかかる）。
 * - 音：カットの音（AP.Audio）を OfflineAudioContext で1本にまとめ、AudioEncoder（AAC-LC）で符号化して MP4 に入れる。
 *   AudioEncoder の AAC がない端末で音があるときは、音ごと実時間で録画する（音を落とさないため）。
 *   Vコンテの「音」チェックがオフなら音は入れない（画面のVコンテと同じ）。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let back = null, cancelled = false, busy = false;
  const choice = { size: 720 };

  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

  // 長い辺を size にした大きさ（16:9 なら 1280×720 か 1920×1080）
  function frameSize(size) {
    const r = U.aspectRatio(Store.settings().aspect);
    const longSide = Math.round(size * 16 / 9);
    return r >= 1 ? { w: even(longSide), h: even(longSide / r) } : { w: even(longSide * r), h: even(longSide) };
  }

  function fileName(ext) {
    return String(Store.project().title || '無題の作品').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) + '_Vコンテ.' + ext;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function withTimeout(p, ms) {
    return Promise.race([p, wait(ms).then(function () { throw new Error('stalled'); })]);
  }

  // 使える H.264 の設定を探す（端末によって対応している種類が違う）。
  // iPad の WebKit は Main／High（4d・64）を「使える」と答えるのに、実際には何も出てこないことがある。
  // だから Baseline（42）を先に試し、さらに数コマ試しに符号化して、本当に出てきた設定だけを返す。
  async function findConfigs(w, h, fps) {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return [];
    const bitrate = Math.round(w * h * fps * C.MOVIE_BITS_PER_PIXEL);
    const codecs = ['avc1.42002a', 'avc1.42001f', 'avc1.4d0028', 'avc1.640028'];
    const found = [];
    for (let i = 0; i < codecs.length; i++) {
      const cfg = { codec: codecs[i], width: w, height: h, framerate: fps, bitrate: bitrate, avc: { format: 'avc' } };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported && await probe(cfg, w, h)) found.push(cfg);
      } catch (e) { /* 次を試す */ }
      if (found.length >= 2) break;   // 予備が1つあれば十分
    }
    return found;
  }

  // 試しに3コマ符号化して、決めた時間内に設定（avcC）とコマが出てくるか
  async function probe(cfg, w, h) {
    let outs = 0, desc = false, enc = null;
    try {
      enc = new VideoEncoder({
        output: function (chunk, meta) { outs++; if (meta && meta.decoderConfig && meta.decoderConfig.description) desc = true; },
        error: function () {},
      });
      enc.configure(cfg);
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      for (let f = 0; f < 3; f++) {
        ctx.fillStyle = f % 2 ? '#fff' : '#ddd';
        ctx.fillRect(0, 0, w, h);
        const vf = new VideoFrame(cv, { timestamp: f * 40000, duration: 40000 });
        enc.encode(vf, { keyFrame: f === 0 });
        vf.close();
      }
      await withTimeout(enc.flush(), C.MOVIE_PROBE_MS);
      return outs >= 3 && desc;
    } catch (e) {
      return false;
    } finally {
      try { if (enc && enc.state !== 'closed') enc.close(); } catch (e) { /* 何もしない */ }
    }
  }

  // ---- 音 ----
  function aacConfig() {
    return { codec: 'mp4a.40.2', sampleRate: C.MOVIE_AUDIO_RATE, numberOfChannels: 1, bitrate: C.MOVIE_AUDIO_BITRATE, aac: { format: 'aac' } };
  }

  async function aacSupported() {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
    try {
      const r = await AudioEncoder.isConfigSupported(aacConfig());
      return !!(r && r.supported);
    } catch (e) { return false; }
  }

  // AAC-LC の AudioSpecificConfig（符号化器が出さなかったとき用）
  function makeAsc(rate, channels) {
    const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(rate);
    return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
  }

  // まとめた音（AudioBuffer、モノラル）→ MP4 用の AAC のサンプル
  async function encodeAudio(buf) {
    const cfg = aacConfig();
    const samples = [];
    let asc = null, failure = null;
    const enc = new AudioEncoder({
      output: function (chunk, meta) {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !asc) {
          const d = meta.decoderConfig.description;
          asc = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data: data, ts: chunk.timestamp });
      },
      error: function (e) { failure = e; },
    });
    enc.configure(cfg);
    const pcm = buf.getChannelData(0);
    const STEP = 4800; // 0.1秒ずつ渡す
    for (let i = 0; i < pcm.length; i += STEP) {
      if (cancelled) { enc.close(); return null; }
      if (failure) throw failure;
      const part = pcm.slice(i, Math.min(pcm.length, i + STEP));
      const ad = new AudioData({ format: 'f32-planar', sampleRate: cfg.sampleRate, numberOfFrames: part.length, numberOfChannels: 1,
        timestamp: Math.round(i / cfg.sampleRate * 1e6), data: part });
      enc.encode(ad);
      ad.close();
      if (enc.encodeQueueSize > 20) await wait(1);
    }
    try {
      await withTimeout(enc.flush(), C.MOVIE_STALL_MS);
    } finally {
      if (enc.state !== 'closed') enc.close();
    }
    if (failure) throw failure;
    samples.sort(function (a, b) { return a.ts - b.ts; });
    return { samples: samples, rate: cfg.sampleRate, channels: 1, bitrate: cfg.bitrate, asc: asc || makeAsc(cfg.sampleRate, 1) };
  }

  // 書き出す音（なければ null）
  async function mixedAudio(totalSec) {
    const clips = AP.Vconte.audioClips();
    if (!clips.length) return null;
    await AP.Audio.prepare(clips.map(function (c) { return c.src; }));
    return AP.Audio.mix(clips, totalSec, C.MOVIE_AUDIO_RATE);
  }

  // ---- WebCodecs で書き出す ----
  async function encodeWebCodecs(cfg, w, h, fps, onProgress, audioBuf) {
    AP.Vconte.rebuild();
    const total = AP.Vconte.totalFrames();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const samples = [];
    let avcC = null;
    let failure = null;
    let lastOutput = performance.now();
    const encoder = new VideoEncoder({
      output: function (chunk, meta) {
        lastOutput = performance.now();
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !avcC) {
          const d = meta.decoderConfig.description;
          avcC = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data: data, key: chunk.type === 'key', ts: chunk.timestamp });
      },
      error: function (e) { failure = e; },
    });
    encoder.configure(cfg);
    const frameUs = 1e6 / fps;
    const keyEvery = Math.max(1, Math.round(fps * C.MOVIE_KEYFRAME_SEC));
    for (let f = 0; f < total; f++) {
      if (cancelled) { encoder.close(); return null; }
      if (failure) throw failure;
      AP.Vconte.renderFrame(ctx, w, h, f);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(f * frameUs), duration: Math.round(frameUs) });
      encoder.encode(vf, { keyFrame: f % keyEvery === 0 });
      vf.close();
      // 符号化が追いつくまで少し待つ（メモリを使いすぎないように）。進み具合も見せる
      if (encoder.encodeQueueSize > 8 || f % 6 === 0) {
        onProgress(f / total);
        await wait(0);
        while (encoder.encodeQueueSize > 8) {
          if (failure) throw failure;
          if (cancelled) { encoder.close(); return null; }
          if (performance.now() - lastOutput > C.MOVIE_STALL_MS) { encoder.close(); throw new Error('stalled'); }
          await wait(5);
        }
      }
    }
    try {
      await withTimeout(encoder.flush(), C.MOVIE_STALL_MS);
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }
    if (failure) throw failure;
    if (!avcC) throw new Error('この端末では映像の設定を取り出せませんでした');
    samples.sort(function (a, b) { return a.ts - b.ts; });
    const audio = audioBuf ? await encodeAudio(audioBuf) : null;
    if (cancelled) return null;
    onProgress(1);
    return AP.Mp4.build({ width: w, height: h, fps: fps, samples: samples, avcC: avcC, audio: audio });
  }

  // ---- 実時間で録画する（VideoEncoder がないとき） ----
  function recordRealtime(w, h, fps, onProgress) {
    return new Promise(function (resolve, reject) {
      if (typeof MediaRecorder === 'undefined') return reject(new Error('このブラウザではムービーを書き出せません'));
      AP.Vconte.rebuild();
      const total = AP.Vconte.totalFrames();
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      AP.Vconte.renderFrame(ctx, w, h, 0);
      const stream = canvas.captureStream(fps);
      // 音：録画しながらカットの音を鳴らして、音声トラックとして入れる
      const clips = AP.Vconte.audioClips();
      const dest = clips.length ? AP.Audio.streamDestination() : null;
      if (dest) dest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
      const type = (dest ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
        : ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'])
        .find(function (t) { return MediaRecorder.isTypeSupported(t); }) || '';
      const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: Math.round(w * h * fps * C.MOVIE_BITS_PER_PIXEL) } : {});
      const parts = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
      rec.onstop = function () {
        if (dest) AP.Audio.stopClips();
        if (cancelled) return resolve(null);
        resolve(new Blob(parts, { type: rec.mimeType || type || 'video/webm' }));
      };
      rec.start();
      const t0 = performance.now();
      if (dest) AP.Audio.playClips(clips, 0, dest);
      (function step() {
        if (cancelled) { rec.stop(); return; }
        const f = Math.floor((performance.now() - t0) / 1000 * fps);
        if (f >= total) { setTimeout(function () { rec.stop(); }, 200); onProgress(1); return; }
        AP.Vconte.renderFrame(ctx, w, h, f);
        onProgress(f / total);
        requestAnimationFrame(step);
      })();
    });
  }

  async function exportMovie() {
    if (busy) return;
    const total = (AP.Vconte.rebuild(), AP.Vconte.totalFrames());
    if (!total) return U.toast('タイムラインにカットがありません');
    busy = true;
    cancelled = false;
    AP.Vconte.hide();
    const fps = Store.settings().fps;
    const sz = frameSize(choice.size);
    setRunning(true);
    let saved = false;
    try {
      setStatus('準備中…');
      await AP.Draw.imagesReady();
      const audioBuf = await mixedAudio(total / fps);
      // 音があるのに AAC の符号化器がない端末は、音ごと実時間で録画する
      const cfgs = audioBuf && !(await aacSupported()) ? [] : await findConfigs(sz.w, sz.h, fps);
      let blob, ext = 'mp4', done = false;
      for (let i = 0; i < cfgs.length && !done && !cancelled; i++) {
        setStatus('書き出し中…（' + sz.w + '×' + sz.h + (audioBuf ? '・音あり' : '') + '）');
        try {
          blob = await encodeWebCodecs(cfgs[i], sz.w, sz.h, fps, setProgress, audioBuf);
          done = true;
        } catch (e) {
          if (!e || e.message !== 'stalled') throw e;
          console.warn('ムービーの符号化が止まったので切り替えます', cfgs[i].codec);
        }
      }
      if (!done && !cancelled) {
        setStatus('この端末は速い書き出し' + (audioBuf ? '（音つき）' : '') + 'に対応していないので、再生しながら録画しています（尺と同じ時間がかかります）');
        blob = await recordRealtime(sz.w, sz.h, fps, setProgress);
        if (blob && !/mp4/.test(blob.type)) ext = 'webm';
      }
      if (!blob) { U.toast('書き出しをやめました'); return; }
      const name = fileName(ext);
      download(blob, name);
      U.toast('「' + name + '」を保存しました（' + (blob.size / 1048576).toFixed(1) + 'MB）');
      saved = true;
    } catch (e) {
      console.error(e);
      U.toast('ムービーを書き出せませんでした：' + (e && e.message ? e.message : e));
    } finally {
      busy = false;
      setRunning(false);
      setStatus('');
      if (saved) close();   // busy の間は close() が効かないので、ここで閉じる
      AP.Vconte.show();
    }
  }

  // ------------------------------------------------------------
  // 画面
  // ------------------------------------------------------------
  function setRunning(on) {
    if (!back) return;
    back.querySelector('.mv-go').hidden = on;
    back.querySelector('.mv-cancel').textContent = on ? '書き出しをやめる' : '閉じる';
    back.querySelector('.mv-progress').hidden = !on;
    back.querySelectorAll('.mv-body button').forEach(function (b) { b.disabled = on; });
    if (!on) setProgress(0);
  }
  function setProgress(r) {
    if (!back) return;
    back.querySelector('.mv-bar').style.width = Math.round(r * 100) + '%';
    back.querySelector('.mv-pct').textContent = Math.round(r * 100) + '%';
  }
  function setStatus(t) { if (back) back.querySelector('.mv-status').textContent = t; }

  function render() {
    const body = back.querySelector('.mv-body');
    const fps = Store.settings().fps;
    AP.Vconte.rebuild();
    const total = AP.Vconte.totalFrames();
    body.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'cam-row';
    row.innerHTML = '<div class="cam-label">大きさ</div>';
    const g = document.createElement('div');
    g.className = 'cam-seg';
    [720, 1080].forEach(function (s) {
      const sz = frameSize(s);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = (s === 720 ? '720p' : '1080p') + '（' + sz.w + '×' + sz.h + '）';
      if (choice.size === s) b.classList.add('active');
      b.addEventListener('click', function () { choice.size = s; render(); });
      g.appendChild(b);
    });
    row.appendChild(g);
    body.appendChild(row);
    const p = document.createElement('p');
    p.className = 'pdf-note';
    p.textContent = '尺 ' + U.framesToLabel(total, fps) + '（' + total + 'コマ・' + fps + 'fps）。Vコンテの「シーン構成」でオンのシーンを、その順に書き出します。' +
      'カット番号・テキスト・セリフの重ね表示と音は、Vコンテの画面のチェックのとおりに入ります。';
    body.appendChild(p);
    setStatus('');
  }

  function open() {
    if (!back) {
      back = document.createElement('div');
      back.className = 'dialog-back mv-back';
      back.innerHTML =
        '<div class="dialog mv-dialog" role="dialog">' +
        '  <div class="dialog-title">ムービー（MP4）に書き出す</div>' +
        '  <div class="mv-body"></div>' +
        '  <div class="mv-progress" hidden><div class="mv-track"><div class="mv-bar"></div></div><span class="mv-pct">0%</span></div>' +
        '  <p class="mv-status"></p>' +
        '  <div class="dialog-buttons"><button type="button" class="mv-cancel">閉じる</button>' +
        '  <button type="button" class="primary mv-go">書き出す</button></div>' +
        '</div>';
      document.body.appendChild(back);
      back.querySelector('.mv-go').addEventListener('click', exportMovie);
      back.querySelector('.mv-cancel').addEventListener('click', function () {
        if (busy) { cancelled = true; setStatus('やめています…'); } else close();
      });
      document.addEventListener('keydown', function (e) {
        if (!back.hidden && e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          if (busy) cancelled = true; else close();
        }
      }, true);
    }
    back.hidden = false;
    render();
  }

  function close() { if (back && !busy) back.hidden = true; }

  function init() {
    document.getElementById('vc-movie').addEventListener('click', function () { AP.Vconte.hide(); open(); });
  }

  AP.Movie = {
    init: init,
    open: open,
    isOpen: function () { return !!back && !back.hidden; },
    // テスト用：ダイアログを通さずに Blob を作る
    build: async function (size) {
      const fps = Store.settings().fps;
      const sz = frameSize(size || 720);
      cancelled = false;
      await AP.Draw.imagesReady();
      const cfgs = await findConfigs(sz.w, sz.h, fps);
      if (!cfgs.length) return null;
      AP.Vconte.rebuild();
      const audioBuf = await mixedAudio(AP.Vconte.totalFrames() / fps);
      return encodeWebCodecs(cfgs[0], sz.w, sz.h, fps, function () {}, audioBuf);
    },
  };
})();
