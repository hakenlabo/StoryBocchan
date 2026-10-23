/*
 * AP.Store：プロジェクトとカードの状態を持ち、変更操作をまとめる。
 * 変更したら必ず emit() し、ビューと自動保存はそれを購読して動く。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const PROJECT_VERSION = 1;

  let project = null;
  let byId = new Map();
  const listeners = [];

  function makeCard(props) {
    const fps = project ? project.settings.fps : C.DEFAULT_FPS;
    return Object.assign({
      id: U.uid(),
      text: '',
      strokes: [],
      duration: Math.round(C.DEFAULT_DURATION_SEC * fps),
      parentId: null,
      mapPos: { x: 0, y: 0 },
      timelineOrder: null,
      status: 'active',
      note: '',
      trayInfo: null,
      treeOrder: null,   // マップのツリー上の兄弟の順番（箇条書きの並び）。座標とは別に持つ
      linkOf: null,      // 連動カット：絵と文字はこのidのカードのものを使う（尺・順番・カメラは自分で持つ）
      camera: null,      // カメラワーク（js/camera.js）。なしは null
      paper: { w: 1, h: 1 }, // 用紙の大きさ（画面の何倍か）。PAN・FOLLOW用の長い絵。絵と一緒なので連動カットは元のものを使う
    }, props || {});
  }

  function defaultSettings() {
    return { fps: C.DEFAULT_FPS, aspect: C.DEFAULT_ASPECT, vcShowCutNo: C.VC_SHOW_CUT_NO, vcShowText: C.VC_SHOW_TEXT };
  }

  function newProject() {
    const now = Date.now();
    const p = {
      version: PROJECT_VERSION,
      id: U.uid(),
      title: '無題の作品',
      settings: defaultSettings(),
      cards: [],
      createdAt: now,
      updatedAt: now,
    };
    p.cards.push(Object.assign(makeCard(), { text: '企画タイトル', mapPos: { x: -80, y: -60 } }));
    return p;
  }

  // 古い形式や欠けたフィールドを補う
  function normalize(p) {
    p.version = p.version || PROJECT_VERSION;
    p.settings = Object.assign(defaultSettings(), p.settings || {});
    p.cards = (p.cards || []).map(function (c) {
      const base = makeCard();
      const card = Object.assign(base, c);
      card.mapPos = Object.assign({ x: 0, y: 0 }, c.mapPos || {});
      card.paper = Object.assign({ w: 1, h: 1 }, c.paper || {});
      return card;
    });
    // treeOrder がない古いデータは、マップの上から順に番号を振る
    const groups = new Map();
    p.cards.forEach(function (c) {
      if (c.linkOf) return;
      const k = c.parentId || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    });
    groups.forEach(function (list) {
      if (list.every(function (c) { return c.treeOrder !== null; })) return;
      list.sort(function (a, b) {
        if (a.treeOrder !== null && b.treeOrder !== null) return a.treeOrder - b.treeOrder;
        return (a.mapPos.y - b.mapPos.y) || (a.mapPos.x - b.mapPos.x);
      }).forEach(function (c, i) { c.treeOrder = i; });
    });
    return p;
  }

  function reindex() {
    byId = new Map();
    project.cards.forEach(function (c) { byId.set(c.id, c); });
  }

  function emit(reason) {
    if (reason !== 'load') project.updatedAt = Date.now();
    listeners.forEach(function (fn) { fn(reason); });
  }

  const S = {};

  S.newProject = newProject;
  S.subscribe = function (fn) { listeners.push(fn); };
  S.project = function () { return project; };
  S.settings = function () { return project.settings; };
  S.cards = function () { return project.cards; };
  S.get = function (id) { return byId.get(id) || null; };
  // マップに出るカード（連動カットはタイムラインだけの存在なので含めない）
  S.activeCards = function () { return project.cards.filter(function (c) { return c.status === 'active' && !c.linkOf; }); };

  // 絵と文字の持ち主（連動カットなら元のカード）
  S.source = function (card) {
    if (card && card.linkOf) return byId.get(card.linkOf) || card;
    return card;
  };

  S.load = function (p) {
    project = normalize(p);
    reindex();
    emit('load');
  };

  S.setTitle = function (title) { project.title = title; emit('title'); };
  S.setSetting = function (key, value) { project.settings[key] = value; emit('settings'); };

  S.createCard = function (props) {
    const card = makeCard(props);
    if (card.treeOrder === null && !card.linkOf) card.treeOrder = nextTreeOrder(card.parentId);
    project.cards.push(card);
    byId.set(card.id, card);
    emit('create');
    return card;
  };

  // 本当に消す。作った直後の空カードの後始末にだけ使う（ユーザー操作の「剥がす」は peel）
  S.removeCard = function (id) {
    project.cards = project.cards.filter(function (c) { return c.id !== id && c.linkOf !== id; });
    project.cards.forEach(function (c) { if (c.parentId === id) c.parentId = null; });
    reindex();
    emit('remove');
  };

  S.updateCard = function (id, patch) {
    const c = byId.get(id);
    if (!c) return;
    Object.assign(c, patch);
    emit('update');
  };

  // positions: { id: {x, y}, ... }
  S.moveCards = function (positions) {
    Object.keys(positions).forEach(function (id) {
      const c = byId.get(id);
      if (c) c.mapPos = { x: positions[id].x, y: positions[id].y };
    });
    emit('move');
  };

  S.children = function (id) {
    return project.cards.filter(function (c) { return c.parentId === id; });
  };

  // 子孫（自分は含まない）。filter で status を絞れる
  S.descendants = function (id, filter) {
    const out = [];
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const cur = stack.pop();
      project.cards.forEach(function (c) {
        if (c.parentId === cur && !seen.has(c.id)) {
          seen.add(c.id);
          stack.push(c.id);
          if (!filter || filter(c)) out.push(c);
        }
      });
    }
    return out;
  };

  // a が b の祖先（または同一）か
  S.isAncestorOrSelf = function (a, b) {
    let cur = byId.get(b);
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      if (cur.id === a) return true;
      guard.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return false;
  };

  // 親子付け。輪になる場合は false
  S.setParent = function (childId, parentId) {
    if (parentId && S.isAncestorOrSelf(childId, parentId)) return false;
    const c = byId.get(childId);
    if (!c) return false;
    if ((c.parentId || null) !== (parentId || null)) {
      c.parentId = parentId || null;
      c.treeOrder = nextTreeOrder(c.parentId, c.id);
    }
    emit('parent');
    return true;
  };

  // ---- ツリーの順番（箇条書き） ----
  function nextTreeOrder(parentId, exceptId) {
    let max = -1;
    project.cards.forEach(function (c) {
      if ((c.parentId || null) === (parentId || null) && c.id !== exceptId && !c.linkOf && c.treeOrder !== null) {
        max = Math.max(max, c.treeOrder);
      }
    });
    return max + 1;
  }

  function normalizeTree(parentId) {
    project.cards
      .filter(function (c) { return (c.parentId || null) === (parentId || null) && !c.linkOf; })
      .sort(function (a, b) { return a.treeOrder - b.treeOrder; })
      .forEach(function (c, i) { c.treeOrder = i; });
  }

  // 表示上の親（親がいない・マップにいないなら null＝いちばん上の階層）
  S.treeParentId = function (card) {
    const p = card.parentId ? byId.get(card.parentId) : null;
    return p && p.status === 'active' && !p.linkOf ? p.id : null;
  };

  // マップに出ている子を順番どおりに（parentId が null ならいちばん上の階層）
  S.treeChildren = function (parentId) {
    return S.activeCards()
      .filter(function (c) { return S.treeParentId(c) === (parentId || null); })
      .sort(function (a, b) { return a.treeOrder - b.treeOrder; });
  };

  // 親を parentId にして、兄弟の index 番目に入れる。輪になる場合は false
  S.moveInTree = function (id, parentId, index) {
    if (parentId && S.isAncestorOrSelf(id, parentId)) return false;
    const c = byId.get(id);
    if (!c) return false;
    const oldParent = c.parentId || null;
    const sibs = S.treeChildren(parentId).filter(function (s) { return s.id !== id; });
    index = U.clamp(index, 0, sibs.length);
    const prev = sibs[index - 1];
    const next = sibs[index];
    c.parentId = parentId || null;
    if (prev && next) c.treeOrder = (prev.treeOrder + next.treeOrder) / 2;
    else if (prev) c.treeOrder = prev.treeOrder + 0.5;
    else if (next) c.treeOrder = next.treeOrder - 0.5;
    else c.treeOrder = 0;
    normalizeTree(c.parentId);
    if (oldParent !== c.parentId) normalizeTree(oldParent);
    emit('tree');
    return true;
  };

  S.detach = function (childId) { S.setParent(childId, null); };

  // ---- 保留トレイ ----
  S.peel = function (id) {
    const root = byId.get(id);
    if (!root || root.status !== 'active') return;
    const group = [root].concat(C.TRAY_TAKES_SUBTREE
      ? S.descendants(id, function (c) { return c.status === 'active'; })
      : []);
    const at = Date.now();
    group.forEach(function (c) {
      c.status = 'tray';
      c.trayInfo = { rootId: id, at: at };
    });
    emit('peel');
  };

  // トレイに見せる「まとまり」の先頭カード（新しく剥がした順）
  S.trayRoots = function () {
    return project.cards
      .filter(function (c) { return c.status === 'tray' && c.trayInfo && c.trayInfo.rootId === c.id; })
      .sort(function (a, b) { return b.trayInfo.at - a.trayInfo.at; });
  };

  S.trayGroup = function (rootId) {
    return project.cards.filter(function (c) {
      return c.status === 'tray' && c.trayInfo && c.trayInfo.rootId === rootId;
    });
  };

  // 戻す。newPos を渡すと先頭カードをそこへ置き、まとまり全体を同じだけずらす
  S.restore = function (rootId, newPos) {
    const root = byId.get(rootId);
    if (!root) return;
    const group = S.trayGroup(rootId);
    const dx = newPos ? newPos.x - root.mapPos.x : 0;
    const dy = newPos ? newPos.y - root.mapPos.y : 0;
    group.forEach(function (c) {
      c.status = 'active';
      c.trayInfo = null;
      c.mapPos = { x: c.mapPos.x + dx, y: c.mapPos.y + dy };
    });
    emit('restore');
  };

  S.setPaper = function (id, paper) {
    const card = byId.get(id);
    if (!card) return;
    card.paper = { w: paper.w, h: paper.h };
    emit('paper');
  };

  S.setCamera = function (id, camera) {
    const card = byId.get(id);
    if (!card) return;
    card.camera = camera;
    emit('camera');
  };

  // 絵。配列ごと差し替える（サムネイルのキャッシュは配列の同一性で判定している）
  S.setStrokes = function (id, strokes) {
    const card = byId.get(id);
    if (!card) return;
    card.strokes = strokes;
    emit('strokes');
  };

  // ---- タイムライン ----
  // timelineOrder はマップのツリーとは無関係。トレイ中のカードも番号を持ち続け、戻すと元の並びに入る

  // タイムラインに並ぶカード（activeで採用済み）を順番どおりに
  S.timelineCards = function () {
    return project.cards
      .filter(function (c) {
        if (c.status !== 'active' || c.timelineOrder === null) return false;
        if (!c.linkOf) return true;
        const src = byId.get(c.linkOf);
        return !!src && src.status === 'active'; // 元のカードを剥がしている間は連動カットも隠す
      })
      .sort(function (a, b) { return a.timelineOrder - b.timelineOrder; });
  };

  // トレイ中も含めて番号を 0,1,2… に振り直す
  function normalizeOrders() {
    project.cards
      .filter(function (c) { return c.timelineOrder !== null; })
      .sort(function (a, b) { return a.timelineOrder - b.timelineOrder; })
      .forEach(function (c, i) { c.timelineOrder = i; });
  }

  // 採用（またはタイムライン内での並べ替え）。index は見えている並びの中での挿入位置
  S.adopt = function (id, index) {
    const card = byId.get(id);
    if (!card) return;
    const list = S.timelineCards().filter(function (c) { return c.id !== id; });
    index = U.clamp(index, 0, list.length);
    const prev = list[index - 1];
    const next = list[index];
    if (prev && next) card.timelineOrder = (prev.timelineOrder + next.timelineOrder) / 2;
    else if (prev) card.timelineOrder = prev.timelineOrder + 1;
    else if (next) card.timelineOrder = next.timelineOrder - 1;
    else card.timelineOrder = 0;
    normalizeOrders();
    emit('timeline');
  };

  S.unadopt = function (id) {
    const card = byId.get(id);
    if (!card) return;
    if (card.linkOf) return S.removeCard(id); // 連動カットは中身を持たないので、外したら消える
    card.timelineOrder = null;
    normalizeOrders();
    emit('timeline');
  };

  // 連動カットを作ってタイムラインの index 番目に入れる
  S.addLink = function (srcId, index) {
    const src = byId.get(srcId);
    if (!src) return null;
    const link = makeCard({ linkOf: src.id, duration: src.duration, mapPos: { x: src.mapPos.x, y: src.mapPos.y } });
    project.cards.push(link);
    byId.set(link.id, link);
    S.adopt(link.id, index);
    return link;
  };

  // 中身を複製した独立のカード（子孫は含まない）。元のカードの兄弟として、すぐ後ろに入る
  S.duplicate = function (srcId, props) {
    const src = S.source(byId.get(srcId));
    if (!src) return null;
    const copy = makeCard(Object.assign({
      text: src.text,
      strokes: JSON.parse(JSON.stringify(src.strokes)),
      duration: src.duration,
      note: src.note,
      camera: src.camera ? JSON.parse(JSON.stringify(src.camera)) : null,
      paper: { w: src.paper.w, h: src.paper.h },
      parentId: src.parentId,
      mapPos: { x: src.mapPos.x, y: src.mapPos.y },
      treeOrder: src.treeOrder + 0.5,
    }, props || {}));
    project.cards.push(copy);
    byId.set(copy.id, copy);
    normalizeTree(copy.parentId);
    emit('create');
    return copy;
  };

  S.setDuration = function (id, frames) {
    const card = byId.get(id);
    if (!card) return;
    card.duration = Math.max(C.MIN_DURATION_FRAMES, Math.round(frames));
    emit('duration');
  };

  S.totalFrames = function () {
    return S.timelineCards().reduce(function (sum, c) { return sum + c.duration; }, 0);
  };

  // fpsを変えたら、秒数が変わらないように全カードの尺（コマ数）を換算する
  S.setFps = function (fps) {
    const old = project.settings.fps;
    if (fps === old) return;
    project.cards.forEach(function (c) {
      c.duration = Math.max(C.MIN_DURATION_FRAMES, Math.round(c.duration * fps / old));
    });
    project.settings.fps = fps;
    emit('settings');
  };

  AP.Store = S;
})();
