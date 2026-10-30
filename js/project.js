/*
 * AP.Project：プロジェクトの管理。
 * - このブラウザの中に複数のプロジェクトを持てる（新規・開く・複製・削除）。
 * - 「ファイルに保存」：zip（project.json＋各カットの絵のPNG＋説明）を書き出す。バックアップ・別の端末へ移すとき用。
 * - 「ファイルから開く」：書き出したzip（またはproject.json）を読み込む。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;
  const Storage = AP.Storage;

  let back = null, listEl, infoEl, fileInput;

  // ------------------------------------------------------------
  // 切り替え
  // ------------------------------------------------------------
  async function switchTo(p) {
    if (AP.Draw.isOpen()) AP.Draw.close();
    if (AP.Camera.isOpen()) AP.Camera.close();
    AP.Vconte.hide();
    if (AP.MapView.isEditing()) AP.MapView.finishEdit();
    await Storage.flush();            // 今のプロジェクトの書きかけを先に保存
    Store.load(p);
    Storage.schedule(Store.project()); // 「最後に開いたプロジェクト」として保存
    await Storage.flush();
    document.dispatchEvent(new CustomEvent('ap:projectloaded'));
  }

  async function saveQuietly(p) {
    try { await Storage.saveNow(p); } catch (e) { /* 保存できない環境でもメモリには残る */ }
  }

  async function createNew() {
    const p = Store.newProject();
    await saveQuietly(p);
    await switchTo(p);
    close();
    U.toast('新しいプロジェクトを作りました。作品名は左上で変えられます');
  }

  async function openProject(id) {
    const p = await Storage.loadProject(id);
    if (!p) return U.toast('プロジェクトが見つかりません');
    await switchTo(p);
    close();
    U.toast('「' + (p.title || '無題の作品') + '」を開きました');
  }

  async function duplicate(id) {
    await Storage.flush();
    const p = await Storage.loadProject(id);
    if (!p) return;
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = U.uid();
    copy.title = (p.title || '無題の作品') + ' のコピー';
    copy.createdAt = copy.updatedAt = Date.now();
    await saveQuietly(copy);
    U.toast('「' + copy.title + '」を作りました');
    renderList();
  }

  async function remove(id, title) {
    const v = await U.choose('「' + title + '」を削除しますか？',
      'このブラウザから消えます。ファイルに保存していなければ、元に戻せません。', [
        { label: '削除する', value: 'delete' },
      ]);
    if (v !== 'delete') return;
    const wasCurrent = Store.project().id === id;
    await Storage.deleteProject(id);
    if (wasCurrent) {
      const rest = await Storage.listProjects();
      const next = rest.length ? await Storage.loadProject(rest[0].id) : Store.newProject();
      if (!rest.length) await saveQuietly(next);
      await switchTo(next);
    }
    U.toast('削除しました');
    renderList();
  }

  // ------------------------------------------------------------
  // ファイルに保存（zip）
  // ------------------------------------------------------------
  function safeName(s) {
    return String(s || '無題の作品').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  }

  function stamp(d) {
    const z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes());
  }

  function canvasBytes(cv) {
    return new Promise(function (resolve) {
      cv.toBlob(function (b) {
        if (!b) return resolve(null);
        b.arrayBuffer().then(function (ab) { resolve(new Uint8Array(ab)); });
      }, 'image/png');
    });
  }

  async function buildZip() {
    await Storage.flush();
    await AP.Draw.imagesReady();
    const p = Store.project();
    p.lastExportedAt = Date.now();
    const files = [{ name: 'project.json', data: JSON.stringify(p) }];
    // 各カットの最初のコマをPNGに（ほかのソフトで見たり、資料に使ったりできるように）
    const ratio = U.aspectRatio(p.settings.aspect);
    const cv = document.createElement('canvas');
    cv.width = C.EXPORT_IMAGE_W;
    cv.height = Math.round(C.EXPORT_IMAGE_W / ratio);
    const ctx = cv.getContext('2d');
    const list = Store.playlist(); // Vコンテのシーン構成の順
    for (let i = 0; i < list.length; i++) {
      AP.Vconte.renderCut(ctx, cv.width, cv.height, list[i].card, 0, i, { overlays: false });
      const bytes = await canvasBytes(cv);
      const name = 'S' + String(list[i].sceneNo).padStart(2, '0') + '_C' + String(list[i].cutNo).padStart(3, '0') +
        (list[i].parts > 1 ? '-' + list[i].part : ''); // 同じカットの絵が続くときは -1, -2…
      if (bytes) files.push({ name: 'images/' + name + '.png', data: bytes });
    }
    files.push({ name: 'はじめに読んでください.txt', data:
      C.APP_NAME + 'の作品ファイルです。\r\n' +
      'アプリの「📁 プロジェクト」→「ファイルから開く」で、このzipをそのまま選ぶと読み込めます。\r\n' +
      '（解凍しなくて大丈夫です。中の project.json が作品のデータ、images はカットの絵です）\r\n\r\n' +
      '作品名：' + (p.title || '') + '\r\n保存日時：' + new Date().toLocaleString() + '\r\n' });
    Storage.schedule(p);
    return { blob: AP.Zip.create(files), name: safeName(p.title) + '_' + stamp(new Date()) + '.zip' };
  }

  async function exportFile() {
    try {
      const z = await buildZip();
      const url = URL.createObjectURL(z.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = z.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      U.toast('「' + z.name + '」を保存しました（ダウンロードフォルダ／ファイル）');
      if (back && !back.hidden) renderList();
    } catch (e) {
      console.error(e);
      U.toast('ファイルに保存できませんでした：' + e.message);
    }
  }

  // ------------------------------------------------------------
  // ファイルから開く
  // ------------------------------------------------------------
  async function parseFile(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    let json;
    if (head[0] === 0x50 && head[1] === 0x4b) {   // "PK"＝zip
      const files = await AP.Zip.read(buf);
      const key = Object.keys(files).find(function (k) { return /(^|\/)project\.json$/.test(k); });
      if (!key) throw new Error('zipの中に project.json がありません');
      json = new TextDecoder().decode(files[key]);
    } else {
      json = new TextDecoder().decode(new Uint8Array(buf));
    }
    let p;
    try { p = JSON.parse(json); } catch (e) { throw new Error(C.APP_NAME + 'の作品ファイル（zip／json）ではありません'); }
    if (!p || !Array.isArray(p.cards)) throw new Error(C.APP_NAME + 'の作品ファイルではありません');
    return p;
  }

  async function importFile(file) {
    let p;
    try {
      p = await parseFile(file);
    } catch (e) {
      console.warn(e);
      return U.toast('読み込めませんでした：' + e.message);
    }
    const exists = p.id && (await Storage.loadProject(p.id));
    if (!p.id) p.id = U.uid();
    if (exists) {
      const v = await U.choose('同じプロジェクトがこのブラウザにあります',
        '「' + (exists.title || '無題の作品') + '」（更新 ' + new Date(exists.updatedAt).toLocaleString() + '）\n' +
        '読み込むファイル：「' + (p.title || '無題の作品') + '」（更新 ' + new Date(p.updatedAt || 0).toLocaleString() + '）', [
          { label: '別のプロジェクトとして開く', value: 'copy', primary: true },
          { label: '上書きする', value: 'overwrite' },
        ]);
      if (!v) return;
      if (v === 'copy') {
        p.id = U.uid();
        p.title = (p.title || '無題の作品') + '（読み込み）';
      }
    }
    await saveQuietly(p);
    await switchTo(p);
    close();
    U.toast('「' + (p.title || '無題の作品') + '」を読み込みました');
  }

  // ------------------------------------------------------------
  // パネル
  // ------------------------------------------------------------
  async function renderList() {
    if (!back) return;
    const cur = Store.project();
    const last = cur.lastExportedAt;
    infoEl.textContent = '作品はこのブラウザの中に自動で保存されています。バックアップや別の端末へ移すときは「ファイルに保存」を使ってください。' +
      (last ? '（この作品を最後にファイルに保存：' + new Date(last).toLocaleString() + '）' : '（この作品はまだファイルに保存していません）');
    await Storage.flush();
    const list = await Storage.listProjects();
    if (!list.some(function (x) { return x.id === cur.id; })) list.unshift({ id: cur.id, title: cur.title, updatedAt: cur.updatedAt, cards: 0, cuts: 0 });
    listEl.innerHTML = '';
    list.forEach(function (it) {
      const isCur = it.id === cur.id;
      const row = document.createElement('div');
      row.className = 'pj-row' + (isCur ? ' current' : '');
      row.dataset.id = it.id;
      const t = document.createElement('div');
      t.className = 'pj-main';
      const name = document.createElement('div');
      name.className = 'pj-title';
      name.textContent = (it.title || '無題の作品') + (isCur ? '（開いています）' : '');
      const meta = document.createElement('div');
      meta.className = 'pj-meta';
      meta.textContent = '更新 ' + new Date(it.updatedAt).toLocaleString() + '　カード' + it.cards + '枚・' + it.cuts + 'カット';
      t.appendChild(name);
      t.appendChild(meta);
      row.appendChild(t);
      const btn = function (label, fn, cls) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener('click', fn);
        row.appendChild(b);
      };
      if (!isCur) btn('開く', function () { openProject(it.id); }, 'primary');
      btn('複製', function () { duplicate(it.id); });
      btn('削除', function () { remove(it.id, it.title || '無題の作品'); }, 'danger');
      listEl.appendChild(row);
    });
  }

  function open() {
    if (!back) createDom();
    back.hidden = false;
    renderList();
  }

  function close() { if (back) back.hidden = true; }

  function createDom() {
    back = document.createElement('div');
    back.className = 'dialog-back pj-back';
    back.hidden = true;
    back.innerHTML =
      '<div class="dialog pj-dialog" role="dialog">' +
      '  <div class="dialog-title">プロジェクト</div>' +
      '  <div class="pj-actions">' +
      '    <button type="button" class="pj-new">＋ 新しいプロジェクト</button>' +
      '    <button type="button" class="pj-export primary">💾 ファイルに保存</button>' +
      '    <button type="button" class="pj-import">📂 ファイルから開く</button>' +
      '  </div>' +
      '  <p class="pj-info"></p>' +
      '  <div class="pj-label">このブラウザにあるプロジェクト</div>' +
      '  <div class="pj-list"></div>' +
      '  <div class="dialog-buttons"><button type="button" class="pj-close">閉じる</button></div>' +
      '</div>';
    document.body.appendChild(back);
    listEl = back.querySelector('.pj-list');
    infoEl = back.querySelector('.pj-info');
    back.querySelector('.pj-new').addEventListener('click', createNew);
    back.querySelector('.pj-export').addEventListener('click', exportFile);
    back.querySelector('.pj-import').addEventListener('click', function () { fileInput.click(); });
    back.querySelector('.pj-close').addEventListener('click', close);
    back.addEventListener('pointerdown', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function (e) {
      if (back.hidden || document.querySelector('.dialog-back:not(.pj-back):not([hidden])')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }, true);
  }

  function init() {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.zip,.json,application/zip,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) importFile(f);
    });
    document.body.appendChild(fileInput);
    document.getElementById('btn-project').addEventListener('click', open);
    document.getElementById('btn-save').addEventListener('click', exportFile);
    // ⌘S／Ctrl+S でファイルに保存（ブラウザの「ページを保存」の代わりに）
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportFile();
      }
    }, true);
  }

  AP.Project = {
    init: init,
    open: open,
    close: close,
    isOpen: function () { return !!back && !back.hidden; },
    exportFile: exportFile,
    importFile: importFile,
    buildZip: buildZip,
    createNew: createNew,
    openProject: openProject,
  };
})();
