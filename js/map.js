/*
 * AP.MapView：マップキャンバス。
 * - #map-viewport がポインター入力をすべて受け、カード操作か背景操作（パン・ピンチ・ダブルタップ）かを振り分ける。
 * - #map-world に transform でパン・ズームをかける。カードの座標はワールド座標（card.mapPos）。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let vp, world, linesSvg, cardsLayer, zoomLabel;
  const view = { x: 0, y: 0, z: 1 };
  const els = new Map();      // cardId -> 要素
  const heights = new Map();  // cardId -> 実測の高さ（ワールドpx）

  let selectedId = null;
  let multi = [];           // 複数選択（選んだ順）。2枚以上のときだけ意味を持つ
  let multiMode = false;    // iPad用：タップで選択に足していくモード
  let editingId = null;
  let newCardId = null;       // 作った直後のカード（空のまま確定したら消すため）
  let dropTargetId = null;

  let drag = null;            // カードのドラッグ状態
  const bgPointers = new Map();
  let bg = null;              // 背景のパン／ピンチ状態
  let lastBgTap = null;
  let lastCardTap = null;
  let safariGesture = null;

  // ------------------------------------------------------------
  // 座標・ビュー
  // ------------------------------------------------------------
  function applyView() {
    world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.z + ')';
    if (zoomLabel) zoomLabel.textContent = Math.round(view.z * 100) + '%';
    // 背景の点をワールドのグリッドに合わせる（吸着の目と一致させる）
    const g = C.GRID_SIZE * view.z;
    vp.classList.toggle('no-grid', g < C.GRID_MIN_SCREEN_PX);
    vp.style.backgroundSize = g + 'px ' + g + 'px';
    vp.style.backgroundPosition = (view.x - g / 2) + 'px ' + (view.y - g / 2) + 'px';
  }

  function snapOn() { return !!Store.settings().mapSnap; }
  function snap(v) { return Math.round(v / C.GRID_SIZE) * C.GRID_SIZE; }

  function clientToWorld(cx, cy) {
    const r = vp.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
  }

  function zoomAt(cx, cy, z) {
    const w = clientToWorld(cx, cy);
    const r = vp.getBoundingClientRect();
    view.z = U.clamp(z, C.ZOOM_MIN, C.ZOOM_MAX);
    view.x = cx - r.left - w.x * view.z;
    view.y = cy - r.top - w.y * view.z;
    applyView();
  }

  function cardH(id) { return heights.get(id) || C.CARD_H_ESTIMATE; }

  function dragThreshold(pointerType) {
    return pointerType === 'touch' ? C.DRAG_THRESHOLD_TOUCH_PX : C.DRAG_THRESHOLD_MOUSE_PX;
  }

  function fit() {
    const r = vp.getBoundingClientRect();
    const act = Store.activeCards();
    if (!act.length) {
      view.x = r.width / 2; view.y = r.height / 2; view.z = 1;
      return applyView();
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    act.forEach(function (c) {
      x0 = Math.min(x0, c.mapPos.x); y0 = Math.min(y0, c.mapPos.y);
      x1 = Math.max(x1, c.mapPos.x + C.CARD_W); y1 = Math.max(y1, c.mapPos.y + cardH(c.id));
    });
    const pad = C.FIT_PADDING_PX;
    const z = Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0));
    view.z = U.clamp(Math.min(z, 1), C.ZOOM_MIN, C.ZOOM_MAX);
    view.x = r.width / 2 - ((x0 + x1) / 2) * view.z;
    view.y = r.height / 2 - ((y0 + y1) / 2) * view.z;
    applyView();
  }

  // ------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------
  function createCardEl(c) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = c.id;
    el.innerHTML =
      '<div class="card-thumb"><span class="card-badge"></span></div>' +
      '<div class="card-text"></div>' +
      '<button class="card-peel" type="button" title="保留トレイへ（Delete）">剥がす</button>';
    el.querySelector('.card-peel').addEventListener('click', function (e) {
      e.stopPropagation();
      peel(c.id);
    });
    return el;
  }

  function render() {
    const active = Store.activeCards();
    const ratio = U.aspectRatio(Store.settings().aspect);
    const fps = Store.settings().fps;
    const seen = new Set();
    const tlIndex = new Map();
    Store.timelineCards().forEach(function (c, i) {
      const id = c.linkOf || c.id; // 連動カットは元のカードに番号を足す
      if (!tlIndex.has(id)) tlIndex.set(id, []);
      tlIndex.get(id).push(i);
    });

    active.forEach(function (c) {
      let el = els.get(c.id);
      if (!el) {
        el = createCardEl(c);
        els.set(c.id, el);
        cardsLayer.appendChild(el);
      }
      seen.add(c.id);
      el.style.left = c.mapPos.x + 'px';
      el.style.top = c.mapPos.y + 'px';
      el.style.width = C.CARD_W + 'px';
      el.querySelector('.card-thumb').style.height = Math.round(C.CARD_W / ratio) + 'px';
      el.classList.toggle('selected', c.id === selectedId);
      const mi = multi.indexOf(c.id);
      el.classList.toggle('multi', mi >= 0 && multi.length > 0);
      if (mi >= 0) el.dataset.multi = String(mi + 1); else delete el.dataset.multi;
      el.classList.toggle('drop-target', c.id === dropTargetId);
      el.classList.toggle('dragging', !!(drag && drag.started && drag.movingSet.has(c.id)));
      // タイムラインに採用済みなら「#番号 尺」を出す
      const thumb = el.querySelector('.card-thumb');
      const url = AP.Draw.thumbURL(c.strokes, Store.settings().aspect, c.paper);
      if (thumb.dataset.url !== url) {
        thumb.dataset.url = url;
        thumb.style.backgroundImage = url ? 'url(' + url + ')' : '';
      }
      const badge = el.querySelector('.card-badge');
      const ti = tlIndex.get(c.id);
      el.classList.toggle('adopted', ti !== undefined);
      badge.textContent = !ti ? '' : ti.length === 1
        ? '#' + (ti[0] + 1) + '  ' + U.framesToLabel(c.duration, fps)
        : ti.map(function (i) { return '#' + (i + 1); }).join(' ');
      if (c.id !== editingId) {
        const t = el.querySelector('.card-text');
        t.textContent = c.text;
        t.classList.toggle('empty', !c.text);
      }
    });
    els.forEach(function (el, id) {
      if (!seen.has(id)) { el.remove(); els.delete(id); heights.delete(id); }
    });
    // 書き込みを終えてからまとめて測る
    els.forEach(function (el, id) { heights.set(id, el.offsetHeight); });

    renderLines(active);
  }

  function linkPath(p, c) {
    const w = C.CARD_W;
    const pc = { x: p.mapPos.x + w / 2, y: p.mapPos.y + cardH(p.id) / 2 };
    const cc = { x: c.mapPos.x + w / 2, y: c.mapPos.y + cardH(c.id) / 2 };
    const right = cc.x >= pc.x;
    const s = { x: pc.x + (right ? w / 2 : -w / 2), y: pc.y };
    const e = { x: cc.x + (right ? -w / 2 : w / 2), y: cc.y };
    if (C.LINE_STYLE === 'straight') {
      return { d: 'M' + s.x + ',' + s.y + ' L' + e.x + ',' + e.y, pts: [s, e] };
    }
    const k = Math.max(30, Math.abs(e.x - s.x) / 2) * (right ? 1 : -1);
    const c1 = { x: s.x + k, y: s.y };
    const c2 = { x: e.x - k, y: e.y };
    return {
      d: 'M' + s.x + ',' + s.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + e.x + ',' + e.y,
      pts: [s, c1, c2, e],
    };
  }

  function renderLines(active) {
    let html = '';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    active.forEach(function (c) {
      if (!c.parentId) return;
      const p = Store.get(c.parentId);
      if (!p || p.status !== 'active') return;
      const lp = linkPath(p, c);
      lp.pts.forEach(function (pt) {
        x0 = Math.min(x0, pt.x); y0 = Math.min(y0, pt.y);
        x1 = Math.max(x1, pt.x); y1 = Math.max(y1, pt.y);
      });
      html += '<g class="link" data-child="' + c.id + '">' +
        '<path class="link-hit" stroke-width="' + C.LINE_HIT_WIDTH + '" d="' + lp.d + '"/>' +
        '<path class="link-vis" d="' + lp.d + '"/>' +
        '<title>クリックで切り離す</title></g>';
    });
    if (!html) { linesSvg.style.display = 'none'; linesSvg.innerHTML = ''; return; }
    // SVGの大きさを線の範囲に合わせる（巨大なSVGを避ける）
    const pad = C.LINE_HIT_WIDTH;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    linesSvg.style.display = '';
    linesSvg.style.left = x0 + 'px';
    linesSvg.style.top = y0 + 'px';
    linesSvg.setAttribute('width', x1 - x0);
    linesSvg.setAttribute('height', y1 - y0);
    linesSvg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + (x1 - x0) + ' ' + (y1 - y0));
    linesSvg.innerHTML = html;
  }

  // ------------------------------------------------------------
  // 選択・編集・カード操作
  // ------------------------------------------------------------
  function select(id) {
    if (multi.length) { multi = []; selectedId = null; }
    if (selectedId === id) return render();
    selectedId = id;
    render();
    document.dispatchEvent(new CustomEvent('ap:select', { detail: { id: id } }));
  }

  function startEdit(id) {
    const el = els.get(id);
    const card = Store.get(id);
    if (!el || !card) return;
    if (editingId) finishEdit();
    editingId = id;
    el.classList.add('editing');
    const ta = document.createElement('textarea');
    ta.className = 'card-edit';
    ta.value = card.text;
    ta.rows = 1;
    const grow = function () { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return; // 日本語変換中のEnterは無視
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNextCard(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(true); }
    });
    ta.addEventListener('blur', function () { finishEdit(); });
    el.querySelector('.card-text').after(ta);
    grow();
    ta.focus();
    ta.select();
  }

  function finishEdit(cancel) {
    if (!editingId) return;
    const id = editingId;
    editingId = null;
    const el = els.get(id);
    const ta = el && el.querySelector('.card-edit');
    const text = ta ? ta.value.replace(/^\s+|\s+$/g, '') : null;
    if (el) el.classList.remove('editing');
    if (ta) ta.remove();
    if (!cancel && text !== null) {
      if (newCardId === id) Store.mergeNext(); // 作ったカードに最初の文字を入れるまでで1回の操作
      Store.updateCard(id, { text: text });
    } else render();

    if (newCardId === id) {
      newCardId = null;
      const c = Store.get(id);
      if (C.REMOVE_EMPTY_NEW_CARD && c && !c.text && !c.strokes.length && !Store.children(id).length) {
        if (selectedId === id) select(null);
        Store.removeCard(id);
      }
    }
  }

  function createAt(worldPt, props) {
    let x = worldPt.x - C.CARD_W / 2, y = worldPt.y - C.CARD_H_ESTIMATE / 2;
    if (snapOn()) { x = snap(x); y = snap(y); }
    const card = Store.createCard(Object.assign({ mapPos: { x: x, y: y } }, props || {}));
    newCardId = card.id;
    select(card.id);
    startEdit(card.id);
    return card;
  }

  function createAtCenter() {
    const r = vp.getBoundingClientRect();
    return createAt(clientToWorld(r.left + r.width / 2, r.top + r.height / 2));
  }

  function addChildOfSelected() {
    if (!selectedId) return;
    if (editingId) finishEdit();
    const parentId = selectedId;
    const p = Store.get(parentId);
    if (!p) return;
    const card = Store.createCard({ parentId: parentId, mapPos: { x: p.mapPos.x, y: p.mapPos.y } });
    autoPlace(card.id, parentId);
    newCardId = card.id;
    select(card.id);
    startEdit(card.id);
  }

  // ⌘/Ctrl+Enter：選択中のカードの次に新しいカード（親がいれば兄弟として）。選択なしなら画面の真ん中
  function addNextCard() {
    if (editingId) finishEdit();
    const base = selectedId ? Store.get(selectedId) : null;
    if (!base) return createAtCenter();
    const parent = base.parentId ? Store.get(base.parentId) : null;
    let card;
    if (parent && parent.status === 'active') {
      card = Store.createCard({ parentId: parent.id, mapPos: { x: base.mapPos.x, y: base.mapPos.y } });
      autoPlace(card.id, parent.id);
    } else {
      card = Store.createCard({ mapPos: { x: base.mapPos.x, y: base.mapPos.y + cardH(base.id) + C.CHILD_GAP_Y } });
    }
    // 箇条書きの並びでも、基準のカードのすぐ後ろに入れる
    const treeParent = Store.treeParentId(base);
    const sibs = Store.treeChildren(treeParent);
    Store.moveInTree(card.id, treeParent, sibs.findIndex(function (c) { return c.id === base.id; }) + 1);
    newCardId = card.id;
    select(card.id);
    startEdit(card.id);
    return card;
  }

  // ------------------------------------------------------------
  // 整列
  // ------------------------------------------------------------
  function offerUndo(msg) {
    U.toast(msg, {
      label: '元に戻す',
      ms: C.ARRANGE_UNDO_MS,
      fn: function () { if (Store.undo()) U.toast('整列する前の位置に戻しました'); },
    });
  }

  // いちばん上の階層の並び（箇条書きの順）。左上の基準は今いちばん上にあるカード
  function arrangeOrigin(roots) {
    const all = Store.activeCards();
    let x = Infinity, y = Infinity;
    all.forEach(function (c) { x = Math.min(x, c.mapPos.x); y = Math.min(y, c.mapPos.y); });
    return { x: snap(isFinite(x) ? x : 0), y: snap(isFinite(y) ? y : 0) };
  }

  // ツリーに整列：親の右に子、兄弟は縦に。親は子のまとまりの縦の真ん中
  function arrangeTree() {
    const roots = Store.treeChildren(null);
    if (!roots.length) return;
    Store.checkpoint(); // 整列だけで1回の取り消しになるように
    const pos = {};
    const colW = snap(C.CARD_W + C.CHILD_GAP_X);
    // 枝の高さ
    const memo = new Map();
    function heightOf(c) {
      if (memo.has(c.id)) return memo.get(c.id);
      const kids = Store.treeChildren(c.id);
      let kh = 0;
      kids.forEach(function (k, i) { kh += heightOf(k) + (i ? C.CHILD_GAP_Y : 0); });
      const h = Math.max(cardH(c.id), kh);
      memo.set(c.id, h);
      return h;
    }
    function place(c, x, top) {
      const h = heightOf(c);
      const kids = Store.treeChildren(c.id);
      if (!kids.length) {
        pos[c.id] = { x: x, y: snap(top + (h - cardH(c.id)) / 2) };
        return;
      }
      let kh = 0;
      kids.forEach(function (k, i) { kh += heightOf(k) + (i ? C.CHILD_GAP_Y : 0); });
      let y = top + (h - kh) / 2;
      kids.forEach(function (k) {
        place(k, x + colW, y);
        y += heightOf(k) + C.CHILD_GAP_Y;
      });
      // 親は最初の子と最後の子のちょうど間
      const first = pos[kids[0].id].y, last = pos[kids[kids.length - 1].id].y;
      pos[c.id] = { x: x, y: snap((first + last) / 2) };
    }
    const o = arrangeOrigin(roots);
    let top = o.y;
    roots.forEach(function (r) {
      place(r, o.x, top);
      top = snap(top + heightOf(r) + C.ARRANGE_ROOT_GAP);
    });
    Store.moveCards(pos);
    Store.checkpoint();
    offerUndo('ツリーに整列しました（⌘Zでも戻せます）');
  }

  function setSnap(on) {
    Store.setSetting('mapSnap', !!on);
    vp.classList.toggle('snap', !!on);
    U.toast(on ? 'グリッドに吸着します' : 'グリッドへの吸着をやめました');
  }

  // (x, y) にカードを置くと重なるなら、空いている所まで下へずらした位置を返す
  function freeSpot(x, y, exceptIds) {
    const w = C.CARD_W, h = C.CARD_H_ESTIMATE, gap = C.CHILD_GAP_Y;
    const boxes = Store.activeCards()
      .filter(function (c) { return !(exceptIds && exceptIds.has(c.id)); })
      .map(function (c) { return { x: c.mapPos.x, y: c.mapPos.y, h: cardH(c.id) }; });
    for (let i = 0; i < 200; i++) {
      const hit = boxes.find(function (b) {
        return x < b.x + w + gap && x + w + gap > b.x && y < b.y + b.h + gap && y + h + gap > b.y;
      });
      if (!hit) break;
      y = hit.y + hit.h + gap;
    }
    return { x: x, y: y };
  }

  // すでにタイムラインにあるカードをもう一度置いたとき：連動／コピー／移動を聞く
  function adoptAgain(id, index) {
    const nums = Store.timelineCards()
      .map(function (c, i) { return (c.id === id || c.linkOf === id) ? '#' + (i + 1) : null; })
      .filter(Boolean).join(' ');
    U.choose('このカードはすでにタイムラインにあります（' + nums + '）',
      '連動：絵と文字は共通で、片方を直すともう片方も変わります（尺は別々）。\nコピー：複製を作って並べます。あとで別々に描き直せます。',
      [
        { label: '連動して並べる', value: 'link', primary: true },
        { label: 'コピーして並べる', value: 'copy' },
        { label: 'ここへ移動', value: 'move' },
      ]).then(function (v) {
      if (v === 'link') {
        Store.addLink(id, index);
        U.toast('連動カットを並べました');
      } else if (v === 'copy') {
        const src = Store.get(id);
        const copy = Store.duplicate(id);
        Store.moveCards({ [copy.id]: freeSpot(src.mapPos.x, src.mapPos.y + cardH(src.id) + C.CHILD_GAP_Y, new Set([copy.id])) });
        Store.adopt(copy.id, index);
        U.toast('コピーを並べました（マップにも複製があります）');
      } else if (v === 'move') {
        // 自分を抜いた並びでの位置に直す
        const list = Store.timelineCards();
        const cur = list.findIndex(function (c) { return c.id === id; });
        Store.adopt(id, cur >= 0 && cur < index ? index - 1 : index);
        U.toast('タイムラインの順番を変えました');
      }
    });
  }

  // 子（とその子孫）を親の右側、兄弟の下に並べる
  function autoPlace(childId, parentId) {
    const p = Store.get(parentId);
    const c = Store.get(childId);
    if (!p || !c) return;
    const subtree = [c].concat(Store.descendants(childId, function (d) { return d.status === 'active'; }));
    const subIds = new Set(subtree.map(function (d) { return d.id; }));
    const sibs = Store.children(parentId).filter(function (s) { return s.status === 'active' && !subIds.has(s.id); });
    const x = p.mapPos.x + C.CARD_W + C.CHILD_GAP_X;
    let y = p.mapPos.y;
    if (sibs.length) {
      y = Math.max.apply(null, sibs.map(function (s) { return s.mapPos.y + cardH(s.id); })) + C.CHILD_GAP_Y;
    }
    y = freeSpot(x, y, subIds).y; // ほかの枝と重なるなら下へ
    if (snapOn()) { x = snap(x); y = Math.ceil(y / C.GRID_SIZE) * C.GRID_SIZE; }
    const dx = x - c.mapPos.x;
    const dy = y - c.mapPos.y;
    const pos = {};
    subtree.forEach(function (d) { pos[d.id] = { x: d.mapPos.x + dx, y: d.mapPos.y + dy }; });
    Store.moveCards(pos);
  }

  // 親子付け（ドラッグで重ねたとき・トレイから重ねたとき共通）
  function attachTo(childId, parentId) {
    if (!Store.setParent(childId, parentId)) {
      U.toast('自分の子孫の下には付けられません');
      return false;
    }
    if (C.AUTO_PLACE_ON_PARENT) autoPlace(childId, parentId);
    return true;
  }

  function peel(id) {
    if (!id) return;
    if (editingId) finishEdit();
    const c = Store.get(id);
    if (!c || c.status !== 'active') return;
    if (selectedId === id) select(null);
    Store.peel(id);
    U.toast('保留トレイへ剥がしました');
  }

  // 画面座標の下にあるカード（exclude のidは除く）
  function cardAtClient(cx, cy, exclude) {
    const list = document.elementsFromPoint(cx, cy);
    for (let i = 0; i < list.length; i++) {
      const cardEl = list[i].closest && list[i].closest('#map-cards .card');
      if (cardEl && !(exclude && exclude.has(cardEl.dataset.id))) return cardEl.dataset.id;
    }
    return null;
  }

  function isOverMap(cx, cy) {
    const r = vp.getBoundingClientRect();
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return false;
    return !AP.Tray.isOver(cx, cy);
  }

  function setDropTarget(id) {
    if (dropTargetId === id) return;
    dropTargetId = id;
    render();
  }

  // ------------------------------------------------------------
  // ポインター入力
  // ------------------------------------------------------------
  function onPointerDown(e) {
    if (e.target.closest('textarea') || e.target.closest('.card-peel')) return;
    if (editingId) finishEdit();
    const cardEl = e.target.closest('.card');
    if (cardEl && !drag && bgPointers.size === 0) startCardPress(e, cardEl.dataset.id);
    else if (!cardEl) startBgPointer(e);
  }

  function onPointerMove(e) {
    if (drag && e.pointerId === drag.pointerId) moveCardDrag(e);
    else if (bgPointers.has(e.pointerId)) moveBg(e);
  }

  function onPointerUp(e, cancelled) {
    if (drag && e.pointerId === drag.pointerId) endCardDrag(e, cancelled);
    else if (bgPointers.has(e.pointerId)) endBg(e, cancelled);
  }

  // ---- カード ----
  function startCardPress(e, id) {
    const group = multi.length > 1 && multi.indexOf(id) >= 0 ? multi.slice() : null;
    const moving = [];
    (group || [id]).forEach(function (gid) {
      moving.push(Store.get(gid));
      if (C.MOVE_SUBTREE_WITH_PARENT) {
        Array.prototype.push.apply(moving, Store.descendants(gid, function (d) { return d.status === 'active'; }));
      }
    });
    const origin = {};
    moving.forEach(function (c) { origin[c.id] = { x: c.mapPos.x, y: c.mapPos.y }; });
    drag = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      id: id,
      startX: e.clientX,
      startY: e.clientY,
      pressTarget: e.target,
      shift: e.shiftKey,
      group: group,
      started: false,
      origin: origin,
      movingSet: new Set(Object.keys(origin)),
      target: null,
      overTray: false,
    };
    vp.setPointerCapture(e.pointerId);
  }

  function moveCardDrag(e) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < dragThreshold(drag.pointerType)) return;
      drag.started = true;
      lastCardTap = null;
      if (!drag.group && multi.length) multi = []; // 選択に入っていないカードをつかんだら複数選択は解除
      selectedId = drag.id;
    }
    // 吸着中は、つかんだカードの左上がグリッドに乗るようにずらす（子孫も同じだけ動く）
    let mx = dx / view.z, my = dy / view.z;
    if (snapOn()) {
      const o = drag.origin[drag.id];
      mx = snap(o.x + mx) - o.x;
      my = snap(o.y + my) - o.y;
    }
    const pos = {};
    Object.keys(drag.origin).forEach(function (id) {
      pos[id] = { x: drag.origin[id].x + mx, y: drag.origin[id].y + my };
    });
    drag.overTray = AP.Tray.isOver(e.clientX, e.clientY);
    drag.overTimeline = !drag.overTray && AP.Timeline.isOver(e.clientX, e.clientY);
    drag.target = (drag.overTray || drag.overTimeline) ? null : cardAtClient(e.clientX, e.clientY, drag.movingSet);
    AP.Tray.setDropHighlight(drag.overTray);
    if (drag.overTimeline) {
      AP.Timeline.autoscroll(e.clientX);
      AP.Timeline.showInsert(e.clientX, drag.group ? new Set(drag.group) : drag.id);
    } else {
      AP.Timeline.hideInsert();
    }
    dropTargetId = drag.target;
    Store.moveCards(pos); // → render
  }

  function endCardDrag(e, cancelled) {
    const d = drag;
    drag = null;
    dropTargetId = null;
    AP.Tray.setDropHighlight(false);
    AP.Timeline.hideInsert();

    if (cancelled) {
      if (d.started) Store.moveCards(d.origin);
      return render();
    }
    if (!d.started) {
      // Shift＋タップ（または複数選択モード）：選択に足す／外す
      if (d.shift || multiMode) return toggleMulti(d.id);
      // タップ：選択。素早く2回でテキスト編集
      const now = performance.now();
      if (lastCardTap && lastCardTap.id === d.id && now - lastCardTap.t < C.DOUBLE_TAP_MS) {
        lastCardTap = null;
        select(d.id);
        // 絵の部分なら描画パネル、文字の部分ならテキスト編集
        if (d.pressTarget.closest('.card-thumb')) AP.Draw.open(d.id);
        else startEdit(d.id);
      } else {
        lastCardTap = { id: d.id, t: now };
        select(d.id);
      }
      return;
    }
    if (d.group) return endGroupDrag(d, e);
    if (d.overTray) {
      Store.moveCards(d.origin); // 戻したとき元の位置に出るように
      peel(d.id);
    } else if (d.overTimeline) {
      // 採用：カードはマップにも残る（同じカードを別のビューで見ているだけ）
      const index = AP.Timeline.indexAt(e.clientX, d.id);
      Store.moveCards(d.origin);
      if (Store.get(d.id).timelineOrder === null) {
        Store.adopt(d.id, index);
        U.toast('タイムラインに採用しました');
      } else {
        adoptAgain(d.id, AP.Timeline.indexAt(e.clientX, null));
      }
    } else if (d.target) {
      if (!attachTo(d.id, d.target)) Store.moveCards(d.origin); // 付けられないときは元の位置へ
    } else {
      render();
    }
    document.dispatchEvent(new CustomEvent('ap:select', { detail: { id: selectedId } }));
  }

  // ---- 複数選択 ----
  function toggleMulti(id) {
    if (!multi.length && selectedId && selectedId !== id) multi = [selectedId];
    const i = multi.indexOf(id);
    if (i >= 0) multi.splice(i, 1); else multi.push(id);
    selectedId = multi.length ? multi[multi.length - 1] : null;
    if (multi.length === 1) multi = [];   // 1枚だけならふつうの選択
    render();
    document.dispatchEvent(new CustomEvent('ap:select', { detail: { id: selectedId, multi: multi.slice() } }));
  }

  function clearMulti() {
    if (!multi.length) return;
    multi = [];
    render();
    document.dispatchEvent(new CustomEvent('ap:select', { detail: { id: selectedId, multi: [] } }));
  }

  // まとめてドラッグして離したとき
  function endGroupDrag(d, e) {
    const ids = d.group;
    if (d.overTray) {
      Store.moveCards(d.origin);
      ids.forEach(function (id) { Store.peel(id); });
      multi = [];
      selectedId = null;
      U.toast(ids.length + '枚を保留トレイへ剥がしました');
    } else if (d.overTimeline) {
      // 選んだ順にタイムラインへ（すでに並んでいるものもこの流れに入れ直す）
      const beforeId = AP.Timeline.beforeIdAt(e.clientX, new Set(ids));
      Store.moveCards(d.origin);
      Store.adoptMany(ids, beforeId);
      U.toast(ids.length + '枚を選んだ順にタイムラインへ並べました');
    } else if (d.target) {
      let ng = 0;
      ids.forEach(function (id) { if (!Store.setParent(id, d.target)) ng++; else if (C.AUTO_PLACE_ON_PARENT) autoPlace(id, d.target); });
      if (ng) U.toast(ng + '枚は自分の子孫の下には付けられませんでした');
    }
    render();
    document.dispatchEvent(new CustomEvent('ap:select', { detail: { id: selectedId, multi: multi.slice() } }));
  }

  // ---- 背景（パン・ピンチ・ダブルタップ・線のタップ） ----
  function startBgPointer(e) {
    bgPointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    vp.setPointerCapture(e.pointerId);
    if (bgPointers.size === 1) {
      const link = e.target.closest('.link');
      bg = {
        mode: 'pan',
        startX: e.clientX, startY: e.clientY,
        view0: { x: view.x, y: view.y },
        moved: false,
        pointerType: e.pointerType,
        linkChild: link ? link.dataset.child : null,
      };
    } else if (bgPointers.size === 2) {
      startPinch();
    }
  }

  function startPinch() {
    const pts = Array.from(bgPointers.values());
    const r = vp.getBoundingClientRect();
    bg = {
      mode: 'pinch',
      dist0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      mid0: { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top },
      view0: { x: view.x, y: view.y, z: view.z },
      moved: true,
    };
  }

  function moveBg(e) {
    const pt = bgPointers.get(e.pointerId);
    pt.x = e.clientX; pt.y = e.clientY;
    if (!bg) return;
    if (bg.mode === 'pan') {
      const dx = e.clientX - bg.startX;
      const dy = e.clientY - bg.startY;
      if (!bg.moved && Math.hypot(dx, dy) < dragThreshold(bg.pointerType)) return;
      bg.moved = true;
      view.x = bg.view0.x + dx;
      view.y = bg.view0.y + dy;
      applyView();
    } else if (bg.mode === 'pinch' && bgPointers.size >= 2) {
      const pts = Array.from(bgPointers.values());
      const r = vp.getBoundingClientRect();
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
      const z = U.clamp(bg.view0.z * dist / bg.dist0, C.ZOOM_MIN, C.ZOOM_MAX);
      const wx = (bg.mid0.x - bg.view0.x) / bg.view0.z;
      const wy = (bg.mid0.y - bg.view0.y) / bg.view0.z;
      view.z = z;
      view.x = mid.x - wx * z;
      view.y = mid.y - wy * z;
      applyView();
    }
  }

  function endBg(e, cancelled) {
    bgPointers.delete(e.pointerId);
    const g = bg;
    if (bgPointers.size === 1) {
      // ピンチから指が1本残った：その指でパンを続ける
      const rest = Array.from(bgPointers.values())[0];
      bg = { mode: 'pan', startX: rest.x, startY: rest.y, view0: { x: view.x, y: view.y }, moved: true, pointerType: rest.type };
      return;
    }
    if (bgPointers.size > 0) return;
    bg = null;
    if (cancelled || !g || g.mode !== 'pan' || g.moved) return;

    // 動かさずに離した＝タップ
    if (g.linkChild) {
      Store.detach(g.linkChild);
      U.toast('切り離しました');
      return;
    }
    const now = performance.now();
    if (lastBgTap && now - lastBgTap.t < C.DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - lastBgTap.x, e.clientY - lastBgTap.y) < C.DOUBLE_TAP_SLOP_PX) {
      lastBgTap = null;
      createAt(clientToWorld(e.clientX, e.clientY));
    } else {
      lastBgTap = { t: now, x: e.clientX, y: e.clientY };
      if (!multiMode) select(null);
    }
  }

  // ホイール：パン。Ctrl/⌘＋ホイール（Chromeのトラックパッドのピンチもこれ）：ズーム
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || C.WHEEL_ZOOM_WITHOUT_CTRL) {
      zoomAt(e.clientX, e.clientY, view.z * Math.exp(-e.deltaY * C.WHEEL_ZOOM_SPEED));
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      view.x -= e.deltaX * k;
      view.y -= e.deltaY * k;
      applyView();
    }
  }

  // Mac版Safariのトラックパッドのピンチ（iPadの指ピンチはPointer Eventsで処理するので無視）
  function onGestureStart(e) {
    e.preventDefault();
    if (bgPointers.size || drag) return;
    safariGesture = { z0: view.z };
  }
  function onGestureChange(e) {
    e.preventDefault();
    if (!safariGesture || bgPointers.size || drag) return;
    zoomAt(e.clientX, e.clientY, safariGesture.z0 * e.scale);
  }
  function onGestureEnd(e) { e.preventDefault(); safariGesture = null; }

  // ------------------------------------------------------------
  function init() {
    vp = document.getElementById('map-viewport');
    world = document.getElementById('map-world');
    linesSvg = document.getElementById('map-lines');
    cardsLayer = document.getElementById('map-cards');
    zoomLabel = document.getElementById('zoom-label');

    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerup', function (e) { onPointerUp(e, false); });
    vp.addEventListener('pointercancel', function (e) { onPointerUp(e, true); });
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('gesturestart', onGestureStart);
    vp.addEventListener('gesturechange', onGestureChange);
    vp.addEventListener('gestureend', onGestureEnd);

    Store.subscribe(function (reason) {
      if (reason === 'load') { selectedId = null; editingId = null; vp.classList.toggle('snap', snapOn()); }
      if (reason === 'history') {
        // 取り消しで選択中のカードがなくなったら選択を外す
        const sel = selectedId && Store.get(selectedId);
        if (selectedId && (!sel || sel.status !== 'active')) {
          selectedId = null;
          document.dispatchEvent(new CustomEvent('ap:select', { detail: { id: null } }));
        }
        vp.classList.toggle('snap', snapOn());
      }
      render();
    });
    vp.classList.toggle('snap', snapOn());
    render();
    applyView();
  }

  AP.MapView = {
    init: init,
    render: render,
    fit: fit,
    select: select,
    selected: function () { return selectedId; },
    isEditing: function () { return !!editingId; },
    startEdit: startEdit,
    finishEdit: finishEdit,
    createAtCenter: createAtCenter,
    addChildOfSelected: addChildOfSelected,
    addNextCard: addNextCard,
    peel: peel,
    attachTo: attachTo,
    autoPlace: autoPlace,
    multiSelected: function () { return multi.slice(); },
    clearMulti: clearMulti,
    toggleMulti: toggleMulti,
    setMultiMode: function (on) { multiMode = !!on; if (!on) clearMulti(); },
    multiMode: function () { return multiMode; },
    // 複数選択していればその全部、なければ選択中の1枚を剥がす
    peelSelection: function () {
      if (multi.length) {
        const ids = multi.slice();
        multi = [];
        selectedId = null;
        ids.forEach(function (id) { Store.peel(id); });
        U.toast(ids.length + '枚を保留トレイへ剥がしました');
        document.dispatchEvent(new CustomEvent('ap:select', { detail: { id: null, multi: [] } }));
      } else if (selectedId) {
        peel(selectedId);
      }
    },
    cardH: cardH,
    adoptAgain: adoptAgain,
    freeSpot: freeSpot,
    arrangeTree: arrangeTree,
    setSnap: setSnap,
    snapOn: snapOn,
    // 画面の真ん中のワールド座標（マップが隠れているときは最後に見えていた位置の目安）
    viewCenter: function () {
      const r = vp.getBoundingClientRect();
      if (!r.width) return { x: (-view.x + 400) / view.z, y: (-view.y + 300) / view.z };
      return clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
    },
    cardAtClient: cardAtClient,
    clientToWorld: clientToWorld,
    isOverMap: isOverMap,
    setDropTarget: setDropTarget,
    zoomBy: function (k) {
      const r = vp.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.z * k);
    },
  };
})();
