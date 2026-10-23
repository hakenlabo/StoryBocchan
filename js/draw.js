/*
 * AP.Draw：描画パネルと、線（strokes）の描画・サムネイル作成。
 *
 * 線のデータ：{ tool: 'pen'|'eraser', color, width, points: [[x, y, 筆圧], ...] }
 *   x, y は「絵の幅 = CONFIG.DRAW_BASE_W」の単位。高さは画面比で決まる（16:9なら 1000×562.5）。
 *   消しゴムも線として記録し、描くときに destination-out で消す（ベクターのまま部分消しができる）。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  // ------------------------------------------------------------
  // 線の描画（パネルとサムネイルで共通）
  // ------------------------------------------------------------
  function lineWidth(s, p, scale) {
    if (s.tool === 'eraser') return s.width * scale;
    const r = C.DRAW_MIN_PRESSURE_RATIO;
    return s.width * (r + (1 - r) * p) * scale;
  }

  function prepare(ctx, s) {
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color || '#000';
    ctx.fillStyle = s.color || '#000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // i 番目の点までの区間を1本描く（点と点の中点を通る2次曲線でなめらかに）
  function drawSegment(ctx, s, i, scale, isLast) {
    const pts = s.points;
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const m0 = i === 1 ? p0 : [(pts[i - 2][0] + p0[0]) / 2, (pts[i - 2][1] + p0[1]) / 2];
    const m1 = isLast ? p1 : [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    ctx.lineWidth = lineWidth(s, (p0[2] + p1[2]) / 2, scale);
    ctx.beginPath();
    ctx.moveTo(m0[0] * scale, m0[1] * scale);
    ctx.quadraticCurveTo(p0[0] * scale, p0[1] * scale, m1[0] * scale, m1[1] * scale);
    ctx.stroke();
  }

  function drawDot(ctx, s, scale) {
    const p = s.points[0];
    ctx.beginPath();
    ctx.arc(p[0] * scale, p[1] * scale, lineWidth(s, p[2], scale) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawStroke(ctx, s, scale) {
    if (!s.points.length) return;
    ctx.save();
    prepare(ctx, s);
    if (s.points.length === 1) drawDot(ctx, s, scale);
    for (let i = 1; i < s.points.length; i++) drawSegment(ctx, s, i, scale, i === s.points.length - 1);
    ctx.restore();
  }

  function drawStrokes(ctx, strokes, scale) {
    (strokes || []).forEach(function (s) { drawStroke(ctx, s, scale); });
  }

  // サムネイル（透明PNGのdata URL）。strokes配列と画面比が同じなら作り直さない
  const thumbCache = new WeakMap();
  function thumbURL(strokes, aspect) {
    if (!strokes || !strokes.length) return '';
    const hit = thumbCache.get(strokes);
    if (hit && hit.aspect === aspect) return hit.url;
    const w = C.DRAW_THUMB_W;
    const h = Math.round(w / U.aspectRatio(aspect));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    drawStrokes(cv.getContext('2d'), strokes, w / C.DRAW_BASE_W);
    const url = cv.toDataURL('image/png');
    thumbCache.set(strokes, { aspect: aspect, url: url });
    return url;
  }

  // ------------------------------------------------------------
  // パネル
  // ------------------------------------------------------------
  let panel, stage, canvas, ctx, titleEl, prevBtn, nextBtn, undoBtn, redoBtn;
  let cardId = null;
  let strokes = [];         // 編集中の線（確定のたびに新しい配列にして保存）
  let undoStack = [];
  let redoStack = [];
  let tool = 'pen';
  let color = C.DRAW_COLORS[0].value;
  let size = C.DRAW_SIZES[C.DRAW_DEFAULT_SIZE_INDEX].value;
  let scale = 1;            // 画面px / 絵の単位
  let cur = null;           // 描いている途中の線
  let penSeen = false;

  function isOpen() { return !!cardId; }

  function open(id) {
    const card = Store.get(id);
    if (!card) return;
    if (AP.MapView.isEditing()) AP.MapView.finishEdit();
    cardId = id;
    strokes = card.strokes || [];
    undoStack = [];
    redoStack = [];
    panel.hidden = false;
    document.body.classList.add('drawing');
    AP.MapView.select(id);
    updateTitle();
    layout();
    updateButtons();
  }

  function close() {
    if (!cardId) return;
    endStroke();
    cardId = null;
    panel.hidden = true;
    document.body.classList.remove('drawing');
  }

  function updateTitle() {
    const card = Store.get(cardId);
    const list = Store.timelineCards();
    const i = list.findIndex(function (c) { return c.id === cardId; });
    titleEl.textContent = (i >= 0 ? '#' + (i + 1) + '  ' : '') + (card.text || '（無題）');
    prevBtn.disabled = !(i > 0);
    nextBtn.disabled = !(i >= 0 && i < list.length - 1);
    prevBtn.title = nextBtn.title = i >= 0 ? 'タイムラインの前後のカードへ' : 'タイムラインに採用すると前後に移動できます';
  }

  function go(delta) {
    const list = Store.timelineCards();
    const i = list.findIndex(function (c) { return c.id === cardId; });
    const next = list[i + delta];
    if (i < 0 || !next) return;
    endStroke();
    open(next.id);
  }

  // キャンバスを画面比を保ったまま、置ける範囲いっぱいにする
  function layout() {
    if (!cardId) return;
    const ratio = U.aspectRatio(Store.settings().aspect);
    const r = stage.getBoundingClientRect();
    const pad = 16;
    let w = r.width - pad * 2;
    let h = w / ratio;
    if (h > r.height - pad * 2) { h = r.height - pad * 2; w = h * ratio; }
    w = Math.max(50, Math.floor(w));
    h = Math.max(30, Math.floor(h));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scale = w / C.DRAW_BASE_W;
    redraw();
  }

  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStrokes(ctx, strokes, scale);
    if (cur) drawStroke(ctx, cur, scale);
  }

  function commit(next) {
    undoStack.push(strokes);
    if (undoStack.length > C.DRAW_UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    strokes = next;
    Store.setStrokes(cardId, strokes);
    updateButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(strokes);
    strokes = undoStack.pop();
    Store.setStrokes(cardId, strokes);
    redraw();
    updateButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(strokes);
    strokes = redoStack.pop();
    Store.setStrokes(cardId, strokes);
    redraw();
    updateButtons();
  }

  function clearAll() {
    if (!strokes.length) return;
    commit([]);
    redraw();
    U.toast('全部消しました（取り消しで戻せます）');
  }

  function updateButtons() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    panel.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === tool); });
    panel.querySelectorAll('[data-color]').forEach(function (b) { b.classList.toggle('active', b.dataset.color === color); });
    panel.querySelectorAll('[data-size]').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.size) === size); });
  }

  // ---- 入力 ----
  function toPoint(e) {
    const r = canvas.getBoundingClientRect();
    let p = e.pointerType === 'pen' ? e.pressure : C.DRAW_NONPEN_PRESSURE;
    if (e.pointerType === 'pen' && !p) p = 0.5; // 筆圧0で届く端末向け
    return [
      Math.round((e.clientX - r.left) / scale * 10) / 10,
      Math.round((e.clientY - r.top) / scale * 10) / 10,
      Math.round(p * 100) / 100,
    ];
  }

  function onPointerDown(e) {
    if (e.pointerType === 'pen') penSeen = true;
    if (cur) return; // 2本目の指などは無視
    if (e.pointerType === 'touch' && penSeen && C.DRAW_PEN_ONLY_AFTER_PEN) return;
    if (e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    cur = {
      tool: tool,
      color: tool === 'eraser' ? null : color,
      width: tool === 'eraser' ? C.ERASER_SIZE : size,
      points: [toPoint(e)],
      pointerId: e.pointerId,
    };
    ctx.save();
    prepare(ctx, cur);
    drawDot(ctx, cur, scale);
    ctx.restore();
  }

  function addPoint(e) {
    const pt = toPoint(e);
    const last = cur.points[cur.points.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < C.DRAW_MIN_POINT_DIST) return;
    cur.points.push(pt);
    if (cur.points.length >= 2) {
      ctx.save();
      prepare(ctx, cur);
      drawSegment(ctx, cur, cur.points.length - 1, scale, false);
      ctx.restore();
    }
  }

  function onPointerMove(e) {
    if (!cur || e.pointerId !== cur.pointerId) return;
    // ペンは間引かれたイベントもまとめて拾う（なめらかさのため）
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) list.forEach(addPoint);
    else addPoint(e);
  }

  function endStroke() {
    if (!cur) return;
    const s = cur;
    cur = null;
    delete s.pointerId;
    if (s.tool === 'eraser' && !s.color) delete s.color;
    commit(strokes.concat([s]));
    redraw(); // 最後の区間まできれいに描き直す
  }

  function onPointerUp(e) {
    if (!cur || e.pointerId !== cur.pointerId) return;
    addPoint(e);
    endStroke();
  }

  function onKeyDown(e) {
    if (!cardId) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Escape' || (mod && e.key === 'Enter')) { e.preventDefault(); close(); }
    else if (!mod && e.key.toLowerCase() === 'b') { tool = 'pen'; updateButtons(); }
    else if (!mod && e.key.toLowerCase() === 'e') { tool = 'eraser'; updateButtons(); }
    else if (!mod && e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (!mod && e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    e.stopPropagation();
  }

  function buildToolbar() {
    const colors = document.getElementById('draw-colors');
    C.DRAW_COLORS.forEach(function (c) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.color = c.value;
      b.title = c.name;
      b.style.setProperty('--c', c.value);
      b.addEventListener('click', function () { color = c.value; tool = 'pen'; updateButtons(); });
      colors.appendChild(b);
    });
    const sizes = document.getElementById('draw-sizes');
    C.DRAW_SIZES.forEach(function (s) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'size';
      b.dataset.size = s.value;
      b.textContent = s.name;
      b.addEventListener('click', function () { size = s.value; tool = 'pen'; updateButtons(); });
      sizes.appendChild(b);
    });
    panel.querySelectorAll('[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () { tool = b.dataset.tool; updateButtons(); });
    });
  }

  function init() {
    panel = document.getElementById('draw-panel');
    stage = document.getElementById('draw-stage');
    canvas = document.getElementById('draw-canvas');
    ctx = canvas.getContext('2d');
    titleEl = document.getElementById('draw-title');
    prevBtn = document.getElementById('draw-prev');
    nextBtn = document.getElementById('draw-next');
    undoBtn = document.getElementById('draw-undo');
    redoBtn = document.getElementById('draw-redo');

    buildToolbar();
    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    document.getElementById('draw-clear').addEventListener('click', clearAll);
    document.getElementById('draw-close').addEventListener('click', close);
    prevBtn.addEventListener('click', function () { go(-1); });
    nextBtn.addEventListener('click', function () { go(1); });

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', layout);
    updateButtons();
  }

  AP.Draw = {
    init: init,
    open: open,
    close: close,
    isOpen: isOpen,
    drawStrokes: drawStrokes,
    thumbURL: thumbURL,
  };
})();
