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
  let minLinePx = 0; // サムネイルを作る間だけ、細い線が消えないよう最小の太さを決める

  function lineWidth(s, p, scale) {
    if (s.tool === 'eraser') return s.width * scale;
    const r = C.DRAW_MIN_PRESSURE_RATIO;
    return Math.max(minLinePx, s.width * (r + (1 - r) * p) * scale);
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

  // 透明なキャンバスに絵を描いて返す。白い紙などに直接描くと、消しゴム（destination-out）が
  // 下の紙ごと穴をあけてしまうので、絵の上に重ねるときは必ずこれを使う
  function strokesLayer(strokes, w, h, scale) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w));
    cv.height = Math.max(1, Math.ceil(h));
    drawStrokes(cv.getContext('2d'), strokes, scale);
    return cv;
  }

  // ------------------------------------------------------------
  // 写真・絵の画像（card.image = { src: data URL, w, h }）。線の下に敷く。消しゴムでは消えない
  // ------------------------------------------------------------
  const imgCache = new Map(); // src → { img, ok, p }
  function loadImage(src) {
    let e = imgCache.get(src);
    if (!e) {
      const img = new Image();
      e = { img: img, ok: false };
      e.p = new Promise(function (resolve) {
        img.onload = function () { e.ok = true; resolve(); document.dispatchEvent(new CustomEvent('ap:imageloaded')); };
        img.onerror = function () { resolve(); };
      });
      img.src = src;
      imgCache.set(src, e);
    }
    return e;
  }

  // 読み込み済みなら <img>、まだなら null（読み込めたら ap:imageloaded が来るので描き直す）
  function imageEl(image) {
    if (!image || !image.src || !image.w || !image.h) return null;
    const e = loadImage(image.src);
    return e.ok ? e.img : null;
  }

  // 画像を描く。ctx は用紙の左上が原点、scale は 画面px／絵の単位。用紙の中に縦横比を保って真ん中に収める
  function drawImage(ctx, image, paper, aspect, scale) {
    const img = imageEl(image);
    if (!img) return;
    paper = paper || { w: 1, h: 1 };
    const pw = C.DRAW_BASE_W * paper.w;
    const ph = (C.DRAW_BASE_W / U.aspectRatio(aspect)) * paper.h;
    const k = Math.min(pw / image.w, ph / image.h);
    const w = image.w * k, h = image.h * k;
    ctx.drawImage(img, (pw - w) / 2 * scale, (ph - h) / 2 * scale, w * scale, h * scale);
  }

  // 書き出し（PDF・MP4・zip）の前に、すべての画像を読み込んでおく
  function imagesReady() {
    return Promise.all(Store.cards().filter(function (c) { return c.image && c.image.src; })
      .map(function (c) { return loadImage(c.image.src).p; }));
  }

  // ファイル → { src, w, h }（長い辺を IMAGE_MAX_PX までに縮めて JPEG に。透明な所は白）
  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const k = Math.min(1, C.IMAGE_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k));
        const h = Math.max(1, Math.round(img.naturalHeight * k));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const c2 = cv.getContext('2d');
        c2.fillStyle = '#fff';
        c2.fillRect(0, 0, w, h);
        c2.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ src: cv.toDataURL('image/jpeg', C.IMAGE_JPEG_QUALITY), w: w, h: h });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした：' + file.name)); };
      img.src = url;
    });
  }

  // サムネイル（透明PNGのdata URL）。画面比の枠に用紙全体を収める。strokes配列・画面比・用紙・画像が同じなら作り直さない
  const thumbCache = new WeakMap();
  function thumbURL(strokes, aspect, paper, image) {
    const hasImg = !!(image && image.src);
    if ((!strokes || !strokes.length) && !hasImg) return '';
    strokes = strokes || [];
    if (hasImg && !imageEl(image)) return ''; // 画像の読み込み待ち（済んだら描き直される）
    paper = paper || { w: 1, h: 1 };
    const tag = aspect + '|' + paper.w + 'x' + paper.h + '|' + (hasImg ? image.src.length + image.src.slice(-24) : '');
    const hit = thumbCache.get(strokes);
    if (hit && hit.tag === tag) return hit.url;
    const w = C.DRAW_THUMB_W;
    const h = Math.round(w / U.aspectRatio(aspect));
    const pw = C.DRAW_BASE_W * paper.w;
    const ph = (C.DRAW_BASE_W / U.aspectRatio(aspect)) * paper.h;
    const s = Math.min(w / pw, h / ph);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c2 = cv.getContext('2d');
    const ox = (w - pw * s) / 2, oy = (h - ph * s) / 2;
    if (hasImg) { c2.translate(ox, oy); drawImage(c2, image, paper, aspect, s); c2.setTransform(1, 0, 0, 1, 0, 0); }
    // 線は透明な層に描いてから重ねる（消しゴムが画像に穴をあけないように）
    const lay = document.createElement('canvas');
    lay.width = w;
    lay.height = h;
    const lc = lay.getContext('2d');
    lc.translate(ox, oy);
    minLinePx = C.THUMB_MIN_LINE_PX;
    try { drawStrokes(lc, strokes, s); } finally { minLinePx = 0; }
    c2.drawImage(lay, 0, 0);
    const url = cv.toDataURL('image/png');
    thumbCache.set(strokes, { tag: tag, url: url });
    return url;
  }

  // ------------------------------------------------------------
  // パネル
  // ------------------------------------------------------------
  let panel, stage, canvas, ctx, titleEl, prevBtn, nextBtn, undoBtn, redoBtn;
  let cardId = null;        // 開いているカット（連動カットならそのid。前後移動の基準）
  let drawId = null;        // 絵を書き込むカード（連動カットなら元のカード）
  let strokes = [];         // 編集中の線（確定のたびに新しい配列にして保存）
  let undoStack = [];
  let redoStack = [];
  let tool = 'pen';
  let color = C.DRAW_COLORS[0].value;
  let size = C.DRAW_SIZES[C.DRAW_DEFAULT_SIZE_INDEX].value;
  let scale = 1;            // 画面px / 絵の単位
  let cur = null;           // 描いている途中の線
  let sel = null;           // 投げ縄で選んだ線 { idx: [線の番号], box: {x0,y0,x1,y1}（選んだときの範囲）, m: 変換 }
  let lasso = null;         // 囲んでいる途中 { pointerId, pts }
  let xf = null;            // 選んだ線を動かしている途中 { pointerId, mode: move|scale|rotate, start, m0, anchor }
  let penSeen = false;
  let lastPointer = null;   // 診断表示（?debug=1）用
  const DEBUG = /[?&]debug=1/.test(location.search);
  function dlog() { if (DEBUG) console.log('[draw] ' + Array.prototype.join.call(arguments, ' ')); }

  function isOpen() { return !!cardId; }

  function open(id) {
    const card = Store.get(id);
    if (!card) return;
    if (AP.MapView.isEditing()) AP.MapView.finishEdit();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // キーボードを閉じてから
    resetScroll();
    dlog('open', id, 'was', cardId);
    cardId = id;
    drawId = Store.source(card).id;
    strokes = Store.get(drawId).strokes || [];
    sel = null;
    undoStack = [];
    redoStack = [];
    panel.hidden = false;
    fitPanel();
    document.body.classList.add('drawing');
    AP.MapView.select(drawId);
    updateTitle();
    updatePaperSelect();
    fillNotes();
    layout();
    updateButtons();
  }

  // ---- 内容（カードの文字）・セリフ／メモ ----
  // 連動カットでも元のカード（drawId）に書く（絵と同じく共通）
  function fillNotes() {
    const src = Store.get(drawId);
    document.getElementById('draw-text').value = src.text || '';
    document.getElementById('draw-note').value = src.note || '';
  }

  function paperOf() { return (drawId && Store.get(drawId).paper) || { w: 1, h: 1 }; }

  function updatePaperSelect() {
    const sel = document.getElementById('draw-paper');
    const p = paperOf();
    const i = C.DRAW_PAPERS.findIndex(function (x) { return x.w === p.w && x.h === p.h; });
    sel.value = String(i >= 0 ? i : 0);
  }

  function setPaper(i) {
    const p = C.DRAW_PAPERS[i];
    if (!p || !drawId) return;
    const before = paperOf();
    Store.setPaper(drawId, p);
    layout();
    if (p.w < before.w || p.h < before.h) U.toast('用紙を小さくしました。はみ出た線は消えずに残っています（大きくすると見えます）');
  }

  function close() {
    dlog('close', cardId, new Error().stack.split('\n').slice(1, 4).join(' | '));
    if (!cardId) return;
    endStroke();
    sel = lasso = xf = null;
    cardId = null;
    panel.hidden = true;
    document.body.classList.remove('drawing');
    resetScroll();
  }

  // iPad Safari：キーボードの出し入れでページが少しずれたまま残り、ペンの位置と線がずれることがあるので、元に戻す
  function resetScroll() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  // パネルの高さは実際の表示の高さに合わせる（iPad の CSS の画面単位はキーボードやバーで食い違うことがある）
  function fitPanel() {
    panel.style.height = window.innerHeight + 'px';
    panel.style.width = window.innerWidth + 'px';
  }

  function onViewportChange() {
    if (!cardId) return;
    const a = document.activeElement;
    const typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT');
    if (!typing) { resetScroll(); fitPanel(); }
    layout();
  }

  function updateTitle() {
    const card = Store.get(cardId);
    const list = Store.timelineCards(Store.sceneOf(card)); // 前後移動は同じシーンの中で
    const i = list.findIndex(function (c) { return c.id === cardId; });
    const no = Store.cutNoOf(cardId);
    titleEl.textContent = (no ? '#' + no + '  ' : '') + (card.linkOf ? '🔗 ' : '') + (Store.source(card).text || '（無題）');
    prevBtn.disabled = !(i > 0);
    nextBtn.disabled = !(i >= 0 && i < list.length - 1);
    prevBtn.title = nextBtn.title = i >= 0 ? 'タイムラインの前後のカードへ' : 'タイムラインに採用すると前後に移動できます';
  }

  function go(delta) {
    const list = Store.timelineCards(Store.sceneOf(cardId));
    const i = list.findIndex(function (c) { return c.id === cardId; });
    const next = list[i + delta];
    if (i < 0 || !next) return;
    endStroke();
    open(next.id);
  }

  // キャンバスを画面比を保ったまま、置ける範囲いっぱいにする
  function layout() {
    if (!cardId) return;
    const paper = paperOf();
    const ratio = U.aspectRatio(Store.settings().aspect) * paper.w / paper.h; // 用紙の縦横比
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
    scale = w / (C.DRAW_BASE_W * paper.w);
    updateImage();
    redraw();
    renderCamFrames();
  }

  // 敷いた画像はキャンバスの背景に出す（線はキャンバスに描くので、消しゴムで消えるのは線だけ）
  function updateImage() {
    const im = drawId && Store.get(drawId) && Store.get(drawId).image;
    canvas.style.backgroundImage = im && im.src ? 'url("' + im.src + '")' : '';
    document.getElementById('draw-image-clear').hidden = !(im && im.src);
  }

  // カメラワークの「始め」「終わり」の枠を重ねて見せる（どこが映るか分かるように）
  function renderCamFrames() {
    const box = document.getElementById('draw-camframes');
    box.innerHTML = '';
    const card = cardId && Store.get(cardId);
    const cam = card && card.camera;
    const paper = paperOf();
    const moving = cam && cam.move && cam.move !== 'none';
    // 動きがなくても、長い用紙なら「画面」に映る範囲を出す
    if (!moving && !AP.Camera.isLong(paper)) return;
    const baseH = C.DRAW_BASE_W / U.aspectRatio(Store.settings().aspect);
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const frames = moving ? [['始め', 0, 'from'], ['終わり', 1, 'to']] : [['画面', 0, 'from']];
    frames.forEach(function (f) {
      const r = AP.Camera.rectOf(AP.Camera.view(cam, f[1], baseH, paper), baseH);
      const el = document.createElement('div');
      el.className = 'cam-frame ' + f[2];
      el.style.left = (cr.left - sr.left + r.x * scale) + 'px';
      el.style.top = (cr.top - sr.top + r.y * scale) + 'px';
      el.style.width = (r.w * scale) + 'px';
      el.style.height = (r.h * scale) + 'px';
      el.innerHTML = '<span>' + f[0] + '</span>';
      box.appendChild(el);
    });
    const tag = document.createElement('div');
    tag.className = 'cam-tag';
    tag.textContent = moving ? '🎥 ' + AP.Camera.label(cam) : '用紙 ' + paper.w + '×' + paper.h + '（枠が画面に映る範囲）';
    tag.style.right = (sr.right - cr.right + 6) + 'px';
    tag.style.top = (cr.top - sr.top + 6) + 'px';
    box.appendChild(tag);
  }

  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStrokes(ctx, viewStrokes(), scale);
    if (cur) drawStroke(ctx, cur, scale);
    drawLassoOverlay();
  }

  // ------------------------------------------------------------
  // 投げ縄：囲んだ線を選び、移動・拡大縮小・回転する（線のデータを変換して描き直す。画像は動かない）
  // 変換 m は [a, b, c, d, e, f]（x' = a x + c y + e、y' = b x + d y + f）。絵の単位で持つ
  // ------------------------------------------------------------
  const IDENT = [1, 0, 0, 1, 0, 0];
  function mul(p, q) { // q をしてから p
    return [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
      p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
      p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
  }
  function xform(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function around(x, y, m) { return mul([1, 0, 0, 1, x, y], mul(m, [1, 0, 0, 1, -x, -y])); }
  function isIdent(m) { return m.every(function (v, i) { return Math.abs(v - IDENT[i]) < 1e-9; }); }
  function r1(v) { return Math.round(v * 10) / 10; }

  function transformStroke(s, m) {
    const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    return Object.assign({}, s, {
      width: r1(s.width * k),
      points: s.points.map(function (p) { const q = xform(m, p[0], p[1]); return [r1(q[0]), r1(q[1]), p[2]]; }),
    });
  }

  // 選んだ線を変換中なら、その見た目の線の配列
  function viewStrokes() {
    if (!sel || isIdent(sel.m)) return strokes;
    const set = new Set(sel.idx);
    return strokes.map(function (s, i) { return set.has(i) ? transformStroke(s, sel.m) : s; });
  }

  function inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function boxOf(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    list.forEach(function (s) {
      const h = s.width / 2;
      s.points.forEach(function (p) {
        x0 = Math.min(x0, p[0] - h); y0 = Math.min(y0, p[1] - h);
        x1 = Math.max(x1, p[0] + h); y1 = Math.max(y1, p[1] + h);
      });
    });
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  // 囲みの中に点が半分以上ある線を選ぶ（消しゴムの線も一緒に動かす。消した所がずれないように）
  function selectByLasso(poly) {
    const idx = [];
    if (poly.length >= 3) {
      strokes.forEach(function (s, i) {
        const n = s.points.filter(function (p) { return inPoly(poly, p[0], p[1]); }).length;
        if (n && n >= s.points.length / 2) idx.push(i);
      });
    }
    const pens = idx.filter(function (i) { return strokes[i].tool !== 'eraser'; });
    sel = pens.length ? { idx: idx, box: boxOf(pens.map(function (i) { return strokes[i]; })), m: IDENT } : null;
  }

  function selCorners() {
    const b = sel.box;
    return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(function (p) { return xform(sel.m, p[0], p[1]); });
  }

  function rotHandle(c) {
    const top = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
    const mid = [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2];
    let dx = top[0] - mid[0], dy = top[1] - mid[1];
    const len = Math.hypot(dx, dy) || 1;
    const off = C.LASSO_ROTATE_OFFSET_PX / scale;
    return { top: top, mid: mid, p: [top[0] + dx / len * off, top[1] + dy / len * off] };
  }

  // つかんだ所：角＝拡大縮小（向かいの角を支点に）、上の丸＝回転、枠の中＝移動
  function handleAt(pt, pointerType) {
    const r = C.LASSO_HANDLE_PX * (pointerType === 'touch' || pointerType === 'pen' ? 1.8 : 1.2) / scale;
    const c = selCorners();
    const rh = rotHandle(c);
    if (Math.hypot(pt[0] - rh.p[0], pt[1] - rh.p[1]) <= r) return { mode: 'rotate', anchor: rh.mid };
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(pt[0] - c[i][0], pt[1] - c[i][1]) <= r) return { mode: 'scale', anchor: c[(i + 2) % 4] };
    }
    const q = xform(invert(sel.m), pt[0], pt[1]);
    const b = sel.box;
    if (q[0] >= b.x0 && q[0] <= b.x1 && q[1] >= b.y0 && q[1] <= b.y1) return { mode: 'move' };
    return null;
  }

  function updateTransform(p, snap) {
    const s = xf.start;
    if (xf.mode === 'move') {
      sel.m = mul([1, 0, 0, 1, p[0] - s[0], p[1] - s[1]], xf.m0);
    } else if (xf.mode === 'scale') {
      const a = xf.anchor;
      const k = Math.max(0.05, Math.hypot(p[0] - a[0], p[1] - a[1]) / Math.max(1, Math.hypot(s[0] - a[0], s[1] - a[1])));
      sel.m = mul(around(a[0], a[1], [k, 0, 0, k, 0, 0]), xf.m0);
    } else if (xf.mode === 'rotate') {
      const a = xf.anchor;
      let t = Math.atan2(p[1] - a[1], p[0] - a[0]) - Math.atan2(s[1] - a[1], s[0] - a[0]);
      if (snap) t = Math.round(t / (Math.PI / 12)) * (Math.PI / 12); // Shift：15度ずつ
      sel.m = mul(around(a[0], a[1], [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0]), xf.m0);
    }
  }

  // 変換を線のデータに書き込む（取り消しできる）。選んだままにして、続けて動かせるようにする
  function commitSelection() {
    if (!sel || isIdent(sel.m)) return;
    const set = new Set(sel.idx);
    const m = sel.m;
    commit(strokes.map(function (s, i) { return set.has(i) ? transformStroke(s, m) : s; }));
    const pens = sel.idx.filter(function (i) { return strokes[i].tool !== 'eraser'; });
    sel = { idx: sel.idx, box: boxOf(pens.map(function (i) { return strokes[i]; })), m: IDENT };
  }

  function deleteSelection() {
    if (!sel) return;
    const set = new Set(sel.idx);
    sel = null;
    commit(strokes.filter(function (s, i) { return !set.has(i); }));
    redraw();
  }

  function drawLassoOverlay() {
    const k = scale;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.5;
    if (lasso && lasso.pts.length > 1) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#2f6fde';
      ctx.beginPath();
      lasso.pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0] * k, p[1] * k); else ctx.moveTo(p[0] * k, p[1] * k); });
      ctx.stroke();
    }
    if (sel) {
      const c = selCorners();
      const rh = rotHandle(c);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#2f6fde';
      ctx.beginPath();
      c.forEach(function (p, i) { if (i) ctx.lineTo(p[0] * k, p[1] * k); else ctx.moveTo(p[0] * k, p[1] * k); });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(rh.top[0] * k, rh.top[1] * k);
      ctx.lineTo(rh.p[0] * k, rh.p[1] * k);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      const hs = C.LASSO_HANDLE_PX;
      c.forEach(function (p) { ctx.fillRect(p[0] * k - hs / 2, p[1] * k - hs / 2, hs, hs); ctx.strokeRect(p[0] * k - hs / 2, p[1] * k - hs / 2, hs, hs); });
      ctx.beginPath();
      ctx.arc(rh.p[0] * k, rh.p[1] * k, hs / 2 + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function commit(next) {
    undoStack.push(strokes);
    if (undoStack.length > C.DRAW_UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    strokes = next;
    Store.setStrokes(drawId, strokes);
    updateButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    sel = null;
    redoStack.push(strokes);
    strokes = undoStack.pop();
    Store.setStrokes(drawId, strokes);
    redraw();
    updateButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    sel = null;
    undoStack.push(strokes);
    strokes = redoStack.pop();
    Store.setStrokes(drawId, strokes);
    redraw();
    updateButtons();
  }

  function clearAll() {
    if (!strokes.length) return;
    sel = null;
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
    // いま実際に表示されている大きさから計算する（表示が変わった直後でもペンの位置どおりになるように）
    const r = canvas.getBoundingClientRect();
    const k = r.width / (C.DRAW_BASE_W * paperOf().w) || scale;
    let p = e.pointerType === 'pen' ? e.pressure : C.DRAW_NONPEN_PRESSURE;
    if (e.pointerType === 'pen' && !p) p = 0.5; // 筆圧0で届く端末向け
    lastPointer = { type: e.pointerType, x: Math.round(e.clientX), y: Math.round(e.clientY), p: p,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    return [
      Math.round((e.clientX - r.left) / k * 10) / 10,
      Math.round((e.clientY - r.top) / k * 10) / 10,
      Math.round(p * 100) / 100,
    ];
  }

  function onPointerDown(e) {
    dlog('down', e.pointerId, e.pointerType, 'cur', cur ? cur.pointerId : 'none');
    if (e.pointerType === 'pen') penSeen = true;
    if (cur || lasso || xf) return; // 2本目の指などは無視
    if (e.pointerType === 'touch' && penSeen && C.DRAW_PEN_ONLY_AFTER_PEN) return;
    // ペンのサイドボタン（右クリック扱い＝button 2）・消しゴム側（button 5）は、押している間だけ消しゴム。
    // マウスの右ボタン・中ボタンでは描かない
    const penEraser = e.pointerType === 'pen' && (e.button === 2 || e.button === 5 || (e.buttons & 32) || (e.buttons & 2));
    if (e.button > 0 && !penEraser) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'lasso' && !penEraser) {
      const pt = toPoint(e);
      const h = sel && handleAt(pt, e.pointerType);
      if (h) xf = Object.assign({ pointerId: e.pointerId, start: pt, m0: sel.m.slice() }, h);
      else { sel = null; lasso = { pointerId: e.pointerId, pts: [pt] }; }
      redraw();
      return;
    }
    const t = penEraser ? 'eraser' : tool;
    cur = {
      tool: t,
      color: t === 'eraser' ? null : color,
      width: t === 'eraser' ? C.ERASER_SIZE : size,
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
    // Mac のトラックパッドなどで、ボタンを離したのに pointerup が届かないことがある。
    // ボタンが押されていないマウスの動きが来たら、そこで終える（離したあとも描き続けないように）
    if (e.pointerType === 'mouse' && e.buttons === 0 && (cur || lasso || xf)) { finishPointer(e, true); return; }
    if (tool === 'lasso' && !cur && !lasso && !xf) {
      const h = sel && handleAt(toPoint(e), e.pointerType);
      canvas.style.cursor = !h ? 'crosshair' : h.mode === 'move' ? 'move' : h.mode === 'rotate' ? 'grab' : 'nwse-resize';
    } else if (!cur && !lasso && !xf) canvas.style.cursor = '';
    if (lasso && e.pointerId === lasso.pointerId) {
      const pt = toPoint(e);
      const last = lasso.pts[lasso.pts.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= C.DRAW_MIN_POINT_DIST) { lasso.pts.push(pt); redraw(); }
      return;
    }
    if (xf && e.pointerId === xf.pointerId) { updateTransform(toPoint(e), e.shiftKey); redraw(); return; }
    if (!cur || e.pointerId !== cur.pointerId) return;
    // ペンは間引かれたイベントもまとめて拾う（なめらかさのため）
    // iPad の WebKit は古い位置が後から混ざることがあるので、前の点より新しいものだけを使う（線が折り返さないように）
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const evs = list && list.length ? list : [e];
    evs.forEach(function (ce) {
      if (ce.timeStamp && cur.lastT && ce.timeStamp <= cur.lastT) return;
      cur.lastT = ce.timeStamp || cur.lastT;
      addPoint(ce);
    });
  }

  function endStroke() {
    dlog('endStroke', cur ? cur.points.length + 'pts' : 'none');
    if (!cur) return;
    const s = cur;
    cur = null;
    delete s.pointerId;
    delete s.lastT;
    if (s.tool === 'eraser' && !s.color) delete s.color;
    commit(strokes.concat([s]));
    redraw(); // 最後の区間まできれいに描き直す
  }

  function onPointerUp(e) {
    dlog(e.type, e.pointerId, 'cur', cur ? cur.pointerId + '/' + cur.points.length : 'none', 'card', cardId);
    finishPointer(e, e.type !== 'pointerup'); // pointercancel などの位置は当てにならないので足さない
  }

  // 線・投げ縄・変換を終える。noPoint＝最後の位置を足さない
  function finishPointer(e, noPoint) {
    if (lasso && e.pointerId === lasso.pointerId) {
      selectByLasso(lasso.pts);
      lasso = null;
      redraw();
      return;
    }
    if (xf && e.pointerId === xf.pointerId) {
      xf = null;
      commitSelection();
      redraw();
      return;
    }
    if (!cur || e.pointerId !== cur.pointerId) return;
    if (!noPoint) addPoint(e);
    endStroke();
  }

  function onKeyDown(e) {
    if (!cardId || AP.Camera.isOpen()) return; // カメラ設定を開いている間はそちらが受ける
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      // 内容・セリフ欄で入力中：ふつうの文字入力。Escだけは欄から抜ける
      if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      e.stopPropagation();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Escape' && sel) { e.preventDefault(); sel = null; redraw(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSelection(); }
    else if (e.key === 'Escape' || (mod && e.key === 'Enter')) { e.preventDefault(); close(); }
    else if (!mod && e.key.toLowerCase() === 'b') setTool('pen');
    else if (!mod && e.key.toLowerCase() === 'e') setTool('eraser');
    else if (!mod && e.key.toLowerCase() === 'l') setTool('lasso');
    else if (!mod && e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (!mod && e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    e.stopPropagation();
  }

  function setTool(t) {
    tool = t;
    if (t !== 'lasso') { sel = null; lasso = null; }
    canvas.style.cursor = '';
    redraw();
    updateButtons();
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
      b.addEventListener('click', function () { color = c.value; setTool('pen'); });
      colors.appendChild(b);
    });
    const sizes = document.getElementById('draw-sizes');
    C.DRAW_SIZES.forEach(function (s) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'size';
      b.dataset.size = s.value;
      b.textContent = s.name;
      b.addEventListener('click', function () { size = s.value; setTool('pen'); });
      sizes.appendChild(b);
    });
    panel.querySelectorAll('[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () { setTool(b.dataset.tool); });
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
    ['text', 'note'].forEach(function (k) {
      const ta = document.getElementById('draw-' + k);
      ta.addEventListener('input', function () {
        if (!drawId) return;
        const patch = {};
        patch[k] = ta.value;
        Store.updateCard(drawId, patch);
        if (k === 'text') updateTitle();
      });
    });
    document.getElementById('draw-camera').addEventListener('click', function () { if (cardId) AP.Camera.open(cardId); });
    Store.subscribe(function (reason) {
      if (cardId && (reason === 'camera' || reason === 'settings')) renderCamFrames();
      if (cardId && (reason === 'image' || reason === 'history')) updateImage();
    });
    const paperSel = document.getElementById('draw-paper');
    C.DRAW_PAPERS.forEach(function (p, i) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name;
      paperSel.appendChild(o);
    });
    paperSel.addEventListener('change', function () { setPaper(Number(paperSel.value)); });
    document.getElementById('draw-copy').addEventListener('click', function () { AP.Clipboard.copyButton(); });
    document.getElementById('draw-paste').addEventListener('click', function () { AP.Clipboard.pasteButton(); });
    document.getElementById('draw-close').addEventListener('click', close);
    prevBtn.addEventListener('click', function () { go(-1); });
    nextBtn.addEventListener('click', function () { go(1); });

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('lostpointercapture', function (e) { finishPointer(e, true); });
    // キャンバスの外で離したときの念のため
    window.addEventListener('pointerup', function (e) { if (cardId) finishPointer(e, true); });
    window.addEventListener('blur', function () { if (cur) endStroke(); lasso = xf = null; });
    // iPad：キャンバスの上では、長押しメニュー・虫めがね・スクリブル（手書き入力）・クリックなどの標準の動きを止めて、描くだけにする。
    // （Pointer Events はそのまま届く）
    ['touchstart', 'touchmove', 'touchend'].forEach(function (t) {
      canvas.addEventListener(t, function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
    });
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('dragstart', function (e) { e.preventDefault(); });
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewportChange);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);
    // 内容・セリフ欄を離れたら（キーボードが閉じたら）ずれを戻して描き直す
    panel.addEventListener('focusout', function () { setTimeout(onViewportChange, 120); });
    updateButtons();
  }

  AP.Draw = {
    init: init,
    currentStrokes: function () { return cardId ? strokes : []; },
    // 描画パネルで絵を書き込んでいるカード（連動カットなら元のカード）。閉じていれば null
    editingCardId: function () { return cardId ? drawId : null; },
    debugInfo: function () {
      if (!cardId) return '';
      const r = canvas.getBoundingClientRect(), pr = panel.getBoundingClientRect();
      return 'draw panel ' + Math.round(pr.width) + 'x' + Math.round(pr.height) + '@' + Math.round(pr.top) +
        '  canvas ' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top) +
        (lastPointer ? '\npointer ' + lastPointer.type + ' ' + lastPointer.x + ',' + lastPointer.y + ' p' + lastPointer.p.toFixed(2) : '') +
        '\nstrokes ' + strokes.length + (cur ? '  drawing#' + cur.pointerId + ' ' + cur.points.length + 'pts' : '') +
        (strokes.length ? '  last ' + strokes[strokes.length - 1].points.length + 'pts' : '');
    },
    // ほかのカードからコピーした絵を重ねる（取り消し可）
    pasteStrokes: function (list) {
      if (!cardId) return;
      sel = null;
      commit(strokes.concat(JSON.parse(JSON.stringify(list))));
      redraw();
    },
    open: open,
    close: close,
    isOpen: isOpen,
    drawStrokes: drawStrokes,
    strokesLayer: strokesLayer,
    thumbURL: thumbURL,
    drawImage: drawImage,
    imagesReady: imagesReady,
    readImageFile: readImageFile,
  };
})();
