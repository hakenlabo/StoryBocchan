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

    // 別のプロジェクトに切り替えたら、見出しと今の画面を作り直す
    document.addEventListener('ap:projectloaded', function () { refreshHeaderAndView(true); });
    document.title = Store.project().title + ' - ' + C.APP_NAME;
    Store.subscribe(function (reason) {
      if (reason === 'title') document.title = Store.project().title + ' - ' + C.APP_NAME;
    });
  }

  // 見出し（作品名・fps・画面比）と今の画面を作り直す。fit＝マップを全体表示にする
  function refreshHeaderAndView(fit) {
    document.getElementById('project-title').value = Store.project().title;
    document.getElementById('setting-fps').value = String(Store.settings().fps);
    document.getElementById('setting-aspect').value = String(Store.settings().aspect);
    document.title = Store.project().title + ' - ' + C.APP_NAME;
    if (fit) MapView.fit();
    const v = document.body.dataset.view;
    if (v === 'vconte') AP.Vconte.show();
    else if (v === 'outline') AP.Outline.show();
    else AP.Timeline.render();
  }

  function setupToolbar() {
    const btnChild = document.getElementById('btn-add-child');
    const btnPeel = document.getElementById('btn-peel');
    const btnDraw = document.getElementById('btn-draw');
    btnDraw.addEventListener('click', function () { if (MapView.selected()) AP.Draw.open(MapView.selected()); });
    document.getElementById('btn-add').addEventListener('click', function () { MapView.createAtCenter(); });
    btnChild.addEventListener('click', function () { MapView.addChildOfSelected(); });
    btnPeel.addEventListener('click', function () { MapView.peelSelection(); });
    // 複数選択（iPad向け。Macは Shift＋クリック）
    document.getElementById('btn-multi').addEventListener('click', function () {
      MapView.setMultiMode(!MapView.multiMode());
      updateMultiButton();
      if (MapView.multiMode()) U.toast('複数選択：タップしたカードが順に選ばれます。選んだカードをタイムラインへドラッグすると、その順に並びます');
    });
    const btnCopy = document.getElementById('btn-copy');
    btnCopy.addEventListener('click', function () { AP.Clipboard.copyButton(); });
    document.getElementById('btn-paste').addEventListener('click', function () { AP.Clipboard.pasteButton(); });
    const btnCut = document.getElementById('btn-cut');
    btnCut.addEventListener('click', function () { AP.Clipboard.cutButton(); });
    document.getElementById('btn-fit').addEventListener('click', function () { MapView.fit(); });
    // 整列メニュー
    const menu = document.getElementById('arrange-menu');
    const snapBox = document.getElementById('snap-toggle');
    document.getElementById('btn-arrange').addEventListener('click', function () {
      snapBox.checked = MapView.snapOn();
      menu.hidden = !menu.hidden;
    });
    menu.querySelectorAll('[data-arrange]').forEach(function (b) {
      b.addEventListener('click', function () {
        menu.hidden = true;
        MapView.arrangeTree();
        MapView.fit();
      });
    });
    snapBox.addEventListener('change', function () { MapView.setSnap(snapBox.checked); });
    document.addEventListener('pointerdown', function (e) {
      if (!menu.hidden && !e.target.closest('.arrange-wrap')) menu.hidden = true;
    });
    document.getElementById('btn-zoom-in').addEventListener('click', function () { MapView.zoomBy(1.25); });
    document.getElementById('btn-zoom-out').addEventListener('click', function () { MapView.zoomBy(0.8); });

    const update = function () {
      const has = !!MapView.selected();
      btnChild.disabled = !has;
      btnDraw.disabled = !has;
      btnCopy.disabled = !has;
      btnCut.disabled = !has;
      btnPeel.disabled = !has;
    };
    document.addEventListener('ap:select', update);
    document.addEventListener('ap:select', updateMultiButton);
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
        else if (v === 'outline') AP.Outline.show();
        else AP.Timeline.render();
      });
    });
  }

  function undo() {
    if (!Store.undo()) U.toast('これ以上取り消せません');
  }
  function redo() {
    if (!Store.redo()) U.toast('やり直せる操作がありません');
  }

  function setupUndo() {
    const bu = document.getElementById('btn-undo');
    const br = document.getElementById('btn-redo');
    bu.addEventListener('click', undo);
    br.addEventListener('click', redo);
    const update = function () { bu.disabled = !Store.canUndo(); br.disabled = !Store.canRedo(); };
    Store.subscribe(function (reason) {
      update();
      if (reason === 'history') refreshHeaderAndView(false);
      // 「元に戻す」付きのお知らせは、ほかの変更があったら引っ込める（違う操作を戻してしまわないように）
      const t = document.getElementById('toast');
      if (t.classList.contains('has-action') && t.dataset.ver !== String(Store.version())) t.classList.remove('show', 'has-action');
    });
    update();
  }

  function updateMultiButton() {
    const b = document.getElementById('btn-multi');
    const n = MapView.multiSelected().length;
    b.classList.toggle('active', MapView.multiMode());
    b.textContent = '☑ 複数選択' + (n ? '（' + n + '）' : '');
  }

  // URL に ?debug=1 を付けると、画面の大きさや拡大率を表示する（iPadで表示がおかしいときの確認用）
  function setupDebug() {
    if (!/[?&]debug=1/.test(location.search)) return;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:999;padding:6px 8px;font:12px/1.5 ui-monospace,Menlo,monospace;' +
      'background:rgba(0,0,0,.8);color:#0f0;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.appendChild(box);
    const show = function () {
      const vv = window.visualViewport;
      box.textContent = 'ver ' + C.APP_VERSION +
        '\ninner ' + innerWidth + 'x' + innerHeight + '  doc ' + document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight +
        '\nscreen ' + screen.width + 'x' + screen.height + '  dpr ' + devicePixelRatio +
        '\nvisual ' + (vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) + ' scale ' + vv.scale.toFixed(3) : '-') +
        '\nviewport ' + (document.getElementById('vp') || {}).content +
        '\n' + navigator.userAgent.slice(0, 90);
    };
    show();
    window.addEventListener('resize', show);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', show);
    setInterval(show, 1000);
  }

  function setupKeys() {
    document.addEventListener('keydown', function (e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || MapView.isEditing() || AP.Draw.isOpen() || AP.Camera.isOpen() || AP.Project.isOpen() || AP.Pdf.isOpen()) return;
      if (document.querySelector('.dialog-back:not([hidden])')) return;
      // 取り消し・やり直し（どの画面でも）
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && !e.altKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (document.body.dataset.view === 'vconte') return AP.Vconte.onKey(e);
      if (document.body.dataset.view === 'outline') return;
      const sel = MapView.selected();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); MapView.addNextCard();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault(); MapView.peelSelection();
      } else if (e.key === 'Tab' && sel) {
        e.preventDefault(); MapView.addChildOfSelected();
      } else if ((e.key === 'Enter' || e.key === 'F2') && sel) {
        e.preventDefault(); MapView.startEdit(sel);
      } else if (e.key === 'Escape') {
        if (MapView.multiMode()) { MapView.setMultiMode(false); updateMultiButton(); }
        MapView.select(null);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault(); MapView.fit();
      } else if (!mod && !e.altKey && document.body.dataset.view === 'map' && e.key.toLowerCase() === 'l') {
        // L：ツリーに整列（⌘Zで戻せる）
        e.preventDefault(); MapView.arrangeTree(); MapView.fit();
      } else if (!mod && !e.altKey && document.body.dataset.view === 'map' && e.key.toLowerCase() === 'g') {
        // G：グリッドに吸着のオン／オフ
        e.preventDefault(); MapView.setSnap(!MapView.snapOn());
      }
    });
  }

  async function start() {
    // ページ自体のピンチズーム（Safari）を止める。マップのズームは map.js が処理する
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    // 入力欄を離れたら、iOS が勝手に拡大した表示を元に戻す（viewport を一度書き換えると等倍に戻る）
    const vpMeta = document.querySelector('meta[name="viewport"]');
    document.addEventListener('focusout', function (e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (!vpMeta || !window.AP_FIT || (tag !== 'input' && tag !== 'textarea' && tag !== 'select')) return;
      vpMeta.setAttribute('content', vpMeta.getAttribute('content').replace('user-scalable=no', 'user-scalable=yes'));
      setTimeout(window.AP_FIT, 50); // index.html の「画面に合わせる」設定に戻す
    });
    setupDebug();

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
    AP.Clipboard.init();
    AP.Outline.init();
    AP.Project.init();
    AP.Pdf.init();
    setupHeader();
    setupTabs();
    setupUndo();
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
