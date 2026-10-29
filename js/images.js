/*
 * AP.Images：写真や絵のファイルを読み込む。
 * - マップ：ツールバーの「🖼 画像」か、ファイルをマップへドラッグ＆ドロップ。1枚＝1カード（card.image）。
 *   読み込んだ順に横に並べ、そのまま複数選択にしておく（タイムラインへドラッグすると、その順に並ぶ）。
 *   カードを1枚選んでいたら（ボタンのとき）、その子として並べる。
 * - 描画パネル：「🖼 画像」かドロップで、今の絵の下に敷く（上から線を描ける。消しゴムでは消えない）。
 * - 画像は長い辺を IMAGE_MAX_PX に縮めた JPEG の data URL として作品データに入る（自動保存・zip にもそのまま入る）。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let input = null;
  let pending = null;

  // ファイルを選ぶ画面を出す → File の配列（やめたときは何も起きない）
  function pick(multiple) {
    return new Promise(function (resolve) {
      input.multiple = !!multiple;
      input.value = '';
      pending = resolve;
      input.click();
    });
  }

  function imageFiles(list) {
    return Array.prototype.filter.call(list || [], function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(f.name);
    });
  }

  async function readAll(files) {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      try { out.push(await AP.Draw.readImageFile(files[i])); } catch (e) { U.toast(e.message); }
    }
    return out;
  }

  // マップに読み込む。at（ワールド座標）を渡すとそこから右へ並べる
  async function importToMap(files, at) {
    files = imageFiles(files);
    if (!files.length) { U.toast('画像のファイルを選んでください'); return []; }
    if (files.length > 1) U.toast('画像を読み込んでいます…');
    const images = await readAll(files);
    if (!images.length) return [];
    const selId = AP.MapView.selected();
    const parent = !at && selId && !AP.MapView.multiSelected().length ? Store.source(Store.get(selId)) : null;
    const start = at || AP.MapView.viewCenter();
    const ids = [];
    // 横一列に並べる。どれかがほかのカードと重なるなら、列ごと下へずらす
    const xs = images.map(function (im, i) { return start.x - C.CARD_W / 2 + i * (C.CARD_W + C.IMAGE_IMPORT_GAP); });
    let y = start.y - C.CARD_H_ESTIMATE / 2;
    for (let n = 0; n < 50; n++) {
      const ny = Math.max.apply(null, xs.map(function (x) { return AP.MapView.freeSpot(x, y).y; }));
      if (ny === y) break;
      y = ny;
    }
    Store.checkpoint();
    images.forEach(function (im, i) {
      const card = Store.createCard({ image: im, parentId: parent ? parent.id : null });
      ids.push(card.id);
      if (parent) AP.MapView.autoPlace(card.id, parent.id);
      else Store.moveCards({ [card.id]: { x: xs[i], y: y } });
    });
    Store.checkpoint();
    // 読み込んだ順に選んでおく（そのままタイムラインへドラッグすると、この順に並ぶ）
    AP.MapView.select(null);
    if (ids.length === 1) AP.MapView.select(ids[0]);
    else ids.forEach(function (id) { AP.MapView.toggleMulti(id); });
    U.toast(ids.length === 1 ? '画像を読み込みました'
      : '画像を' + ids.length + '枚、読み込んだ順に並べました（このままタイムラインへドラッグすると、この順に並びます）');
    return ids;
  }

  // 描画パネルで開いている絵の下に敷く
  async function setDrawImage(files) {
    const id = AP.Draw.editingCardId();
    files = imageFiles(files);
    if (!id || !files.length) return;
    const images = await readAll(files.slice(0, 1));
    if (!images.length) return;
    Store.checkpoint();
    Store.setImage(id, images[0]);
    Store.checkpoint();
  }

  function hasFiles(e) {
    return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
  }

  function allowDrop(el, onDrop) {
    el.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      onDrop(Array.prototype.slice.call(e.dataTransfer.files), e);
    });
  }

  function init() {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      const r = pending;
      pending = null;
      if (r) r(Array.prototype.slice.call(input.files || []));
    });

    document.getElementById('btn-image').addEventListener('click', function () {
      pick(true).then(function (files) { if (files.length) importToMap(files); });
    });
    document.getElementById('draw-image').addEventListener('click', function () {
      pick(false).then(function (files) { if (files.length) setDrawImage(files); });
    });
    document.getElementById('draw-image-clear').addEventListener('click', function () {
      const id = AP.Draw.editingCardId();
      if (!id) return;
      Store.checkpoint();
      Store.setImage(id, null);
      Store.checkpoint();
      U.toast('画像を外しました（線は残っています。⌘Zで戻せます）');
    });

    // ドラッグ＆ドロップ（Mac・Windows）。ほかの所に落としても、ブラウザがファイルを開いて作品の画面から離れないようにする
    allowDrop(document.getElementById('map-viewport'), function (files, e) {
      importToMap(files, AP.MapView.clientToWorld(e.clientX, e.clientY));
    });
    allowDrop(document.getElementById('draw-stage'), function (files) { setDrawImage(files); });
    document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', function (e) { if (hasFiles(e)) e.preventDefault(); });

    // 画像の読み込みが済んだら、サムネイルなどを描き直す
    let timer = 0;
    document.addEventListener('ap:imageloaded', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        AP.MapView.render();
        AP.Timeline.render();
        if (document.body.dataset.view === 'vconte') AP.Vconte.show();
      }, 30);
    });
  }

  AP.Images = { init: init, pick: pick, importToMap: importToMap, readAll: readAll };
})();
