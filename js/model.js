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
      return card;
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
  S.activeCards = function () { return project.cards.filter(function (c) { return c.status === 'active'; }); };

  S.load = function (p) {
    project = normalize(p);
    reindex();
    emit('load');
  };

  S.setTitle = function (title) { project.title = title; emit('title'); };
  S.setSetting = function (key, value) { project.settings[key] = value; emit('settings'); };

  S.createCard = function (props) {
    const card = makeCard(props);
    project.cards.push(card);
    byId.set(card.id, card);
    emit('create');
    return card;
  };

  // 本当に消す。作った直後の空カードの後始末にだけ使う（ユーザー操作の「剥がす」は peel）
  S.removeCard = function (id) {
    project.cards = project.cards.filter(function (c) { return c.id !== id; });
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
    c.parentId = parentId || null;
    emit('parent');
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
      .filter(function (c) { return c.status === 'active' && c.timelineOrder !== null; })
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
    card.timelineOrder = null;
    normalizeOrders();
    emit('timeline');
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
