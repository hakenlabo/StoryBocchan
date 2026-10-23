/* 起動、ヘッダー、ツールバー、キーボード */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;
  const Storage = AP.Storage;
  const MapView = AP.MapView;

  function setStatus(kind, text) {
    const el = document.getElementById('save-status');
    el.className = 'save-status ' + kind;
    el.textContent = text;
  }

  function fillSelect(sel, options, value) {
    sel.innerHTML = '';
    options.forEach(function (o) {
      const opt = document.createElement('option');
      opt.value = String(o);
      opt.textContent = String(o);
      sel.appendChild(opt);
    });
    sel.value = String(value);
  }

  function setupHeader() {
    const title = document.getElementById('project-title');
    title.value = Store.project().title;
    title.addEventListener('change', function () { Store.setTitle(title.value.trim() || '無題の作品'); });

    const fps = document.getElementById('setting-fps');
    fillSelect(fps, C.FPS_OPTIONS, Store.settings().fps);
    fps.addEventListener('change', function () {
      Store.setFps(parseInt(fps.value, 10));
      U.toast('秒数が変わらないように、尺のコマ数を' + fps.value + 'fpsに換算しました');
    });

    const aspect = document.getElementById('setting-aspect');
    fillSelect(aspect, C.ASPECT_OPTIONS, Store.settings().aspect);
    aspect.addEventListener('change', function () { Store.setSetting('aspect', aspect.value); });
  }

  function setupToolbar() {
    const btnChild = document.getElementById('btn-add-child');
    const btnPeel = document.getElementById('btn-peel');
    const btnDraw = document.getElementById('btn-draw');
    btnDraw.addEventListener('click', function () { if (MapView.selected()) AP.Draw.open(MapView.selected()); });
    document.getElementById('btn-add').addEventListener('click', function () { MapView.createAtCenter(); });
    btnChild.addEventListener('click', function () { MapView.addChildOfSelected(); });
    btnPeel.addEventListener('click', function () { MapView.peel(MapView.selected()); });
    document.getElementById('btn-fit').addEventListener('click', function () { MapView.fit(); });
    document.getElementById('btn-zoom-in').addEventListener('click', function () { MapView.zoomBy(1.25); });
    document.getElementById('btn-zoom-out').addEventListener('click', function () { MapView.zoomBy(0.8); });

    const update = function () {
      const has = !!MapView.selected();
      btnChild.disabled = !has;
      btnDraw.disabled = !has;
      btnPeel.disabled = !has;
    };
    document.addEventListener('ap:select', update);
    update();
  }

  function setupTabs() {
    document.querySelectorAll('.view-tabs .tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const v = btn.dataset.view;
        if (MapView.isEditing()) MapView.finishEdit();
        if (v !== 'vconte') AP.Vconte.hide();
        document.body.dataset.view = v;
        document.querySelectorAll('.view-tabs .tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
        if (v === 'vconte') AP.Vconte.show();
        else AP.Timeline.render();
      });
    });
  }

  function setupKeys() {
    document.addEventListener('keydown', function (e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || MapView.isEditing() || AP.Draw.isOpen()) return;
      if (document.body.dataset.view === 'vconte') return AP.Vconte.onKey(e);
      const sel = MapView.selected();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); MapView.addNextCard();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault(); MapView.peel(sel);
      } else if (e.key === 'Tab' && sel) {
        e.preventDefault(); MapView.addChildOfSelected();
      } else if ((e.key === 'Enter' || e.key === 'F2') && sel) {
        e.preventDefault(); MapView.startEdit(sel);
      } else if (e.key === 'Escape') {
        MapView.select(null);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault(); MapView.fit();
      }
    });
  }

  async function start() {
    // ページ自体のピンチズーム（Safari）を止める。マップのズームは map.js が処理する
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

    const backend = await Storage.init();
    Storage.onStatus(setStatus);

    let saved = null;
    try {
      saved = await Storage.loadCurrent();
    } catch (e) {
      console.error(e);
      U.toast('保存データの読み込みに失敗しました');
    }
    Store.load(saved || Store.newProject());

    MapView.init();
    AP.Tray.init();
    AP.Timeline.init();
    AP.Draw.init();
    AP.Vconte.init();
    setupHeader();
    setupTabs();
    setupToolbar();
    setupKeys();
    MapView.fit();

    Store.subscribe(function () { Storage.schedule(Store.project()); });
    if (!saved) Storage.schedule(Store.project());

    if (backend === 'indexeddb') setStatus('saved', '自動保存：ブラウザ内（IndexedDB）');
    else if (backend === 'localstorage') setStatus('warn', '自動保存：簡易モード（localStorage）');
    else setStatus('error', 'このブラウザでは自動保存できません！');

    // タブを閉じる・隠す直前に、待っている保存を済ませる
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') Storage.flush();
    });
    window.addEventListener('pagehide', function () { Storage.flush(); });
  }

  start();
})();
