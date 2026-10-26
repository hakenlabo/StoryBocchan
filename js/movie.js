/*
 * AP.Movie：Vコンテをムービー（MP4）に書き出す。
 * - 1コマずつ AP.Vconte.renderFrame で描いて、WebCodecs の VideoEncoder（H.264）で符号化し、AP.Mp4 で箱詰めする。
 *   再生しながら録るのではないので、尺より早く終わる。画面のVコンテと同じ絵（シーン構成・尺・カメラワーク・重ね表示）になる。
 * - VideoEncoder が使えないブラウザでは、キャンバスを実時間で録画する（MediaRecorder。尺と同じだけ時間がかかる）。
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

  // ---- WebCodecs で書き出す ----
  async function encodeWebCodecs(cfg, w, h, fps, onProgress) {
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
    onProgress(1);
    return AP.Mp4.build({ width: w, height: h, fps: fps, samples: samples, avcC: avcC });
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
      const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
        .find(function (t) { return MediaRecorder.isTypeSupported(t); }) || '';
      const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: Math.round(w * h * fps * C.MOVIE_BITS_PER_PIXEL) } : {});
      const parts = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
      rec.onstop = function () {
        if (cancelled) return resolve(null);
        resolve(new Blob(parts, { type: rec.mimeType || type || 'video/webm' }));
      };
      rec.start();
      const t0 = performance.now();
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
      const cfgs = await findConfigs(sz.w, sz.h, fps);
      let blob, ext = 'mp4', done = false;
      for (let i = 0; i < cfgs.length && !done && !cancelled; i++) {
        setStatus('書き出し中…（' + sz.w + '×' + sz.h + '）');
        try {
          blob = await encodeWebCodecs(cfgs[i], sz.w, sz.h, fps, setProgress);
          done = true;
        } catch (e) {
          if (!e || e.message !== 'stalled') throw e;
          console.warn('ムービーの符号化が止まったので切り替えます', cfgs[i].codec);
        }
      }
      if (!done && !cancelled) {
        setStatus('この端末は速い書き出しに対応していないので、再生しながら録画しています（尺と同じ時間がかかります）');
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
      'カット番号・テキスト・セリフの重ね表示は、Vコンテの画面のチェックのとおりに入ります。音は入りません。';
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
      const cfgs = await findConfigs(sz.w, sz.h, fps);
      if (!cfgs.length) return null;
      return encodeWebCodecs(cfgs[0], sz.w, sz.h, fps, function () {});
    },
  };
})();
