/*
 * AP.Storage：自動保存。
 * IndexedDB → localStorage → メモリのみ、の順に使えるものを使う。
 * 保存できない状態は status 表示を赤くして知らせる（作品が消えないことが最優先）。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const DB_NAME = 'anime-prepro';
  const DB_VERSION = 1;
  const LS_PREFIX = 'anime-prepro:';
  const IDB_OPEN_TIMEOUT_MS = 3000;

  let backend = 'memory';
  let db = null;
  let timer = null;
  let pending = null;
  let onStatus = function () {};

  function openIDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDBなし'));
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDBがブロックされました')); };
      // Safariなどで open が返ってこないことがあるので、待ちすぎたら諦めて次の手段へ
      setTimeout(function () { reject(new Error('IndexedDBの応答がありません')); }, IDB_OPEN_TIMEOUT_MS);
    });
  }

  function idb(storeName, mode, fn) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      const req = fn(store);
      if (req) req.onsuccess = function () { result = req.result; };
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('保存が中断されました')); };
    });
  }

  function lsAvailable() {
    try {
      localStorage.setItem(LS_PREFIX + 'test', '1');
      localStorage.removeItem(LS_PREFIX + 'test');
      return true;
    } catch (e) { return false; }
  }

  const St = {};

  St.backend = function () { return backend; };
  St.onStatus = function (fn) { onStatus = fn; };

  St.init = async function () {
    try {
      db = await openIDB();
      backend = 'indexeddb';
    } catch (e) {
      console.warn('IndexedDBが使えません', e);
      backend = lsAvailable() ? 'localstorage' : 'memory';
    }
    // ブラウザに「勝手に消さないで」と頼む（効くかはブラウザ次第）
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
    return backend;
  };

  St.loadCurrent = async function () {
    if (backend === 'indexeddb') {
      const id = await idb('meta', 'readonly', function (s) { return s.get('currentProjectId'); });
      if (!id) return null;
      return (await idb('projects', 'readonly', function (s) { return s.get(id); })) || null;
    }
    if (backend === 'localstorage') {
      const id = localStorage.getItem(LS_PREFIX + 'current');
      const json = id && localStorage.getItem(LS_PREFIX + 'project:' + id);
      return json ? JSON.parse(json) : null;
    }
    return null;
  };

  St.saveNow = async function (project) {
    const data = JSON.parse(JSON.stringify(project));
    if (backend === 'indexeddb') {
      await idb('projects', 'readwrite', function (s) { return s.put(data); });
      await idb('meta', 'readwrite', function (s) { return s.put(data.id, 'currentProjectId'); });
    } else if (backend === 'localstorage') {
      localStorage.setItem(LS_PREFIX + 'project:' + data.id, JSON.stringify(data));
      localStorage.setItem(LS_PREFIX + 'current', data.id);
    } else {
      memory.set(data.id, data);
      throw new Error('このブラウザでは自動保存できません');
    }
  };

  // ---- 複数のプロジェクト ----
  const memory = new Map(); // 保存できない環境でも、開いている間は切り替えられるように

  function summary(p) {
    const cuts = (p.cards || []).filter(function (c) { return c.timelineOrder !== null && c.status === 'active' && !c.joinPrev; }).length; // 同じカットの続きは数えない
    return { id: p.id, title: p.title || '無題の作品', updatedAt: p.updatedAt || 0, createdAt: p.createdAt || 0,
      cards: (p.cards || []).filter(function (c) { return !c.linkOf; }).length, cuts: cuts };
  }

  // このブラウザにあるプロジェクトの一覧（新しく更新した順）
  St.listProjects = async function () {
    let all = [];
    if (backend === 'indexeddb') {
      all = (await idb('projects', 'readonly', function (s) { return s.getAll(); })) || [];
    } else if (backend === 'localstorage') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX + 'project:') === 0) {
          try { all.push(JSON.parse(localStorage.getItem(k))); } catch (e) { /* 壊れたものは飛ばす */ }
        }
      }
    } else {
      all = Array.from(memory.values());
    }
    return all.map(summary).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  };

  St.loadProject = async function (id) {
    if (backend === 'indexeddb') return (await idb('projects', 'readonly', function (s) { return s.get(id); })) || null;
    if (backend === 'localstorage') {
      const json = localStorage.getItem(LS_PREFIX + 'project:' + id);
      return json ? JSON.parse(json) : null;
    }
    return memory.get(id) || null;
  };

  St.deleteProject = async function (id) {
    if (backend === 'indexeddb') await idb('projects', 'readwrite', function (s) { return s.delete(id); });
    else if (backend === 'localstorage') localStorage.removeItem(LS_PREFIX + 'project:' + id);
    memory.delete(id);
  };

  St.schedule = function (project) {
    pending = project;
    onStatus('dirty', '未保存の変更あり…');
    clearTimeout(timer);
    timer = setTimeout(St.flush, C.AUTOSAVE_DELAY_MS);
  };

  St.flush = async function () {
    clearTimeout(timer);
    if (!pending) return;
    const p = pending;
    pending = null;
    try {
      await St.saveNow(p);
      const name = backend === 'indexeddb' ? 'ブラウザ内' : '簡易保存';
      onStatus('saved', '保存済み（' + name + '） ' + U.timeLabel());
    } catch (e) {
      console.error(e);
      onStatus('error', '保存できません：' + (e && e.message ? e.message : e));
    }
  };

  AP.Storage = St;
})();
