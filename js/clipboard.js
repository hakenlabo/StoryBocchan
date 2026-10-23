/*
 * AP.Clipboard：コピー＆ペースト。
 * - カード：選択中のカードを子孫ごとコピー。貼り付けは選択中のカードの子として（なければ画面の真ん中）。
 * - 絵：描画パネルを開いているときは、そのカードの絵をコピーし、別のカードの絵に重ねて貼り付ける。
 * - 外のテキスト：メモ帳などからの貼り付けは、1行＝1カード（字下げは親子）にする。
 * キーボードは copy/cut/paste イベント、iPad向けにはボタンから同じ処理を呼ぶ。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let clip = null;          // { kind: 'cards'|'strokes', sig: システムのクリップボードに入れた文字, synced, stale, ... }
  let keyCopyAt = 0;        // キー操作でコピーした時刻（copyイベントとの二重処理を防ぐ）
  let pasteTimer = null;

  function isTextField(el) {
    const tag = (el && el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || (el && el.isContentEditable);
  }

  // ------------------------------------------------------------
  // コピー
  // ------------------------------------------------------------
  function copyCards() {
    const selId = AP.MapView.selected();
    const root = selId ? Store.source(Store.get(selId)) : null;
    if (!root || root.status !== 'active') return null;
    const items = [];
    const lines = [];
    (function walk(card, parentIndex, depth) {
      const index = items.length;
      items.push({
        text: card.text,
        strokes: JSON.parse(JSON.stringify(card.strokes)),
        duration: card.duration,
        note: card.note,
        camera: card.camera ? JSON.parse(JSON.stringify(card.camera)) : null,
        paper: { w: card.paper.w, h: card.paper.h },
        parentIndex: parentIndex,
        dx: card.mapPos.x - root.mapPos.x,
        dy: card.mapPos.y - root.mapPos.y,
      });
      lines.push('\t'.repeat(depth) + (card.text || '（無題）').replace(/\s*\n\s*/g, ' '));
      Store.treeChildren(card.id).forEach(function (ch) { walk(ch, index, depth + 1); });
    })(root, -1, 0);
    clip = { kind: 'cards', items: items, sig: lines.join('\n') };
    return clip;
  }

  function copyStrokes() {
    const strokes = AP.Draw.currentStrokes();
    if (!strokes.length) { U.toast('コピーする絵がありません'); return null; }
    clip = { kind: 'strokes', strokes: JSON.parse(JSON.stringify(strokes)), sig: '［アニメ・プリプロの絵：' + strokes.length + '本の線］' };
    return clip;
  }

  function copy() {
    const c = AP.Draw.isOpen() ? copyStrokes() : copyCards();
    if (c) U.toast(c.kind === 'strokes' ? '絵をコピーしました' : 'カードをコピーしました（' + c.items.length + '枚）');
    return c;
  }

  // ------------------------------------------------------------
  // 貼り付け
  // ------------------------------------------------------------
  // 貼り付け先：選択中のカードの子。なければいちばん上の階層で画面の真ん中
  function pasteTarget() {
    const selId = AP.MapView.selected();
    const sel = selId ? Store.source(Store.get(selId)) : null;
    return sel && sel.status === 'active' ? sel : null;
  }

  function pasteCards(items) {
    const parent = pasteTarget();
    const center = AP.MapView.viewCenter();
    const created = [];
    items.forEach(function (it, i) {
      const parentId = it.parentIndex >= 0 ? created[it.parentIndex].id : (parent ? parent.id : null);
      const base = created[0];
      const pos = i === 0
        ? AP.MapView.freeSpot(center.x - C.CARD_W / 2, center.y - C.CARD_H_ESTIMATE / 2)
        : { x: base.mapPos.x + it.dx, y: base.mapPos.y + it.dy };
      created.push(Store.createCard({
        text: it.text, strokes: it.strokes, duration: it.duration, note: it.note, camera: it.camera || null, paper: it.paper || { w: 1, h: 1 },
        parentId: parentId, mapPos: pos,
      }));
    });
    // 親の右に並べる（子孫は相対位置のままついてくる）
    if (parent) AP.MapView.autoPlace(created[0].id, parent.id);
    AP.MapView.select(created[0].id);
    U.toast((parent ? '選択中のカードの子として' : '') + created.length + '枚貼り付けました');
    return created;
  }

  // 箇条書きのテキストを [{depth, text}] に。行頭の「・」「-」「*」「1.」などは取る
  function parseLines(text) {
    const out = [];
    const indents = [];
    text.replace(/\r\n?/g, '\n').split('\n').forEach(function (raw) {
      if (!raw.trim()) return;
      const m = raw.match(/^[ \t　]*/)[0];
      const indent = m.replace(/\t/g, '    ').replace(/　/g, '  ').length;
      while (indents.length && indents[indents.length - 1] >= indent) indents.pop();
      const depth = indents.length;
      indents.push(indent);
      const body = raw.trim().replace(/^([-*・•●○◦□■▪︎]|\d+[.)．、])\s*/, '');
      if (body) out.push({ depth: depth, text: body });
    });
    // 深さが飛んでいたら詰める
    let prev = -1;
    out.forEach(function (l) { l.depth = Math.min(l.depth, prev + 1); prev = l.depth; });
    return out;
  }

  // 行の並びからカードを作る。parentId/afterIndex は箇条書きモードから使う
  function importLines(lines, opts) {
    opts = opts || {};
    const parent = opts.parentId !== undefined ? (opts.parentId ? Store.get(opts.parentId) : null) : pasteTarget();
    const center = AP.MapView.viewCenter();
    const stack = [];           // depth ごとの直近のカード
    const created = [];
    let rootY = center.y - C.CARD_H_ESTIMATE / 2;
    let insertAt = opts.index;  // いちばん上の階層を入れる位置（未指定なら末尾）
    lines.forEach(function (l) {
      const p = l.depth === 0 ? parent : stack[l.depth - 1];
      const card = Store.createCard({
        text: l.text,
        parentId: p ? p.id : null,
        mapPos: p ? { x: center.x, y: rootY } : AP.MapView.freeSpot(center.x - C.CARD_W / 2, rootY),
      });
      if (p) AP.MapView.autoPlace(card.id, p.id);
      else rootY = card.mapPos.y + AP.MapView.cardH(card.id) + C.CHILD_GAP_Y;
      if (l.depth === 0 && insertAt !== undefined) {
        Store.moveInTree(card.id, p ? p.id : null, insertAt);
        insertAt++;
      }
      stack[l.depth] = card;
      stack.length = l.depth + 1;
      created.push(card);
    });
    return created;
  }

  function pasteText(text) {
    const lines = parseLines(text);
    if (!lines.length) return [];
    const created = importLines(lines);
    if (created.length) {
      AP.MapView.select(created[0].id);
      U.toast('テキストから' + created.length + '枚のカードを作りました');
    }
    return created;
  }

  function pasteInternal() {
    if (!clip) return false;
    if (clip.kind === 'strokes') {
      if (!AP.Draw.isOpen()) { U.toast('絵の貼り付けは描画パネルの中で行ってください'); return true; }
      AP.Draw.pasteStrokes(clip.strokes);
      U.toast('絵を貼り付けました（取り消しで戻せます）');
      return true;
    }
    if (AP.Draw.isOpen()) { U.toast('カードの貼り付けは描画パネルを閉じてから行ってください'); return true; }
    pasteCards(clip.items);
    return true;
  }

  // ------------------------------------------------------------
  // イベント
  // ------------------------------------------------------------
  function blocked(e) {
    return e.defaultPrevented || isTextField(e.target) || !!document.querySelector('.dialog-back:not([hidden])');
  }

  // システムのクリップボードにも文字を入れておく（あとで外から貼られたものと区別するため）
  function syncSystem(c) {
    if (c && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(c.sig).then(function () { c.synced = true; }).catch(function () {});
    }
  }

  // ⌘C/⌘X/⌘V。Safariは何も選択していないと copy/paste イベントが来ないことがあるので、キーでも受ける
  function onKeyDown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || blocked(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'c' || k === 'x') {
      const c = copy();
      if (!c) return;
      keyCopyAt = Date.now();
      syncSystem(c);
      if (k === 'x' && c.kind === 'cards') AP.MapView.peel(AP.MapView.selected());
    } else if (k === 'v') {
      // paste イベントが来ればそちらで処理。来なければ自分のコピーを貼る
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(function () { pasteTimer = null; pasteInternal(); }, 80);
    }
  }

  function onCopy(e) {
    if (blocked(e)) return;
    let c = clip;
    if (Date.now() - keyCopyAt > 300) {
      c = copy();   // メニューの「コピー」「カット」から来たとき
      if (!c) return;
      if (e.type === 'cut' && c.kind === 'cards') AP.MapView.peel(AP.MapView.selected());
    }
    if (!c) return;
    e.preventDefault();
    if (e.clipboardData) { e.clipboardData.setData('text/plain', c.sig); c.synced = true; }
  }

  function onPaste(e) {
    if (blocked(e)) return;
    clearTimeout(pasteTimer);
    pasteTimer = null;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    e.preventDefault();
    // 自分でコピーしたもの（またはテキストなし）ならカード・絵として。
    // システムに書き込めなかったときは、ほかのアプリへ行っていない限り自分のコピーを優先
    if (clip && (!text || text === clip.sig || (!clip.synced && !clip.stale))) return pasteInternal();
    if (text) {
      if (AP.Draw.isOpen()) return U.toast('描画パネルには絵だけ貼り付けられます');
      pasteText(text);
    }
  }

  // ボタン（iPadなどキーボードがないとき）
  function copyButton() {
    syncSystem(copy());
  }

  function pasteButton() {
    if (pasteInternal()) return;
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) {
        if (t) pasteText(t); else U.toast('貼り付けるものがありません');
      }).catch(function () { U.toast('先に「コピー」してください'); });
    } else {
      U.toast('先に「コピー」してください');
    }
  }

  function init() {
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    // ほかのアプリへ移ったら、外でコピーされたかもしれないので自分のコピーを優先しない
    window.addEventListener('blur', function () { if (clip) clip.stale = true; });
  }

  AP.Clipboard = {
    init: init,
    copyButton: copyButton,
    pasteButton: pasteButton,
    parseLines: parseLines,
    importLines: importLines,
    hasClip: function () { return !!clip; },
  };
})();
