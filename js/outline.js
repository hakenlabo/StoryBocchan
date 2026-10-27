/*
 * AP.Outline：箇条書きモード。マップと同じカードを、1行＝1カードの箇条書きで見る。
 * - 字下げ＝親子（parentId）、行の順番＝treeOrder。マップの座標とは別に持つ。
 * - Enter 次の行、Tab 字下げ、Shift+Tab 字上げ、空の行で Backspace 消す、⌥↑↓ 並べ替え。
 * - 入力中は行を作り直さない（作り直すとカーソルが飛ぶため）。構造が変わったときだけ全体を作り直し、フォーカスを戻す。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;
  const NEW_ROW = '__new';

  let section, list;
  let selfUpdate = false;   // 自分の入力による更新では作り直さない
  let rebuilding = false;   // 作り直し中の blur は無視
  let focusAfter = null;    // 次に作り直したときにフォーカスする { id, caret }
  let lastFocusedId = null;
  const newIds = new Set(); // ここで作った行（空のまま離れたら消す）
  let lastKeyCopy = 0;      // キーで行をコピーした時刻（copyイベントとの二重処理を防ぐ）

  function isVisible() { return document.body.dataset.view === 'outline'; }

  function rows() {
    const out = [];
    (function walk(parentId, depth) {
      Store.treeChildren(parentId).forEach(function (c) {
        out.push({ card: c, depth: depth });
        walk(c.id, depth + 1);
      });
    })(null, 0);
    return out;
  }

  // ------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------
  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function rowEl(r, tl) {
    const c = r.card;
    const el = document.createElement('div');
    el.className = 'ol-row';
    el.dataset.id = c.id;
    el.style.setProperty('--depth', r.depth);
    const meta = [];
    if (tl.has(c.id)) meta.push(tl.get(c.id).map(function (i) { return '#' + i; }).join(' '));
    if (c.strokes.length) meta.push('✎');
    if (c.note) meta.push('💬');
    el.innerHTML =
      '<span class="ol-bullet" title="マップで選択"></span>' +
      '<textarea class="ol-text" rows="1" placeholder="（空の行）"></textarea>' +
      '<span class="ol-meta"></span>';
    el.querySelector('.ol-text').value = c.text;
    const col = Store.colorOf(c);
    if (col) {
      el.classList.add('colored');
      el.style.setProperty('--row-bg', col.bg);
      el.style.setProperty('--row-dot', col.line);
    }
    el.querySelector('.ol-meta').textContent = meta.join('  ');
    return el;
  }

  function newRowEl() {
    const el = document.createElement('div');
    el.className = 'ol-row ol-new';
    el.dataset.id = NEW_ROW;
    el.style.setProperty('--depth', 0);
    el.innerHTML =
      '<span class="ol-bullet"></span>' +
      '<textarea class="ol-text" rows="1" placeholder="ここに書いて Enter。どんどん書き出そう（Tabで字下げ）"></textarea>';
    return el;
  }

  function render() {
    if (!isVisible()) return;
    let keep = focusAfter;
    focusAfter = null;
    const a = document.activeElement;
    if (!keep && a && a.classList && a.classList.contains('ol-text')) {
      keep = { id: a.closest('.ol-row').dataset.id, caret: a.selectionStart };
    }
    const tl = Store.cutNumbers();
    rebuilding = true;
    list.innerHTML = '';
    rows().forEach(function (r) { list.appendChild(rowEl(r, tl)); });
    list.appendChild(newRowEl());
    list.querySelectorAll('.ol-text').forEach(grow);
    rebuilding = false;
    if (keep) focusRow(keep.id, keep.caret);
  }

  function focusRow(id, caret) {
    const row = list.querySelector('.ol-row[data-id="' + id + '"]');
    if (!row) return;
    const ta = row.querySelector('.ol-text');
    ta.focus();
    const pos = caret === undefined || caret === null ? ta.value.length : Math.min(caret, ta.value.length);
    ta.setSelectionRange(pos, pos);
  }

  // ------------------------------------------------------------
  // 構造の操作
  // ------------------------------------------------------------
  function context(id) {
    const card = Store.get(id);
    const parentId = Store.treeParentId(card);
    const sibs = Store.treeChildren(parentId);
    return { card: card, parentId: parentId, sibs: sibs, idx: sibs.findIndex(function (c) { return c.id === id; }) };
  }

  // マップ上の置き場所：親がいれば親の右、いなければいちばん下
  function placeOnMap(id, parentId) {
    if (parentId) return AP.MapView.autoPlace(id, parentId);
    let x = null, y = -Infinity;
    Store.activeCards().forEach(function (c) {
      if (c.id === id) return;
      if (!Store.treeParentId(c) && x === null) x = c.mapPos.x;
      y = Math.max(y, c.mapPos.y + AP.MapView.cardH(c.id));
    });
    Store.moveCards({ [id]: { x: x === null ? 0 : x, y: y === -Infinity ? 0 : y + C.CHILD_GAP_Y } });
  }

  function addRow(parentId, index, text, caret) {
    const card = Store.createCard({ text: text || '', parentId: parentId });
    placeOnMap(card.id, parentId);
    newIds.add(card.id);
    focusAfter = { id: card.id, caret: caret || 0 };
    Store.moveInTree(card.id, parentId, index); // ← ここで作り直してフォーカス
    return card;
  }

  function indent(id) {
    const x = context(id);
    if (x.idx <= 0) return U.toast('上に同じ階層の行がないので字下げできません');
    const newParent = x.sibs[x.idx - 1];
    focusAfter = { id: id, caret: caretOf(id) };
    Store.moveInTree(id, newParent.id, Store.treeChildren(newParent.id).length);
    AP.MapView.autoPlace(id, newParent.id);
  }

  function outdent(id) {
    const x = context(id);
    if (!x.parentId) return;
    const parent = Store.get(x.parentId);
    const grand = Store.treeParentId(parent);
    const pIdx = Store.treeChildren(grand).findIndex(function (c) { return c.id === parent.id; });
    focusAfter = { id: id, caret: caretOf(id) };
    Store.moveInTree(id, grand, pIdx + 1);
    if (grand) AP.MapView.autoPlace(id, grand);
  }

  function move(id, delta) {
    const x = context(id);
    const to = x.idx + delta;
    if (to < 0 || to >= x.sibs.length) return;
    focusAfter = { id: id, caret: caretOf(id) };
    Store.moveInTree(id, x.parentId, to);
  }

  function removable(c) {
    return !c.text && !c.strokes.length && !Store.children(c.id).length && c.timelineOrder === null &&
      !Store.cards().some(function (l) { return l.linkOf === c.id; });
  }

  function caretOf(id) {
    const ta = list.querySelector('.ol-row[data-id="' + id + '"] .ol-text');
    return ta ? ta.selectionStart : 0;
  }

  function visibleIds() {
    return Array.prototype.map.call(list.querySelectorAll('.ol-row'), function (r) { return r.dataset.id; });
  }

  function focusNeighbor(id, delta) {
    const ids = visibleIds();
    const i = ids.indexOf(id) + delta;
    if (i >= 0 && i < ids.length) focusRow(ids[i], delta < 0 ? null : 0);
  }

  // ------------------------------------------------------------
  // 入力
  // ------------------------------------------------------------
  // 行ごとのコピー・切り取り（文字を選んでいないときだけ。選んでいればふつうの文字のコピー）
  function copyRow(id) {
    const c = AP.Clipboard.copyRow(id);
    if (c) U.toast('行をコピーしました（' + c.items.length + '行）');
    return c;
  }

  function cutRow(id) {
    const c = AP.Clipboard.copyRow(id);
    if (!c) return;
    const ids = visibleIds();
    const after = ids.slice(ids.indexOf(id) + 1).find(function (x) { return x === NEW_ROW || !Store.isAncestorOrSelf(id, x); });
    const before = ids[ids.indexOf(id) - 1];
    focusAfter = after && after !== NEW_ROW ? { id: after, caret: 0 } : (before ? { id: before, caret: null } : { id: NEW_ROW, caret: 0 });
    newIds.delete(id);
    AP.MapView.peel(id);
    U.toast('行を切り取りました（' + c.items.length + '行。保留トレイにもあります）');
  }

  // この行の下に、コピーした行を同じ階層で入れる
  function pasteRowsAfter(id) {
    let parentId = null, index = Store.treeChildren(null).length, emptyId = null;
    if (id && id !== NEW_ROW && Store.get(id)) {
      const x = context(id);
      parentId = x.parentId;
      index = x.idx + 1;
      if (!x.card.text && removable(x.card)) { emptyId = id; index = x.idx; }
    }
    if (emptyId) { newIds.delete(emptyId); Store.removeCard(emptyId); }
    const created = AP.Clipboard.pasteCardsAt(parentId, index);
    if (created.length) {
      focusAfter = { id: created[0].id, caret: null };
      render();
    }
    return created;
  }

  function hasSelection(ta) { return ta.selectionStart !== ta.selectionEnd; }

  function onKeyDown(e) {
    const ta = e.target;
    if (!ta.classList.contains('ol-text')) return;
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return; // 日本語変換中
    const id = ta.closest('.ol-row').dataset.id;

    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && id !== NEW_ROW && !hasSelection(ta)) {
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); copyRow(id); return; }
      if (k === 'x') { e.preventDefault(); cutRow(id); return; }
    }

    if (id === NEW_ROW) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) return;
        const card = Store.createCard({ text: text });
        placeOnMap(card.id, null);
        focusAfter = { id: NEW_ROW, caret: 0 };
        Store.moveInTree(card.id, null, Store.treeChildren(null).length);
      } else if (e.key === 'Tab') {
        e.preventDefault();
      } else if (e.key === 'ArrowUp' && ta.selectionStart === 0) {
        e.preventDefault();
        focusNeighbor(id, -1);
      }
      return;
    }

    const x = context(id);
    const firstLine = ta.value.lastIndexOf('\n', ta.selectionStart - 1) === -1;
    const lastLine = ta.value.indexOf('\n', ta.selectionEnd) === -1;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // 空の行で Enter：字上げ（よくある箇条書きの動き）
      if (!ta.value.trim() && x.parentId) return outdent(id);
      const before = ta.value.slice(0, ta.selectionStart);
      const after = ta.value.slice(ta.selectionEnd);
      if (!before && after) {
        // 行頭で Enter：上に空の行
        addRow(x.parentId, x.idx, '', 0);
        return;
      }
      // カーソルの後ろの文字は次の行へ
      if (after) {
        selfUpdate = true;
        Store.updateCard(id, { text: before });
        selfUpdate = false;
      }
      addRow(x.parentId, x.idx + 1, after, 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.shiftKey ? outdent(id) : indent(id);
    } else if (e.key === 'Backspace' && !ta.value && ta.selectionStart === 0) {
      e.preventDefault();
      if (!removable(x.card)) return U.toast('子の行や絵があるので消せません（剥がすならマップで）');
      const ids = visibleIds();
      const prev = ids[ids.indexOf(id) - 1];
      newIds.delete(id);
      focusAfter = prev ? { id: prev, caret: null } : { id: NEW_ROW, caret: 0 };
      Store.removeCard(id);
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault(); move(id, -1);
    } else if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault(); move(id, 1);
    } else if (e.key === 'ArrowUp' && firstLine) {
      e.preventDefault(); focusNeighbor(id, -1);
    } else if (e.key === 'ArrowDown' && lastLine) {
      e.preventDefault(); focusNeighbor(id, 1);
    }
  }

  function onInput(e) {
    const ta = e.target;
    if (!ta.classList.contains('ol-text')) return;
    grow(ta);
    const id = ta.closest('.ol-row').dataset.id;
    if (id === NEW_ROW) return;
    selfUpdate = true;
    Store.updateCard(id, { text: ta.value });
    selfUpdate = false;
  }

  function onFocusIn(e) {
    const row = e.target.closest && e.target.closest('.ol-row');
    if (!row) return;
    lastFocusedId = row.dataset.id;
    if (row.dataset.id !== NEW_ROW && AP.MapView.selected() !== row.dataset.id) AP.MapView.select(row.dataset.id);
  }

  function onFocusOut(e) {
    if (rebuilding) return;
    const row = e.target.closest && e.target.closest('.ol-row');
    if (!row) return;
    const id = row.dataset.id;
    if (id === NEW_ROW) {
      // 書きかけのまま離れたら、その文字もカードにする
      const text = e.target.value.trim();
      if (text) {
        const card = Store.createCard({ text: text });
        placeOnMap(card.id, null);
        Store.moveInTree(card.id, null, Store.treeChildren(null).length);
      }
      return;
    }
    if (!newIds.has(id)) return;
    newIds.delete(id);
    const c = Store.get(id);
    if (C.REMOVE_EMPTY_NEW_CARD && c && removable(c)) {
      setTimeout(function () { if (Store.get(id) && removable(Store.get(id))) Store.removeCard(id); }, 0);
    }
  }

  // 貼り付け：コピーした行ならこの行の下へ。複数行の文字は1行＝1行（字下げも読む）として今の行の後ろへ
  function onPaste(e) {
    const ta = e.target;
    if (!ta.classList || !ta.classList.contains('ol-text')) return;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (AP.Clipboard.isOwnCards(text) && !hasSelection(ta)) {
      e.preventDefault();
      const created = pasteRowsAfter(ta.closest('.ol-row').dataset.id);
      if (created.length) U.toast(created.length + '行を貼り付けました');
      return;
    }
    if (text.indexOf('\n') === -1) return; // 1行ならふつうに貼る
    e.preventDefault();
    const lines = AP.Clipboard.parseLines(text);
    if (!lines.length) return;
    const id = ta.closest('.ol-row').dataset.id;
    let parentId = null, index = Store.treeChildren(null).length, emptyId = null;
    if (id !== NEW_ROW) {
      const x = context(id);
      parentId = x.parentId;
      index = x.idx + 1;
      if (!ta.value && removable(x.card)) emptyId = id;
    }
    const created = AP.Clipboard.importLines(lines, { parentId: parentId, index: index });
    if (emptyId) Store.removeCard(emptyId);
    if (created.length) {
      focusAfter = { id: created[created.length - 1].id, caret: null };
      render();
      U.toast(created.length + '行を貼り付けました');
    }
  }

  // iPad向けのボタン。押してもフォーカスを奪わない
  function setupButtons() {
    section.querySelectorAll('[data-ol]').forEach(function (b) {
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        const id = lastFocusedId;
        if (b.dataset.ol === 'paste' && id === NEW_ROW) {
          if (AP.Clipboard.isOwnCards('')) pasteRowsAfter(NEW_ROW); else U.toast('先に行を「コピー」してください');
          return;
        }
        if (!id || id === NEW_ROW || !Store.get(id)) return U.toast('先に行をタップしてください');
        const act = b.dataset.ol;
        if (act === 'indent') indent(id);
        else if (act === 'outdent') outdent(id);
        else if (act === 'up') move(id, -1);
        else if (act === 'copy') copyRow(id);
        else if (act === 'cut') cutRow(id);
        else if (act === 'paste') {
          if (AP.Clipboard.isOwnCards('')) pasteRowsAfter(id);
          else U.toast('先に行を「コピー」してください');
        }
        else if (act === 'down') move(id, 1);
        else if (act === 'peel') {
          const ids = visibleIds();
          const next = ids[ids.indexOf(id) + 1];
          focusAfter = next ? { id: next, caret: 0 } : null;
          AP.MapView.peel(id);
        }
      });
    });
  }

  // ------------------------------------------------------------
  // 参照テキスト（左のパネル）
  // ------------------------------------------------------------
  const REF_KEY = 'anime-prepro:outlineRef';
  let refEl;
  let refSelf = false;

  function setRefOpen(open) {
    section.classList.toggle('with-ref', open);
    document.getElementById('ol-ref-toggle').classList.toggle('active', open);
    try { localStorage.setItem(REF_KEY, open ? '1' : '0'); } catch (e) { /* 無視 */ }
  }

  function updateRefCount() {
    document.getElementById('ol-ref-count').textContent = refEl.value ? refEl.value.length + '文字' : '';
  }

  // 選んだ文（なければカーソルのある行）を、最後に触った行の下に箇条書きとして入れる
  function sendFromRef() {
    let text = refEl.value.slice(refEl.selectionStart, refEl.selectionEnd);
    if (!text.trim()) {
      const v = refEl.value, p = refEl.selectionStart;
      const s = v.lastIndexOf('\n', p - 1) + 1;
      let e = v.indexOf('\n', p);
      if (e < 0) e = v.length;
      text = v.slice(s, e);
    }
    const lines = AP.Clipboard.parseLines(text);
    if (!lines.length) return U.toast('箇条書きにする文を選んでください');
    let parentId = null, index = Store.treeChildren(null).length;
    if (lastFocusedId && lastFocusedId !== NEW_ROW && Store.get(lastFocusedId) && Store.get(lastFocusedId).status === 'active') {
      const x = context(lastFocusedId);
      parentId = x.parentId;
      index = x.idx + 1;
    }
    Store.checkpoint();
    const created = AP.Clipboard.importLines(lines, { parentId: parentId, index: index });
    Store.checkpoint();
    if (created.length) {
      lastFocusedId = created[created.length - 1].id; // 続けて送ると、その下に並んでいく
      render();
      const row = list.querySelector('.ol-row[data-id="' + lastFocusedId + '"]');
      if (row) row.scrollIntoView({ block: 'nearest' });
      U.toast(created.length + '行を箇条書きに入れました');
    }
  }

  function setupReference() {
    refEl = document.getElementById('ol-ref-text');
    refEl.value = Store.reference();
    updateRefCount();
    let open = false;
    try { open = localStorage.getItem(REF_KEY) === '1'; } catch (e) { /* 無視 */ }
    setRefOpen(open || !!Store.reference());
    document.getElementById('ol-ref-toggle').addEventListener('click', function () {
      setRefOpen(!section.classList.contains('with-ref'));
    });
    refEl.addEventListener('input', function () {
      refSelf = true;
      Store.setReference(refEl.value);
      refSelf = false;
      updateRefCount();
    });
    refEl.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendFromRef(); }
    });
    const sendBtn = document.getElementById('ol-ref-send');
    sendBtn.addEventListener('pointerdown', function (e) { e.preventDefault(); }); // 選んだ範囲を消さない
    sendBtn.addEventListener('click', sendFromRef);
    // テキストファイルを開く
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.txt,.md,text/plain';
    file.style.display = 'none';
    document.body.appendChild(file);
    document.getElementById('ol-ref-open').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      f.text().then(function (t) {
        const apply = function () {
          refEl.value = t.replace(/\r\n?/g, '\n');
          Store.checkpoint();
          Store.setReference(refEl.value);
          Store.checkpoint();
          updateRefCount();
          setRefOpen(true);
          U.toast('「' + f.name + '」を読み込みました');
        };
        if (!refEl.value.trim()) return apply();
        U.choose('参照テキストを置き換えますか？', '今の参照テキスト（' + refEl.value.length + '文字）は「' + f.name + '」に置き換わります（⌘Zで戻せます）。',
          [{ label: '置き換える', value: 'ok', primary: true }]).then(function (v) { if (v === 'ok') apply(); });
      });
    });
    // 取り消しやプロジェクトの切り替えで中身が変わったら合わせる
    Store.subscribe(function (reason) {
      if (refSelf) return;
      if (reason === 'history' || reason === 'load' || reason === 'reference') {
        if (refEl.value !== Store.reference()) { refEl.value = Store.reference(); updateRefCount(); }
        if (reason === 'load' && Store.reference()) setRefOpen(true);
      }
    });
  }

  function show() {
    render();
    if (!list.querySelector('.ol-row:not(.ol-new)')) focusRow(NEW_ROW, 0);
  }

  function init() {
    section = document.getElementById('outline');
    list = document.getElementById('ol-list');
    list.addEventListener('keydown', onKeyDown);
    list.addEventListener('input', onInput);
    list.addEventListener('focusin', onFocusIn);
    list.addEventListener('focusout', onFocusOut);
    list.addEventListener('paste', onPaste);
    // メニューからの「コピー」「カット」でも、文字を選んでいなければ行ごと
    ['copy', 'cut'].forEach(function (type) {
      list.addEventListener(type, function (e) {
        const ta = e.target;
        if (!ta.classList || !ta.classList.contains('ol-text') || hasSelection(ta)) return;
        const id = ta.closest('.ol-row').dataset.id;
        if (id === NEW_ROW) return;
        e.preventDefault();
        if (Date.now() - lastKeyCopy > 300) { type === 'cut' ? cutRow(id) : copyRow(id); }
        if (e.clipboardData) e.clipboardData.setData('text/plain', AP.Clipboard.sigOf());
      });
    });
    list.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && /^[cx]$/i.test(e.key)) lastKeyCopy = Date.now();
    }, true);
    list.addEventListener('click', function (e) {
      const b = e.target.closest('.ol-bullet');
      if (b) focusRow(b.closest('.ol-row').dataset.id);
    });
    setupButtons();
    setupReference();
    Store.subscribe(function (reason) {
      if (!isVisible() || selfUpdate || reason === 'move') return;
      render();
    });
  }

  AP.Outline = { init: init, show: show, render: render };
})();
