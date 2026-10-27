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
      color: null,       // カードの色（config.CARD_COLORS の番号）。null＝先祖の色（なければ白）
    }, props || {});
  }

  function defaultSettings() {
    return { fps: C.DEFAULT_FPS, aspect: C.DEFAULT_ASPECT, vcShowCutNo: C.VC_SHOW_CUT_NO, vcShowText: C.VC_SHOW_TEXT,
      vcShowNote: C.VC_SHOW_NOTE,
      mapSnap: C.GRID_DEFAULT_SNAP };
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
    p.sequence = Array.isArray(p.sequence) ? p.sequence : null; // Vコンテのシーン構成 [{id, on}]。null＝全部をツリーの順に
    p.reference = typeof p.reference === 'string' ? p.reference : ''; // 箇条書きで参照する長い文（台本・あらすじなど）
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
    record(reason);
    listeners.forEach(function (fn) { fn(reason); });
  }

  // ------------------------------------------------------------
  // 取り消し（Undo／Redo）
  // 変更のたびに状態の写しを取る。カードは浅い写し（strokes などの中身は差し替えでしか変わらないので共有して軽くする）。
  // 続けて起きた変更（ドラッグ中の移動、文字入力、貼り付けでまとめて起きる変更）は1回の操作にまとめる。
  // ------------------------------------------------------------
  let undoStack = [];
  let redoStack = [];
  let base = null;          // いまの操作が始まる前の状態
  let latest = null;        // 最後の変更のあとの状態
  let pending = false;      // まとめている途中の操作がある
  let pendingGroup = null;
  let lastEmitAt = 0;
  let applying = false;
  let mergeNext = false;    // 次の変更は今の操作に含める
  let version = 0;          // 変更（取り消し・やり直しを含む）のたびに増える

  function snap() {
    return {
      title: project.title,
      settings: Object.assign({}, project.settings),
      sequence: project.sequence ? project.sequence.map(function (x) { return Object.assign({}, x); }) : null,
      reference: project.reference,
      cards: project.cards.map(function (c) { return Object.assign({}, c); }),
    };
  }

  function groupOf(reason) {
    if (reason === 'move') return 'move';
    if (reason === 'update' || reason === 'title' || reason === 'reference') return 'text';
    if (reason === 'duration') return 'duration';
    return reason + ':' + Math.random(); // それ以外は毎回べつの操作
  }

  function closeGroup() {
    if (!pending) return;
    undoStack.push(base);
    if (undoStack.length > C.UNDO_LIMIT) undoStack.shift();
    base = latest;
    pending = false;
  }

  function record(reason) {
    version++;
    if (applying || reason === 'load' || reason === 'history') return;
    const now = Date.now();
    const g = groupOf(reason);
    const gap = now - lastEmitAt;
    if (pending && !mergeNext && gap > C.UNDO_SAME_ACTION_MS && (g !== pendingGroup || gap > C.UNDO_GROUP_MS)) closeGroup();
    mergeNext = false;
    pending = true;
    pendingGroup = g;
    lastEmitAt = now;
    latest = snap();
    redoStack = [];
  }

  function resetHistory() {
    undoStack = [];
    redoStack = [];
    base = latest = snap();
    pending = false;
  }

  function apply(state) {
    project.title = state.title;
    project.settings = Object.assign({}, state.settings);
    project.sequence = state.sequence ? state.sequence.map(function (x) { return Object.assign({}, x); }) : null;
    project.reference = state.reference || '';
    project.cards = state.cards.map(function (c) { return Object.assign({}, c); });
    reindex();
    applying = true;
    try { emit('history'); } finally { applying = false; }
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
    resetHistory();
    emit('load');
  };

  // ここで操作の区切りをつける（整列など、前後の変更とまとめたくない操作の前に呼ぶ）
  S.checkpoint = function () { closeGroup(); lastEmitAt = 0; };
  // 次の変更を、直前の操作と1回にまとめる（カードを作ってすぐ最初の文字を入れたとき）
  S.mergeNext = function () { mergeNext = true; };
  S.version = function () { return version; };
  S.canUndo = function () { return pending || undoStack.length > 0; };
  S.canRedo = function () { return redoStack.length > 0; };

  S.undo = function () {
    closeGroup();
    if (!undoStack.length) return false;
    redoStack.push(base);
    base = latest = undoStack.pop();
    apply(base);
    return true;
  };

  S.redo = function () {
    if (!redoStack.length) return false;
    closeGroup();
    undoStack.push(base);
    base = latest = redoStack.pop();
    apply(base);
    return true;
  };

  S.setTitle = function (title) { project.title = title; emit('title'); };
  S.reference = function () { return project.reference || ''; };
  S.setReference = function (text) { project.reference = text; emit('reference'); };
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

  // トレイのまとまりを本当に消す（連動カットも）。取り消し（⌘Z）なら戻せる
  S.deleteTrayGroups = function (rootIds) {
    const gone = new Set();
    rootIds.forEach(function (rid) { S.trayGroup(rid).forEach(function (c) { gone.add(c.id); }); });
    if (!gone.size) return 0;
    project.cards = project.cards.filter(function (c) { return !gone.has(c.id) && !(c.linkOf && gone.has(c.linkOf)); });
    project.cards.forEach(function (c) {
      if (c.parentId && gone.has(c.parentId)) c.parentId = null; // 残ったカードの親が消えたら、いちばん上の階層へ
    });
    reindex();
    emit('remove');
    return gone.size;
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
  // sceneId を渡すとそのシーン（ツリー）のカットだけ
  S.timelineCards = function (sceneId) {
    return project.cards
      .filter(function (c) {
        if (c.status !== 'active' || c.timelineOrder === null) return false;
        if (c.linkOf) {
          const src = byId.get(c.linkOf);
          if (!src || src.status !== 'active') return false; // 元のカードを剥がしている間は連動カットも隠す
        }
        return !sceneId || S.sceneOf(c) === sceneId;
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
    const list = S.timelineCards(S.sceneOf(card)).filter(function (c) { return c.id !== id; }); // 同じシーンの中での位置
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

  // まとめて採用：ids をこの順に、beforeId のカードの前（null なら最後）へ並べる。すでに並んでいるものもこの流れに入れ直す
  // カットはそれぞれ自分のシーンに入る。sceneId のシーンのものは beforeId の前（null なら最後）、ほかのシーンのものはそのシーンの最後へ
  S.adoptMany = function (ids, beforeId, sceneId) {
    const groups = new Map();
    ids.forEach(function (id) {
      const c = byId.get(id);
      if (!c) return;
      const sc = S.sceneOf(c);
      if (!groups.has(sc)) groups.set(sc, []);
      groups.get(sc).push(id);
    });
    groups.forEach(function (gids, sc) {
      const set = new Set(gids);
      const vis = S.timelineCards(sc).filter(function (c) { return !set.has(c.id); });
      let idx = vis.length;
      if (sc === sceneId && beforeId) {
        const i = vis.findIndex(function (c) { return c.id === beforeId; });
        if (i >= 0) idx = i;
      }
      const prev = vis[idx - 1], next = vis[idx];
      const lo = prev ? prev.timelineOrder : (next ? next.timelineOrder - 1 : maxOrder() + 1);
      const hi = next ? next.timelineOrder : lo + 1;
      gids.forEach(function (id, k) { byId.get(id).timelineOrder = lo + (hi - lo) * (k + 1) / (gids.length + 1); });
    });
    normalizeOrders();
    emit('timeline');
  };

  function maxOrder() {
    let m = -1;
    project.cards.forEach(function (c) { if (c.timelineOrder !== null) m = Math.max(m, c.timelineOrder); });
    return m;
  }

  // ---- シーン（マップのツリー1本＝1シーン） ----
  // カードのシーン＝いちばん上の先祖のid。連動カットは元のカードのシーン。
  // 子のないひとりぼっちのカードは、まとめて「ツリーに入っていないカード」（LOOSE）のシーンにする
  const LOOSE = '__loose';
  S.LOOSE_SCENE = LOOSE;
  S.isScene = function (id) { return id === LOOSE || !!byId.get(id); };
  S.sceneOf = function (card) {
    if (typeof card === 'string') card = byId.get(card);
    if (!card) return null;
    let cur = S.source(card);
    const guard = new Set();
    while (cur.parentId && byId.get(cur.parentId) && !guard.has(cur.id)) {
      guard.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    const hasKids = project.cards.some(function (c) { return c.parentId === cur.id && !c.linkOf && c.status === 'active'; });
    return hasKids ? cur.id : LOOSE;
  };

  S.sceneName = function (sceneId) {
    if (sceneId === LOOSE) return 'ツリーに入っていないカード';
    const c = byId.get(sceneId);
    return (c && c.text) || '（無題のシーン）';
  };

  // カットのあるシーン（マップのいちばん上の階層の順）
  S.scenes = function () {
    const ids = [];
    S.timelineCards().forEach(function (c) {
      const sc = S.sceneOf(c);
      if (ids.indexOf(sc) < 0) ids.push(sc);
    });
    const rootOrder = function (id) {
      if (id === LOOSE) return 2e9; // ツリーに入っていないカードは最後
      const c = byId.get(id);
      return c && c.treeOrder !== null ? c.treeOrder : 1e9;
    };
    return ids.sort(function (a, b) { return rootOrder(a) - rootOrder(b); });
  };

  // Vコンテのシーン構成：[{id, on}]。保存した並びに、新しくできたシーンを後ろに足したもの
  S.sequence = function () {
    const live = S.scenes();
    const out = [];
    (project.sequence || []).forEach(function (x) {
      if (live.indexOf(x.id) >= 0 && !out.some(function (o) { return o.id === x.id; })) out.push({ id: x.id, on: x.on !== false });
    });
    live.forEach(function (id) { if (!out.some(function (o) { return o.id === id; })) out.push({ id: id, on: true }); });
    return out;
  };

  S.setSequence = function (list) {
    project.sequence = list.map(function (x) { return { id: x.id, on: x.on !== false }; });
    emit('sequence');
  };

  // Vコンテで流す順：構成でオンのシーンを順に、それぞれのカットを順に
  S.playlist = function () {
    const out = [];
    let sceneNo = 0;
    S.sequence().forEach(function (x) {
      if (!x.on) return;
      sceneNo++;
      S.timelineCards(x.id).forEach(function (c, i) {
        out.push({ card: c, sceneId: x.id, sceneNo: sceneNo, cutNo: i + 1 });
      });
    });
    return out;
  };

  // カードid（連動カットは元のカード）→ シーン内のカット番号（1始まり）の配列
  S.cutNumbers = function () {
    const m = new Map();
    S.scenes().forEach(function (sc) {
      S.timelineCards(sc).forEach(function (c, i) {
        const id = c.linkOf || c.id;
        if (!m.has(id)) m.set(id, []);
        m.get(id).push(i + 1);
      });
    });
    return m;
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
      color: src.color,
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

  // ---- カードの色 ----
  // 色を付ける（ids はまとめて。color は番号か null）
  S.setColor = function (ids, color) {
    ids.forEach(function (id) {
      const c = byId.get(id);
      if (c) c.color = color === null || color === undefined ? null : color;
    });
    emit('color');
  };

  // 見た目の色：自分の色、なければいちばん近い先祖の色。どちらもなければ null（連動カットは元のカード）
  S.colorOf = function (card) {
    if (typeof card === 'string') card = byId.get(card);
    let cur = S.source(card);
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      if (cur.color !== null && cur.color !== undefined && C.CARD_COLORS[cur.color]) return C.CARD_COLORS[cur.color];
      guard.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return null;
  };

  S.setDuration = function (id, frames) {
    const card = byId.get(id);
    if (!card) return;
    card.duration = Math.max(C.MIN_DURATION_FRAMES, Math.round(frames));
    emit('duration');
  };

  S.totalFrames = function (sceneId) {
    return S.timelineCards(sceneId).reduce(function (sum, c) { return sum + c.duration; }, 0);
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
