/*
 * AP.Timeline：タイムライン。採用カードを左から右へ、尺に比例した幅で並べる。
 * - 入力はすべて #tl-scroll で受けて振り分ける（カードの作り直しでポインターを見失わないため）
 * - カードのドラッグ：並べ替え。マップへドラッグで外す。右端のつまみ：尺を伸び縮み。尺の数字をタップ：入力
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let panel, scrollEl, track, marker, totalEl, zoomEl;
  let zoom = 1;
  let press = null;        // カードを押している／ドラッグ中／伸縮中
  let durEditId = null;    // 尺を入力中のカード
  let pendingRender = false;
  let lastTap = null;      // ダブルタップ判定
  let scene = null;        // 表示中のシーン（ツリーのいちばん上のカードのid）
  let sceneSel;

  function pxPerFrame() { return C.TL_PX_PER_SEC * zoom / Store.settings().fps; }

  function totalLabel(frames, fps) {
    const sec = frames / fps;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return '総尺 ' + U.framesToLabel(frames, fps) +
      (m > 0 ? '（' + m + '分' + s + '秒）' : '') + '　' + frames + 'コマ';
  }

  // ------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------
  function render() {
    if (durEditId || (press && press.mode !== 'press')) { pendingRender = true; return; }
    pendingRender = false;
    const fps = Store.settings().fps;
    if (!scene || !Store.isScene(scene)) scene = Store.scenes()[0] || null;
    renderSceneSelect();
    const list = scene ? Store.timelineCards(scene) : [];
    const ppf = pxPerFrame();
    const pad = C.TL_PADDING_PX;
    const total = scene ? Store.totalFrames(scene) : 0;
    const selected = AP.MapView.selected();

    const groups = scene ? Store.cutGroups(scene) : [];
    totalEl.textContent = totalLabel(total, fps) + '　' + groups.length + 'カット' + (groups.length !== list.length ? '（絵 ' + list.length + '枚）' : '');
    zoomEl.textContent = Math.round(zoom * 100) + '%';

    track.innerHTML = '';
    const viewW = scrollEl.clientWidth;
    const width = Math.max(viewW, pad * 2 + total * ppf + 120);
    track.style.width = width + 'px';

    // 目盛り（ラベルの間隔が詰まりすぎないよう秒の刻みを選ぶ）
    const ruler = document.createElement('div');
    ruler.className = 'tl-ruler';
    const pps = ppf * fps;
    const step = [1, 2, 5, 10, 15, 30, 60].find(function (s) { return s * pps >= 48; }) || 120;
    const maxSec = Math.ceil((width - pad) / pps);
    let html = '';
    for (let s = 0; s <= maxSec; s++) {
      const major = s % step === 0;
      if (!major && pps < 8) continue;
      html += '<div class="tl-tick' + (major ? ' major' : '') + '" style="left:' + (pad + s * pps) + 'px">' +
        (major ? '<span>' + s + '秒</span>' : '') + '</div>';
    }
    ruler.innerHTML = html;
    track.appendChild(ruler);

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'tl-empty';
      empty.textContent = scene
        ? '「' + Store.sceneName(scene) + '」にはまだカットがありません。このシーンのカードをマップからドラッグしてください'
        : 'マップのカードをここへドラッグすると、タイムラインに採用されます（ツリー1本が1つのシーンになります）';
      track.appendChild(empty);
    }

    // 同じカットにまとめた絵を囲む枠（カードの後ろ）
    let gx = 0;
    groups.forEach(function (g) {
      if (g.cards.length > 1) {
        const box = document.createElement('div');
        box.className = 'tl-group';
        box.style.left = (pad + gx * ppf - 3) + 'px';
        box.style.width = (g.frames * ppf + 6) + 'px';
        box.title = 'C' + g.no + '（絵 ' + g.cards.length + '枚・' + U.framesToLabel(g.frames, fps) + '）';
        track.appendChild(box);
      }
      gx += g.frames;
    });
    const noOf = new Map();
    groups.forEach(function (g) { g.cards.forEach(function (c, k) { noOf.set(c.id, { no: g.no, part: k + 1, parts: g.cards.length }); }); });

    let start = 0;
    list.forEach(function (c, i) {
      const cn = noOf.get(c.id) || { no: i + 1, part: 1, parts: 1 };
      const el = document.createElement('div');
      const src = Store.source(c);
      el.className = 'tl-card' + (src.id === selected ? ' selected' : '') + (c.linkOf ? ' linked' : '') + (cn.part > 1 ? ' joined' : '');
      el.dataset.id = c.id;
      el.dataset.src = src.id;
      el.style.left = (pad + start * ppf) + 'px';
      el.style.width = Math.max(C.TL_MIN_CARD_PX, c.duration * ppf) + 'px';
      el.innerHTML =
        '<div class="tl-thumb"><span class="tl-no">' + cn.no + (cn.parts > 1 ? '<small>-' + cn.part + '</small>' : '') + '</span></div>' +
        (i > 0 ? '<div class="tl-join' + (cn.part > 1 ? ' on' : '') + '" title="' + (cn.part > 1 ? '前のカードと別のカットにする' : '前のカードと同じカットにする（動きの指示で絵を分けたときなど）') + '">' + (cn.part > 1 ? '＝' : '＋') + '</div>' : '') +
        '<div class="tl-text"></div>' +
        '<div class="tl-dur" title="タップして尺を入力（秒+コマ）">' + U.framesToLabel(c.duration, fps) + '</div>' +
        '<div class="tl-cam' + (AP.Camera.isEmpty(c.camera) ? ' empty' : '') + '" title="カメラワーク（PAN・T.U・F.Iなど）">' +
          (AP.Camera.label(c.camera) || '🎥') + '</div>' +
        '<div class="tl-note' + (src.note ? '' : ' empty') + '" title="セリフ・メモ（SE・BGM）"></div>' +
        '<div class="tl-remove" title="タイムラインから外す（カードは消えません）">×</div>' +
        '<div class="tl-resize" title="ドラッグで尺を変える"></div>';
      el.querySelector('.tl-text').textContent = (c.linkOf ? '🔗 ' : '') + (src.text || '（無題）');
      el.querySelector('.tl-note').textContent = src.note ? '💬 ' + src.note.split('\n')[0] : '💬';
      if (c.linkOf) el.title = '連動カット：絵と文字は元のカードと共通です';
      const col = Store.colorOf(c);
      if (col) { el.classList.add('colored'); el.style.setProperty('--tl-color', col.line); }
      const url = AP.Draw.thumbURL(src.strokes, Store.settings().aspect, src.paper, src.image);
      if (url) el.querySelector('.tl-thumb').style.backgroundImage = 'url(' + url + ')';
      track.appendChild(el);
      start += c.duration;
    });

    marker = document.createElement('div');
    marker.className = 'tl-marker';
    track.appendChild(marker);
  }

  // ------------------------------------------------------------
  // 挿入位置
  // ------------------------------------------------------------
  // exclude はid1つか、idの Set（複数選択でまとめてドラッグしているとき）
  function cardEls(exclude) {
    return Array.prototype.filter.call(track.querySelectorAll('.tl-card'), function (el) {
      return exclude instanceof Set ? !exclude.has(el.dataset.id) : el.dataset.id !== exclude;
    });
  }

  // 挿入位置のすぐ後ろのカードのid（最後なら null）
  function beforeIdAt(cx, exclude) {
    const els = cardEls(exclude);
    const el = els[indexAt(cx, exclude)];
    return el ? el.dataset.id : null;
  }

  function indexAt(cx, excludeId) {
    const els = cardEls(excludeId);
    let i = 0;
    while (i < els.length) {
      const r = els[i].getBoundingClientRect();
      if (cx < r.left + r.width / 2) break;
      i++;
    }
    return i;
  }

  // 挿入位置に縦線を出し、その位置を返す
  function showInsert(cx, excludeId) {
    const els = cardEls(excludeId);
    const i = indexAt(cx, excludeId);
    const tr = track.getBoundingClientRect();
    let x;
    if (els[i]) x = els[i].getBoundingClientRect().left - tr.left;
    else if (els.length) x = els[els.length - 1].getBoundingClientRect().right - tr.left;
    else x = C.TL_PADDING_PX;
    marker.style.left = x + 'px';
    marker.classList.add('show');
    panel.classList.add('drop-hover');
    return i;
  }

  function hideInsert() {
    if (marker) marker.classList.remove('show');
    panel.classList.remove('drop-hover');
  }

  function autoscroll(cx) {
    const r = scrollEl.getBoundingClientRect();
    if (cx < r.left + C.TL_AUTOSCROLL_EDGE_PX) scrollEl.scrollLeft -= C.TL_AUTOSCROLL_SPEED;
    else if (cx > r.right - C.TL_AUTOSCROLL_EDGE_PX) scrollEl.scrollLeft += C.TL_AUTOSCROLL_SPEED;
  }

  function isOver(cx, cy) {
    const r = panel.getBoundingClientRect();
    return r.width > 0 && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }

  // ------------------------------------------------------------
  // 尺の入力
  // ------------------------------------------------------------
  function startDurEdit(id) {
    const el = track.querySelector('.tl-card[data-id="' + id + '"]');
    const card = Store.get(id);
    if (!el || !card) return;
    const fps = Store.settings().fps;
    const label = el.querySelector('.tl-dur');
    const input = document.createElement('input');
    input.className = 'tl-dur-input';
    input.type = 'text';
    input.value = U.framesToLabel(card.duration, fps);
    input.setAttribute('aria-label', '尺（秒+コマ）');
    durEditId = id;
    el.classList.add('editing');

    let done = false;
    const finish = function (commit) {
      if (done) return;
      done = true;
      durEditId = null;
      const frames = U.labelToFrames(input.value, fps);
      if (commit && frames === null) U.toast('「秒+コマ」で入力してください（例 2+12）');
      if (commit && frames !== null && frames !== card.duration) Store.setDuration(id, frames);
      else render();
    };
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // ↑↓で1コマずつ、Shift+↑↓で1秒ずつ
        e.preventDefault();
        const cur = U.labelToFrames(input.value, fps);
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? fps : 1);
        input.value = U.framesToLabel(Math.max(C.MIN_DURATION_FRAMES, (cur === null ? card.duration : cur) + d), fps);
      }
    });
    input.addEventListener('blur', function () { finish(true); });
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  // ------------------------------------------------------------
  // ポインター入力
  // ------------------------------------------------------------
  function onPointerDown(e) {
    if (e.target.closest('.tl-dur-input')) return;
    const cardEl = e.target.closest('.tl-card');
    if (AP.MapView.isEditing()) AP.MapView.finishEdit();
    if (!cardEl || press) return;
    const id = cardEl.dataset.id;
    press = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      id: id,
      el: cardEl,
      target: e.target,
      startX: e.clientX,
      startY: e.clientY,
      mode: e.target.closest('.tl-resize') ? 'resize' : 'press',
      origFrames: Store.get(id).duration,
      frames: Store.get(id).duration,
      ghost: null,
    };
    if (press.mode === 'resize') cardEl.classList.add('resizing');
    scrollEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!press || e.pointerId !== press.pointerId) return;
    const dx = e.clientX - press.startX;
    const dy = e.clientY - press.startY;

    if (press.mode === 'resize') {
      const stepF = C.TL_RESIZE_STEP_FRAMES;
      const f = Math.max(C.MIN_DURATION_FRAMES, press.origFrames + Math.round(dx / pxPerFrame() / stepF) * stepF);
      if (f !== press.frames) {
        press.frames = f;
        press.el.style.width = Math.max(C.TL_MIN_CARD_PX, f * pxPerFrame()) + 'px';
        press.el.querySelector('.tl-dur').textContent = U.framesToLabel(f, Store.settings().fps);
        // 後ろのカードも寄せる
        let x = press.el.offsetLeft + press.el.offsetWidth;
        let n = press.el.nextElementSibling;
        while (n && n.classList.contains('tl-card')) {
          n.style.left = x + 'px';
          x += n.offsetWidth;
          n = n.nextElementSibling;
        }
      }
      return;
    }

    if (press.mode === 'press') {
      const th = press.pointerType === 'touch' ? C.DRAG_THRESHOLD_TOUCH_PX : C.DRAG_THRESHOLD_MOUSE_PX;
      if (Math.hypot(dx, dy) < th) return;
      press.mode = 'drag';
      press.ghost = press.el.cloneNode(true);
      press.ghost.classList.add('tl-ghost');
      press.ghost.style.width = Math.max(48, press.el.offsetWidth) + 'px';
      document.body.appendChild(press.ghost);
      press.el.classList.add('dragging');
    }
    // drag
    press.ghost.style.left = e.clientX + 'px';
    press.ghost.style.top = e.clientY + 'px';
    const overTl = isOver(e.clientX, e.clientY);
    const overMap = !overTl && C.TL_DROP_ON_MAP_UNADOPTS && AP.MapView.isOverMap(e.clientX, e.clientY);
    press.ghost.classList.toggle('out', overMap);
    if (overTl) { autoscroll(e.clientX); showInsert(e.clientX, press.id); }
    else hideInsert();
  }

  function onPointerUp(e, cancelled) {
    if (!press || e.pointerId !== press.pointerId) return;
    const p = press;
    press = null;
    hideInsert();
    p.el.classList.remove('dragging', 'resizing');
    if (p.ghost) p.ghost.remove();

    if (p.mode === 'resize') {
      if (!cancelled && p.frames !== p.origFrames) Store.setDuration(p.id, p.frames);
      else render();
      return;
    }
    if (cancelled) return render();

    if (p.mode === 'press') {
      // タップ
      if (p.target.closest('.tl-join')) {
        const card = Store.get(p.id);
        Store.checkpoint();
        Store.setJoinPrev(p.id, !card.joinPrev);
        Store.checkpoint();
        U.toast(card.joinPrev ? '前のカードと同じカットにしました（カット番号は1つとして数えます）' : '前のカードと別のカットにしました');
      } else if (p.target.closest('.tl-remove')) {
        Store.unadopt(p.id);
        U.toast('タイムラインから外しました（カードはマップに残っています）');
      } else if (p.target.closest('.tl-note')) {
        const src = Store.source(Store.get(p.id));
        AP.MapView.select(src.id);
        U.editText('セリフ・メモ（SE・BGM）　' + (src.text || '（無題）'), src.note,
          '「セリフ」／SE：チャイム／BGM：○○ など（⌘Enterで保存）').then(function (v) {
          if (v === null || v === src.note) return;
          Store.checkpoint(); // ダイアログでの保存は1回の操作（前の入力とまとめない）
          Store.updateCard(src.id, { note: v });
          Store.checkpoint();
        });
      } else if (p.target.closest('.tl-cam')) {
        AP.MapView.select(Store.source(Store.get(p.id)).id);
        AP.Camera.open(p.id);
      } else if (p.target.closest('.tl-dur')) {
        AP.MapView.select(Store.source(Store.get(p.id)).id);
        startDurEdit(p.id);
      } else {
        // ダブルタップで描画パネル
        const now = performance.now();
        if (lastTap && lastTap.id === p.id && now - lastTap.t < C.DOUBLE_TAP_MS) {
          lastTap = null;
          AP.Draw.open(p.id);
        } else {
          lastTap = { id: p.id, t: now };
          AP.MapView.select(Store.source(Store.get(p.id)).id);
        }
      }
      return;
    }
    // drag
    if (isOver(e.clientX, e.clientY)) {
      Store.adopt(p.id, indexAt(e.clientX, p.id));
    } else if (C.TL_DROP_ON_MAP_UNADOPTS && AP.MapView.isOverMap(e.clientX, e.clientY)) {
      Store.unadopt(p.id);
      U.toast('タイムラインから外しました');
    } else {
      render();
    }
    if (pendingRender) render();
  }

  // 縦ホイールでも横にスクロール
  function onWheel(e) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.ctrlKey && !e.metaKey) {
      scrollEl.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }

  function setZoom(z) {
    zoom = U.clamp(z, C.TL_ZOOM_MIN, C.TL_ZOOM_MAX);
    render();
  }

  function init() {
    panel = document.getElementById('timeline');
    scrollEl = document.getElementById('tl-scroll');
    track = document.getElementById('tl-track');
    totalEl = document.getElementById('tl-total');
    zoomEl = document.getElementById('tl-zoom-label');

    scrollEl.addEventListener('pointerdown', onPointerDown);
    scrollEl.addEventListener('pointermove', onPointerMove);
    scrollEl.addEventListener('pointerup', function (e) { onPointerUp(e, false); });
    scrollEl.addEventListener('pointercancel', function (e) { onPointerUp(e, true); });
    scrollEl.addEventListener('wheel', onWheel, { passive: false });
    document.getElementById('tl-zoom-in').addEventListener('click', function () { setZoom(zoom * C.TL_ZOOM_STEP); });
    document.getElementById('tl-zoom-out').addEventListener('click', function () { setZoom(zoom / C.TL_ZOOM_STEP); });

    document.addEventListener('ap:select', function (e) {
      // 選んだカードのシーンに切り替える
      if (e.detail.id && Store.get(e.detail.id)) {
        const sc = Store.sceneOf(e.detail.id);
        if (sc !== scene) { scene = sc; return render(); }
      }
      track.querySelectorAll('.tl-card').forEach(function (el) {
        el.classList.toggle('selected', el.dataset.src === e.detail.id);
      });
    });
    setupResizer();
    sceneSel = document.getElementById('tl-scene');
    sceneSel.addEventListener('change', function () { scene = sceneSel.value || null; render(); });
    window.addEventListener('resize', render);
    Store.subscribe(function (reason) {
      if (reason !== 'move') render(); // マップでカードを動かしている間は作り直さない
    });
    render();
  }

  // 上の端をドラッグして高さを変える（この端末に覚えておく）
  const HEIGHT_KEY = 'anime-prepro:timelineHeight';
  function setHeight(px) {
    const ws = document.querySelector('.workspace');
    const max = Math.max(C.TL_HEIGHT_MIN, ws.clientHeight * C.TL_HEIGHT_MAX_RATIO);
    const h = Math.round(U.clamp(px, C.TL_HEIGHT_MIN, max));
    ws.style.setProperty('--timeline-h', h + 'px');
    return h;
  }

  function setupResizer() {
    try {
      const saved = parseInt(localStorage.getItem(HEIGHT_KEY), 10);
      if (saved) setHeight(saved);
    } catch (e) { /* 保存できない環境では既定の高さ */ }
    const bar = document.getElementById('tl-resizer');
    let rs = null;
    bar.addEventListener('pointerdown', function (e) {
      rs = { id: e.pointerId, y: e.clientY, h: panel.getBoundingClientRect().height };
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) {
      if (!rs || e.pointerId !== rs.id) return;
      setHeight(rs.h + (rs.y - e.clientY));
    });
    const end = function (e) {
      if (!rs || e.pointerId !== rs.id) return;
      rs = null;
      const h = Math.round(panel.getBoundingClientRect().height);
      try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch (err) { /* 無視 */ }
      render();
      window.dispatchEvent(new Event('resize')); // マップなどの大きさを合わせ直す
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  // シーンの選択肢：カットのあるシーン＋表示中のシーン
  function renderSceneSelect() {
    const ids = Store.scenes();
    if (scene && ids.indexOf(scene) < 0) ids.push(scene);
    const key = ids.map(function (id) { return id + ':' + Store.sceneName(id) + ':' + Store.cutCount(id); }).join('|') + '#' + scene;
    if (sceneSel.dataset.key === key) return;
    sceneSel.dataset.key = key;
    sceneSel.innerHTML = '';
    if (!ids.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（シーンなし）';
      sceneSel.appendChild(o);
    }
    ids.forEach(function (id, i) {
      const o = document.createElement('option');
      o.value = id;
      const n = Store.cutCount(id);
      o.textContent = 'シーン' + (i + 1) + '：' + Store.sceneName(id) + '（' + n + 'カット）';
      sceneSel.appendChild(o);
    });
    sceneSel.value = scene || '';
  }

  AP.Timeline = {
    init: init,
    scene: function () { return scene; },
    setScene: function (id) { if (id !== scene) { scene = id; render(); } },
    render: render,
    isOver: isOver,
    indexAt: indexAt,
    beforeIdAt: beforeIdAt,
    showInsert: showInsert,
    hideInsert: hideInsert,
    autoscroll: autoscroll,
  };
})();
