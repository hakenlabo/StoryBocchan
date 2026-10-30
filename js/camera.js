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
 *   holdIn: コマ数, holdOut: コマ数,    止め：動き出すまで／止まってから（その間は始め／終わりの窓のまま）
 *   frames: { from: {cx, cy, z}, to: {cx, cy, z} } | null   T.U／T.B の始め・終わりの窓を手で決めたとき（null＝倍率と寄る位置から）
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
    return { move: 'none', dir: 'right', amount: null, focus: [0.5, 0.5], ease: 'linear', fi: 0, fo: 0, fadeColor: 'black',
      holdIn: 0, holdOut: 0, frames: null };
  }

  function isLong(paper) { return !!paper && (paper.w > 1 || paper.h > 1); }

  // 長い用紙のPANは「等倍で端から端へ」がふつうなので 1 倍も選べる
  function amountsFor(move, paper) {
    if (move === 'pan') return isLong(paper) ? [1].concat(C.CAM_PAN_AMOUNTS) : C.CAM_PAN_AMOUNTS;
    if (move === 'follow') return C.CAM_FOLLOW_AMOUNTS;
    if (move === 'tu' || move === 'tb') return C.CAM_ZOOM_AMOUNTS;
    return [];
  }

  function full(cam) { return Object.assign(defaults(), cam || {}); }

  function isEmpty(cam) {
    return !cam || ((!cam.move || cam.move === 'none') && !cam.fi && !cam.fo);
  }

  function amountOf(cam, paper) {
    if (cam.amount) return cam.amount;
    if (cam.move === 'pan' && isLong(paper)) return 1;
    const list = amountsFor(cam.move, paper);
    return list[Math.min(C.CAM_DEFAULT_AMOUNT_INDEX, list.length - 1)] || 1;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // カット内のコマ local（0始まり）→ 動きの進み具合 t（0〜1）。止めの間は 0（始め）／1（終わり）のまま
  function progress(cam, local, duration) {
    const c = full(cam);
    const hi = Math.max(0, c.holdIn || 0), ho = Math.max(0, c.holdOut || 0);
    const span = duration - 1 - hi - ho;
    if (span <= 0) return duration > 1 && local >= duration - ho ? 1 : (local > hi ? 1 : 0);
    return U.clamp((local - hi) / span, 0, 1);
  }

  // カット内の進み具合 t（0〜1）でのカメラの窓。
  // baseH＝画面の高さ（絵の座標）、paper＝用紙の倍率 {w, h}（省略すると画面と同じ）
  function view(cam, t, baseH, paper) {
    paper = paper || { w: 1, h: 1 };
    const FW = C.DRAW_BASE_W, FH = baseH;          // 画面（カメラの窓）の大きさ
    const PW = FW * paper.w, PH = FH * paper.h;    // 用紙の大きさ
    const c = full(cam);
    // 止まっているときの窓：寄る位置（focus）に合わせ、用紙からはみ出さない所。標準の用紙なら真ん中
    const home = function (z) {
      return {
        x: U.clamp(c.focus[0] * PW, FW / (2 * z), PW - FW / (2 * z)),
        y: U.clamp(c.focus[1] * PH, FH / (2 * z), PH - FH / (2 * z)),
      };
    };
    const h1 = home(1);
    const v = { z: 1, cx: h1.x, cy: h1.y, tile: null };
    if (!cam || !c.move || c.move === 'none') return v;
    const a = amountOf(c, paper);
    const e = c.ease === 'slow' ? (1 - Math.cos(Math.PI * t)) / 2 : t;
    const horiz = c.dir === 'left' || c.dir === 'right';

    if (c.move === 'pan') {
      v.z = a;
      const vw = FW / a, vh = FH / a;
      if (horiz) {
        v.cy = U.clamp(c.focus[1] * PH, vh / 2, PH - vh / 2);
        const from = vw / 2, to = PW - vw / 2;
        v.cx = c.dir === 'right' ? lerp(from, to, e) : lerp(to, from, e);
      } else {
        v.cx = U.clamp(c.focus[0] * PW, vw / 2, PW - vw / 2);
        const from = vh / 2, to = PH - vh / 2;
        v.cy = c.dir === 'down' ? lerp(from, to, e) : lerp(to, from, e);
      }
    } else if (c.move === 'follow') {
      // 背景が流れ続ける（用紙を並べて敷き詰める）。速さは均等（緩急をつけると止まって見えるため）
      // 動き出す側の端から始める（→なら用紙の左端）
      const dist = a * (horiz ? FW : FH) * t;
      if (c.dir === 'right') v.cx = FW / 2 + dist;
      else if (c.dir === 'left') v.cx = PW - FW / 2 - dist;
      else if (c.dir === 'down') v.cy = FH / 2 + dist;
      else v.cy = PH - FH / 2 - dist;
      v.tile = horiz ? 'x' : 'y';
    } else if ((c.move === 'tu' || c.move === 'tb') && c.frames) {
      // 手で決めた始め・終わりの窓のあいだ
      const f0 = c.frames.from, f1 = c.frames.to;
      v.z = lerp(f0.z, f1.z, e);
      v.cx = lerp(f0.cx, f1.cx, e);
      v.cy = lerp(f0.cy, f1.cy, e);
    } else if (c.move === 'tu' || c.move === 'tb') {
      const k = c.move === 'tu' ? e : 1 - e;  // 0＝引き、1＝寄り
      v.z = lerp(1, a, k);
      const target = home(a);
      v.cx = U.clamp(lerp(h1.x, target.x, k), FW / (2 * v.z), PW - FW / (2 * v.z));
      v.cy = U.clamp(lerp(h1.y, target.y, k), FH / (2 * v.z), PH - FH / (2 * v.z));
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
    // 動き・倍率・寄る位置を選び直したら、手で決めた枠はやめて選んだ値から作る
    if (('move' in patch || 'amount' in patch || 'focus' in patch) && !('frames' in patch)) next.frames = null;
    // 動きなしでも「映す位置」を決めていれば残す（長い用紙のため）
    const placed = next.focus[0] !== 0.5 || next.focus[1] !== 0.5;
    Store.setCamera(cardId, isEmpty(next) && !placed ? null : next);
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
    const paper = Store.source(card).paper;
    const list = Store.timelineCards(Store.sceneOf(card));
    const i = list.findIndex(function (x) { return x.id === cardId; });
    const no = Store.cutNoOf(cardId);
    titleEl.textContent = 'カメラワーク　' + (no ? '#' + no + '  ' : '') + (Store.source(card).text || '（無題）') +
      '　（尺 ' + U.framesToLabel(card.duration, fps) + '）';

    body.innerHTML = '';
    body.appendChild(seg('動き', MOVES, c.move, function (v) { save({ move: v }); }));
    if (c.move === 'pan' || c.move === 'follow') {
      body.appendChild(seg('向き', DIRS, c.dir, function (v) { save({ dir: v }); }));
    }
    if (c.move !== 'none') {
      const unit = c.move === 'follow' ? '画面' : '倍';
      body.appendChild(seg(c.move === 'follow' ? '流れる量' : (c.move === 'pan' ? '拡大' : '寄り'),
        amountsFor(c.move, paper).map(function (a) { return { id: a, label: (c.move === 'pan' && a === 1 ? '等倍（用紙の端から端へ）' : a + unit) }; }),
        (c.move === 'tu' || c.move === 'tb') && c.frames ? null : amountOf(c, paper), function (v) { save({ amount: v }); })); // 枠を手で決めたら、どれも選ばれていない表示に
    }
    if ((c.move === 'pan' || c.move === 'follow') && !isLong(paper)) {
      const hint = document.createElement('div');
      hint.className = 'cam-hint';
      hint.textContent = '長い背景を描くなら、描画パネルの「用紙」を横長（縦長）にしてください。' +
        (c.move === 'follow' ? '用紙の右端と左端がつながるように描くと、途切れずに流れます。' : '');
      body.appendChild(hint);
    }
    if (c.move === 'tu' || c.move === 'tb' || (c.move === 'none' && isLong(paper))) {
      // 寄る位置（3×3）。長い用紙で動きなしのときは、用紙のどこを映すか
      const row = document.createElement('div');
      row.className = 'cam-row';
      row.innerHTML = '<div class="cam-label">' + (c.move === 'none' ? '映す位置' : '寄る位置') + '</div>';
      const grid = document.createElement('div');
      grid.className = 'cam-grid';
      [0, 0.5, 1].forEach(function (fy) {
        [0, 0.5, 1].forEach(function (fx) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.v = fx + ',' + fy;
          if (c.focus[0] === fx && c.focus[1] === fy && !c.frames) b.classList.add('active');
          b.addEventListener('click', function () { save({ focus: [fx, fy] }); });
          grid.appendChild(b);
        });
      });
      row.appendChild(grid);
      body.appendChild(row);
    }
    if (c.move === 'tu' || c.move === 'tb') body.appendChild(frameEditorRow(c, card));
    if (c.move !== 'none') {
      // 止め：動き出すまで／止まってから
      const holdItems = [{ id: 0, label: 'なし' }].concat(C.CAM_HOLD_SECS.map(function (s) {
        const f = Math.max(1, Math.round(s * fps));
        return { id: f, label: U.framesToLabel(f, fps) };
      }));
      [c.holdIn, c.holdOut].forEach(function (f) {
        if (f && !holdItems.some(function (x) { return x.id === f; })) holdItems.push({ id: f, label: U.framesToLabel(f, fps) });
      });
      body.appendChild(seg('止め（始め）', holdItems, c.holdIn || 0, function (v) { save({ holdIn: v }); }));
      body.appendChild(seg('止め（終わり）', holdItems, c.holdOut || 0, function (v) { save({ holdOut: v }); }));
      const moveF = card.duration - (c.holdIn || 0) - (c.holdOut || 0);
      const note = document.createElement('div');
      note.className = 'cam-hint cam-hold-note' + (moveF < 2 ? ' warn' : '');
      note.textContent = moveF < 2
        ? '止めが尺より長いので、動く時間がありません（尺を長くするか、止めを短くしてください）'
        : (c.holdIn ? '止め ' + U.framesToLabel(c.holdIn, fps) + ' → ' : '') + '動き ' + U.framesToLabel(moveF, fps) +
          (c.holdOut ? ' → 止め ' + U.framesToLabel(c.holdOut, fps) : '') + '（尺 ' + U.framesToLabel(card.duration, fps) + '）';
      body.appendChild(note);
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

  // ------------------------------------------------------------
  // T.U／T.B の枠の調整：用紙全体の絵に「始め」「終わり」の窓を重ね、ドラッグで動かす・角で大きさを変える
  // ------------------------------------------------------------
  let fe = null; // { canvas, ctx, k（px／絵の単位）, PW, PH, FW, FH, from, to, drag }

  function frameEditorRow(c, card) {
    const st = Store.settings();
    const src = Store.source(card);
    const paper = src.paper || { w: 1, h: 1 };
    const FW = C.DRAW_BASE_W, FH = C.DRAW_BASE_W / U.aspectRatio(st.aspect);
    const PW = FW * paper.w, PH = FH * paper.h;
    const maxW = C.CAM_FRAME_EDITOR_W, maxH = C.CAM_FRAME_EDITOR_W * 0.75;
    const k = Math.min(maxW / PW, maxH / PH);
    const row = document.createElement('div');
    row.className = 'cam-row cam-frames-row';
    row.innerHTML = '<div class="cam-label">枠</div>' +
      '<div class="cam-frames"><canvas class="cam-frame-editor"></canvas>' +
      '<div class="cam-frames-note"><span class="from">■ 始め</span>　<span class="to">■ 終わり</span>　枠の中をドラッグで移動、角で大きさ' +
      ' <button type="button" class="cam-frames-reset">元に戻す</button></div></div>';
    const cv = row.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = Math.round(PW * k) + 'px';
    cv.style.height = Math.round(PH * k) + 'px';
    cv.width = Math.round(PW * k * dpr);
    cv.height = Math.round(PH * k * dpr);
    const v0 = view(c, 0, FH, paper), v1 = view(c, 1, FH, paper);
    fe = { canvas: cv, ctx: cv.getContext('2d'), k: k, dpr: dpr, PW: PW, PH: PH, FW: FW, FH: FH, src: src, paper: paper,
      from: { cx: v0.cx, cy: v0.cy, z: v0.z }, to: { cx: v1.cx, cy: v1.cy, z: v1.z }, drag: null };
    row.querySelector('.cam-frames-reset').disabled = !c.frames;
    row.querySelector('.cam-frames-reset').addEventListener('click', function () { save({ frames: null }); });
    cv.addEventListener('pointerdown', feDown);
    cv.addEventListener('pointermove', feMove);
    cv.addEventListener('pointerup', feUp);
    cv.addEventListener('pointercancel', feUp);
    drawFrameEditor();
    return row;
  }

  function feRect(f) {
    const w = fe.FW / f.z, h = fe.FH / f.z;
    return { x: f.cx - w / 2, y: f.cy - h / 2, w: w, h: h };
  }

  function drawFrameEditor() {
    if (!fe) return;
    const ctx = fe.ctx, k = fe.k * fe.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, fe.canvas.width, fe.canvas.height);
    if (fe.src.image) AP.Draw.drawImage(ctx, fe.src.image, fe.paper, Store.settings().aspect, k);
    ctx.drawImage(AP.Draw.strokesLayer(fe.src.strokes, fe.canvas.width, fe.canvas.height, k), 0, 0);
    // 枠の外を少し暗く（終わりの窓を基準に）
    [['from', '#1f9d55'], ['to', '#e8590c']].forEach(function (x) {
      const r = feRect(fe[x[0]]);
      ctx.lineWidth = 2 * fe.dpr;
      ctx.strokeStyle = x[1];
      ctx.setLineDash(x[0] === 'from' ? [6 * fe.dpr, 4 * fe.dpr] : []);
      ctx.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
      ctx.setLineDash([]);
      ctx.fillStyle = x[1];
      const hs = C.CAM_FRAME_HANDLE_PX * fe.dpr;
      [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].forEach(function (p) {
        ctx.fillRect(p[0] * k - hs / 2, p[1] * k - hs / 2, hs, hs);
      });
    });
  }

  function fePoint(e) {
    const r = fe.canvas.getBoundingClientRect();
    const s = r.width / fe.PW;
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s, s];
  }

  // つかんだ所：角＝大きさ（向かいの角を支点に）、中＝移動。終わりの枠を優先
  function feHit(p, pointerType) {
    const r0 = C.CAM_FRAME_HANDLE_PX * (pointerType === 'touch' || pointerType === 'pen' ? 1.8 : 1) / p[2];
    const order = ['to', 'from'];
    for (let n = 0; n < 2; n++) {
      const r = feRect(fe[order[n]]);
      const cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      for (let i = 0; i < 4; i++) {
        if (Math.abs(p[0] - cs[i][0]) <= r0 && Math.abs(p[1] - cs[i][1]) <= r0) return { which: order[n], mode: 'size', anchor: cs[(i + 2) % 4], corner: i };
      }
    }
    for (let n = 0; n < 2; n++) {
      const r = feRect(fe[order[n]]);
      if (p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h) return { which: order[n], mode: 'move' };
    }
    return null;
  }

  function clampFrame(f) {
    f.z = U.clamp(f.z, 1, C.CAM_FRAME_MAX_ZOOM); // 窓は画面（用紙の標準の大きさ）より大きくしない
    const w = fe.FW / f.z, h = fe.FH / f.z;
    f.cx = U.clamp(f.cx, Math.min(w / 2, fe.PW / 2), Math.max(fe.PW - w / 2, fe.PW / 2));
    f.cy = U.clamp(f.cy, Math.min(h / 2, fe.PH / 2), Math.max(fe.PH - h / 2, fe.PH / 2));
    return f;
  }

  function feDown(e) {
    const p = fePoint(e);
    const h = feHit(p, e.pointerType);
    if (!h) return;
    e.preventDefault();
    fe.canvas.setPointerCapture(e.pointerId);
    fe.drag = Object.assign({ pointerId: e.pointerId, start: p, orig: Object.assign({}, fe[h.which]) }, h);
    Store.checkpoint();
  }

  function feMove(e) {
    const p = fePoint(e);
    if (!fe.drag) {
      const h = feHit(p, e.pointerType);
      fe.canvas.style.cursor = !h ? '' : h.mode === 'move' ? 'move' : (h.corner % 2 ? 'nesw-resize' : 'nwse-resize');
      return;
    }
    if (e.pointerId !== fe.drag.pointerId) return;
    const d = fe.drag, f = fe[d.which];
    if (d.mode === 'move') {
      f.cx = d.orig.cx + p[0] - d.start[0];
      f.cy = d.orig.cy + p[1] - d.start[1];
    } else {
      // 画面の縦横比のまま。向かいの角を支点に
      const ratio = fe.FW / fe.FH;
      const w = Math.max(Math.abs(p[0] - d.anchor[0]), Math.abs(p[1] - d.anchor[1]) * ratio);
      f.z = U.clamp(fe.FW / Math.max(1, w), 1, C.CAM_FRAME_MAX_ZOOM);
      const ww = fe.FW / f.z, hh = fe.FH / f.z;
      const sx = d.corner === 1 || d.corner === 2 ? 1 : -1, sy = d.corner >= 2 ? 1 : -1;
      f.cx = d.anchor[0] + sx * ww / 2;
      f.cy = d.anchor[1] + sy * hh / 2;
    }
    clampFrame(f);
    Store.setCamera(cardId, Object.assign(cur(), { frames: { from: Object.assign({}, fe.from), to: Object.assign({}, fe.to) } }));
    drawFrameEditor();
  }

  function feUp(e) {
    if (!fe || !fe.drag || e.pointerId !== fe.drag.pointerId) return;
    fe.drag = null;
    Store.checkpoint();
    build(); // 「元に戻す」を押せるように
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
    progress: progress,
    rectOf: rectOf,
    fade: fade,
    label: label,
    isEmpty: isEmpty,
    isLong: isLong,
    open: open,
    close: close,
    isOpen: function () { return !!cardId; },
  };
})();
