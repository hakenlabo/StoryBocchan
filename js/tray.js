/*
 * AP.Tray：保留トレイ。剥がしたカード（のまとまり）を一覧し、「戻す」かドラッグでマップへ戻す。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let trayEl, listEl, countEl;
  let drag = null;

  function render() {
    const roots = Store.trayRoots();
    countEl.textContent = roots.length ? String(roots.length) : '';
    trayEl.classList.toggle('has-items', roots.length > 0);
    listEl.innerHTML = '';
    roots.forEach(function (c) {
      const n = Store.trayGroup(c.id).length - 1;
      const li = document.createElement('li');
      li.className = 'tray-item';
      li.dataset.id = c.id;
      li.innerHTML =
        '<div class="tray-text"></div>' +
        (n > 0 ? '<span class="tray-badge" title="一緒に剥がした子カード">+' + n + '</span>' : '') +
        '<button class="tray-restore" type="button">戻す</button>';
      const t = li.querySelector('.tray-text');
      t.textContent = c.text || '（無題）';
      t.classList.toggle('empty', !c.text);
      li.querySelector('.tray-restore').addEventListener('click', function () {
        Store.restore(c.id);
        U.toast('マップに戻しました');
      });
      listEl.appendChild(li);
    });
  }

  // ---- トレイからマップへのドラッグ ----
  function onPointerDown(e) {
    const li = e.target.closest('.tray-item');
    if (!li || e.target.closest('button')) return;
    drag = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      id: li.dataset.id,
      li: li,
      startX: e.clientX,
      startY: e.clientY,
      ghost: null,
    };
    li.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const th = drag.pointerType === 'touch' ? C.DRAG_THRESHOLD_TOUCH_PX : C.DRAG_THRESHOLD_MOUSE_PX;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < th) return;
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'tray-ghost';
      drag.ghost.textContent = drag.li.querySelector('.tray-text').textContent;
      document.body.appendChild(drag.ghost);
      drag.li.classList.add('dragging');
    }
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
    const overMap = AP.MapView.isOverMap(e.clientX, e.clientY);
    drag.ghost.classList.toggle('over-map', overMap);
    AP.MapView.setDropTarget(overMap ? AP.MapView.cardAtClient(e.clientX, e.clientY) : null);
  }

  function onPointerUp(e, cancelled) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    AP.MapView.setDropTarget(null);
    if (!d.ghost) return;
    d.ghost.remove();
    d.li.classList.remove('dragging');
    if (cancelled || !AP.MapView.isOverMap(e.clientX, e.clientY)) return;

    const target = AP.MapView.cardAtClient(e.clientX, e.clientY);
    const w = AP.MapView.clientToWorld(e.clientX, e.clientY);
    Store.restore(d.id, { x: w.x - C.CARD_W / 2, y: w.y - C.CARD_H_ESTIMATE / 2 });
    if (target) AP.MapView.attachTo(d.id, target);
    AP.MapView.select(d.id);
  }

  function init() {
    trayEl = document.getElementById('tray');
    listEl = document.getElementById('tray-list');
    countEl = document.getElementById('tray-count');

    document.getElementById('tray-toggle').addEventListener('click', function () {
      trayEl.classList.toggle('collapsed');
    });
    listEl.addEventListener('pointerdown', onPointerDown);
    listEl.addEventListener('pointermove', onPointerMove);
    listEl.addEventListener('pointerup', function (e) { onPointerUp(e, false); });
    listEl.addEventListener('pointercancel', function (e) { onPointerUp(e, true); });

    Store.subscribe(function (reason) {
      if (reason !== 'move') render(); // ドラッグ中の大量の更新では作り直さない
    });
    render();
  }

  AP.Tray = {
    init: init,
    render: render,
    isOver: function (cx, cy) {
      const r = trayEl.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    },
    setDropHighlight: function (on) { trayEl.classList.toggle('drop-hover', !!on); },
  };
})();
