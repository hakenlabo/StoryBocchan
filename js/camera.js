/*
 * AP.Camera：カメラワーク（PAN / FOLLOW / T.U / T.B / FI / FO）の計算と設定パネル。
 *
 * card.camera = {
 *   move: 'none'|'pan'|'follow'|'tu'|'tb',
 *   dir: 'left'|'right'|'up'|'down',   PAN・FOLLOW の向き（カメラが動く向き。PAN→ は絵が左へ流れる）
 *   amount: 数値,                       PAN＝拡大率、T.U／T.B＝寄りの倍率、FOLLOW＝1カットで流れる画面数
 *   focus: [fx, fy],                    T.U／T.B で寄る位置、PANの縦（横）位置。0〜1
 *   ease: 'linear'|'slow',              均等／スロー（ゆっくり始まりゆっくり止まる）
 *   fi: コマ数, fo: コマ数, fadeColor: 'black'|'white'
 * }
 * 計算は「絵の座標」（幅 CONFIG.DRAW_BASE_W）で行い、カメラの窓 {z, cx, cy} を返す。
 * z＝拡大率（窓の幅＝絵の幅/z）、cx, cy＝窓の中心。FOLLOW は絵を並べて敷き詰める（tile）。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  const MOVES = [
    { id: 'none', label: 'なし' },
    { id: 'pan', label: 'PAN' },
    { id: 'follow', label: 'FOLLOW' },
    { id: 'tu', label: 'T.U' },
    { id: 'tb', label: 'T.B' },
  ];
  const DIRS = [
    { id: 'left', label: '←' },
    { id: 'right', label: '→' },
    { id: 'up', label: '↑' },
    { id: 'down', label: '↓' },
  ];
  const ARROW = { left: '←', right: '→', up: '↑', down: '↓' };

  function defaults() {
    return { move: 'none', dir: 'right', amount: null, focus: [0.5, 0.5], ease: 'linear', fi: 0, fo: 0, fadeColor: 'black' };
  }

  function amountsFor(move) {
    if (move === 'pan') return C.CAM_PAN_AMOUNTS;
    if (move === 'follow') return C.CAM_FOLLOW_AMOUNTS;
    if (move === 'tu' || move === 'tb') return C.CAM_ZOOM_AMOUNTS;
    return [];
  }

  function full(cam) { return Object.assign(defaults(), cam || {}); }

  function isEmpty(cam) {
    return !cam || ((!cam.move || cam.move === 'none') && !cam.fi && !cam.fo);
  }

  function amountOf(cam) {
    const list = amountsFor(cam.move);
    return cam.amount || list[Math.min(C.CAM_DEFAULT_AMOUNT_INDEX, list.length - 1)] || 1;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // カット内の進み具合 t（0〜1）でのカメラの窓
  function view(cam, t, baseH) {
    const W = C.DRAW_BASE_W, H = baseH;
    const v = { z: 1, cx: W / 2, cy: H / 2, tile: null };
    if (!cam || !cam.move || cam.move === 'none') return v;
    const c = full(cam);
    const a = amountOf(c);
    const e = c.ease === 'slow' ? (1 - Math.cos(Math.PI * t)) / 2 : t;
    const horiz = c.dir === 'left' || c.dir === 'right';

    if (c.move === 'pan') {
      v.z = a;
      const vw = W / a, vh = H / a;
      if (horiz) {
        v.cy = U.clamp(c.focus[1] * H, vh / 2, H - vh / 2);
        const from = vw / 2, to = W - vw / 2;
        v.cx = c.dir === 'right' ? lerp(from, to, e) : lerp(to, from, e);
      } else {
        v.cx = U.clamp(c.focus[0] * W, vw / 2, W - vw / 2);
        const from = vh / 2, to = H - vh / 2;
        v.cy = c.dir === 'down' ? lerp(from, to, e) : lerp(to, from, e);
      }
    } else if (c.move === 'follow') {
      // 背景が流れ続ける。速さは均等（緩急をつけると止まって見えるため）
      const dist = a * (horiz ? W : H) * t;
      if (c.dir === 'right') v.cx += dist;
      else if (c.dir === 'left') v.cx -= dist;
      else if (c.dir === 'down') v.cy += dist;
      else v.cy -= dist;
      v.tile = horiz ? 'x' : 'y';
    } else if (c.move === 'tu' || c.move === 'tb') {
      const k = c.move === 'tu' ? e : 1 - e;  // 0＝引き、1＝寄り
      v.z = lerp(1, a, k);
      const tx = c.focus[0] * W, ty = c.focus[1] * H;
      v.cx = U.clamp(lerp(W / 2, tx, k), W / (2 * v.z), W - W / (2 * v.z));
      v.cy = U.clamp(lerp(H / 2, ty, k), H / (2 * v.z), H - H / (2 * v.z));
    }
    return v;
  }

  // 窓を絵の座標の四角形に（描画パネルの枠表示用）
  function rectOf(v, baseH) {
    const w = C.DRAW_BASE_W / v.z, h = baseH / v.z;
    return { x: v.cx - w / 2, y: v.cy - h / 2, w: w, h: h };
  }

  // FI／FO の重ね色。local はカット内のコマ（0始まり）
  function fade(cam, local, duration) {
    if (!cam) return null;
    const fi = Math.min(cam.fi || 0, duration);
    const fo = Math.min(cam.fo || 0, duration);
    let alpha = 0;
    if (fi > 0 && local < fi) alpha = Math.max(alpha, 1 - local / fi);
    if (fo > 0 && local >= duration - fo) alpha = Math.max(alpha, (local - (duration - fo) + 1) / fo);
    if (alpha <= 0) return null;
    return { alpha: Math.min(1, alpha), color: cam.fadeColor === 'white' ? '#ffffff' : '#000000' };
  }

  function label(cam) {
    if (isEmpty(cam)) return '';
    const c = full(cam);
    const parts = [];
    if (c.move === 'pan' || c.move === 'follow') parts.push((c.move === 'pan' ? 'PAN' : 'FOLLOW') + ARROW[c.dir]);
    else if (c.move === 'tu') parts.push('T.U');
    else if (c.move === 'tb') parts.push('T.B');
    if (c.fi) parts.push('F.I');
    if (c.fo) parts.push('F.O');
    return parts.join(' ');
  }

  // ------------------------------------------------------------
  // 設定パネル
  // ------------------------------------------------------------
  let back = null, body, pv, pvCtx, titleEl;
  let cardId = null;
  let raf = 0, pvStart = 0;

  function cur() { return full(Store.get(cardId) && Store.get(cardId).camera); }

  function save(patch) {
    const next = Object.assign(cur(), patch);
    if (patch.move) next.amount = null; // 動きを変えたら量は既定に
    Store.setCamera(cardId, isEmpty(next) ? null : next);
    build();
  }

  function seg(title, items, value, onPick, extraClass) {
    const row = document.createElement('div');
    row.className = 'cam-row' + (extraClass ? ' ' + extraClass : '');
    const t = document.createElement('div');
    t.className = 'cam-label';
    t.textContent = title;
    const g = document.createElement('div');
    g.className = 'cam-seg';
    items.forEach(function (it) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      b.dataset.v = String(it.id);
      if (String(it.id) === String(value)) b.classList.add('active');
      b.addEventListener('click', function () { onPick(it.id); });
      g.appendChild(b);
    });
    row.appendChild(t);
    row.appendChild(g);
    return row;
  }

  function build() {
    const card = Store.get(cardId);
    if (!card) return close();
    const c = cur();
    const fps = Store.settings().fps;
    const list = Store.timelineCards();
    const i = list.findIndex(function (x) { return x.id === cardId; });
    titleEl.textContent = 'カメラワーク　' + (i >= 0 ? '#' + (i + 1) + '  ' : '') + (Store.source(card).text || '（無題）') +
      '　（尺 ' + U.framesToLabel(card.duration, fps) + '）';

    body.innerHTML = '';
    body.appendChild(seg('動き', MOVES, c.move, function (v) { save({ move: v }); }));
    if (c.move === 'pan' || c.move === 'follow') {
      body.appendChild(seg('向き', DIRS, c.dir, function (v) { save({ dir: v }); }));
    }
    if (c.move !== 'none') {
      const unit = c.move === 'follow' ? '画面' : '倍';
      body.appendChild(seg(c.move === 'follow' ? '流れる量' : (c.move === 'pan' ? '拡大' : '寄り'),
        amountsFor(c.move).map(function (a) { return { id: a, label: a + unit }; }),
        amountOf(c), function (v) { save({ amount: v }); }));
    }
    if (c.move === 'tu' || c.move === 'tb') {
      // 寄る位置（3×3）
      const row = document.createElement('div');
      row.className = 'cam-row';
      row.innerHTML = '<div class="cam-label">寄る位置</div>';
      const grid = document.createElement('div');
      grid.className = 'cam-grid';
      [0, 0.5, 1].forEach(function (fy) {
        [0, 0.5, 1].forEach(function (fx) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.v = fx + ',' + fy;
          if (c.focus[0] === fx && c.focus[1] === fy) b.classList.add('active');
          b.addEventListener('click', function () { save({ focus: [fx, fy] }); });
          grid.appendChild(b);
        });
      });
      row.appendChild(grid);
      body.appendChild(row);
    }
    if (c.move === 'pan' || c.move === 'tu' || c.move === 'tb') {
      body.appendChild(seg('緩急', [{ id: 'linear', label: '均等' }, { id: 'slow', label: 'スロー（ゆっくり出てゆっくり止まる）' }],
        c.ease, function (v) { save({ ease: v }); }));
    }
    const fadeItems = [{ id: 0, label: 'なし' }].concat(C.CAM_FADE_SECS.map(function (s) {
      const f = Math.max(1, Math.round(s * fps));
      return { id: f, label: U.framesToLabel(f, fps) };
    }));
    // 選択肢にない長さ（fpsを変えたときなど）も表示しておく
    [c.fi, c.fo].forEach(function (f) {
      if (f && !fadeItems.some(function (x) { return x.id === f; })) fadeItems.push({ id: f, label: U.framesToLabel(f, fps) });
    });
    body.appendChild(seg('F.I', fadeItems, c.fi || 0, function (v) { save({ fi: v }); }));
    body.appendChild(seg('F.O', fadeItems, c.fo || 0, function (v) { save({ fo: v }); }));
    if (c.fi || c.fo) {
      body.appendChild(seg('色', [{ id: 'black', label: '黒' }, { id: 'white', label: '白' }],
        c.fadeColor, function (v) { save({ fadeColor: v }); }));
    }
    layoutPreview();
  }

  function layoutPreview() {
    const ratio = U.aspectRatio(Store.settings().aspect);
    const w = C.CAM_PREVIEW_W;
    const h = Math.round(w / ratio);
    const dpr = window.devicePixelRatio || 1;
    pv.style.width = w + 'px';
    pv.style.height = h + 'px';
    if (pv.width !== Math.round(w * dpr)) { pv.width = Math.round(w * dpr); pv.height = Math.round(h * dpr); }
  }

  // プレビュー：このカットだけを尺どおりにくり返し再生
  function tick(now) {
    if (!cardId) return;
    const card = Store.get(cardId);
    if (!card) return close();
    const fps = Store.settings().fps;
    const local = Math.floor((now - pvStart) / 1000 * fps) % Math.max(1, card.duration);
    AP.Vconte.renderCut(pvCtx, pv.width, pv.height, card, local, -1, { overlays: false });
    raf = requestAnimationFrame(tick);
  }

  function onKey(e) {
    if (!cardId) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function open(id) {
    if (!Store.get(id)) return;
    if (!back) createDom();
    cardId = id;
    back.hidden = false;
    build();
    pvStart = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function close() {
    cardId = null;
    cancelAnimationFrame(raf);
    if (back) back.hidden = true;
  }

  function createDom() {
    back = document.createElement('div');
    back.className = 'dialog-back cam-back';
    back.hidden = true;
    back.innerHTML =
      '<div class="dialog cam-dialog" role="dialog">' +
      '  <div class="dialog-title cam-title"></div>' +
      '  <div class="cam-preview"><canvas></canvas><div class="cam-pv-note">このカットをくり返し再生しています</div></div>' +
      '  <div class="cam-body"></div>' +
      '  <div class="dialog-buttons"><button type="button" class="cam-clear">カメラワークを消す</button>' +
      '  <button type="button" class="primary cam-close">閉じる</button></div>' +
      '</div>';
    document.body.appendChild(back);
    body = back.querySelector('.cam-body');
    pv = back.querySelector('canvas');
    pvCtx = pv.getContext('2d');
    titleEl = back.querySelector('.cam-title');
    back.querySelector('.cam-close').addEventListener('click', close);
    back.querySelector('.cam-clear').addEventListener('click', function () {
      Store.setCamera(cardId, null);
      build();
    });
    back.addEventListener('pointerdown', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
  }

  AP.Camera = {
    view: view,
    rectOf: rectOf,
    fade: fade,
    label: label,
    isEmpty: isEmpty,
    open: open,
    close: close,
    isOpen: function () { return !!cardId; },
  };
})();
