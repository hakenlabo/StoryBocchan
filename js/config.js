/*
 * 操作感の定数はすべてここに集める。
 * 触ってみて「重い」「誤爆する」と感じたら、まずこのファイルの数値を変える。
 */
window.AP = window.AP || {};

AP.CONFIG = {
  // ---- カードの見た目 ----
  CARD_W: 160,                 // カード幅（ワールド座標px）。高さはサムネ（画面比）＋テキストで決まる
  CARD_H_ESTIMATE: 130,        // 実寸を測る前に使う高さの目安

  // ---- ドラッグ・タップ判定 ----
  DRAG_THRESHOLD_MOUSE_PX: 4,  // この距離（画面px）動いたらドラッグ開始。マウス・ペン
  DRAG_THRESHOLD_TOUCH_PX: 10, // 指は震えるので大きめ
  DOUBLE_TAP_MS: 350,          // 2回目のタップまでの最大間隔
  DOUBLE_TAP_SLOP_PX: 24,      // 1回目と2回目のタップ位置のずれの許容（画面px）

  // ---- 親子・トレイの挙動 ----
  MOVE_SUBTREE_WITH_PARENT: true, // 親を動かすと子孫もついてくる
  TRAY_TAKES_SUBTREE: true,       // 剥がすと子孫も一緒にトレイへ
  AUTO_PLACE_ON_PARENT: true,     // 親に重ねて離したら、親の右側に並べ直す
  CHILD_GAP_X: 60,                // 自動配置：親と子の横の間隔
  CHILD_GAP_Y: 20,                // 自動配置：兄弟同士の縦の間隔
  REMOVE_EMPTY_NEW_CARD: true,    // 作った直後に何も書かずに確定したカードは消す（誤ダブルタップ対策）

  // ---- 親子線 ----
  LINE_STYLE: 'curve',         // 'curve' | 'straight'
  LINE_HIT_WIDTH: 16,          // 線をクリックしやすくする当たり判定の太さ

  // ---- パン・ズーム ----
  ZOOM_MIN: 0.2,
  ZOOM_MAX: 3,
  WHEEL_ZOOM_SPEED: 0.01,      // Ctrl(⌘)+ホイール／トラックパッドのピンチの効き
  WHEEL_ZOOM_WITHOUT_CTRL: false, // true にするとホイールだけでズーム（Windowsのマウス向け）
  FIT_PADDING_PX: 60,          // 「全体表示」の余白

  // ---- タイムライン ----
  TL_PX_PER_SEC: 80,           // 1秒あたりの幅（ズーム100%のとき）
  TL_ZOOM_STEP: 1.25,          // －／＋ボタン1回の倍率
  TL_ZOOM_MIN: 0.25,
  TL_ZOOM_MAX: 6,
  TL_MIN_CARD_PX: 6,           // 尺がとても短いカードでも最低この幅は描く
  TL_PADDING_PX: 16,           // 帯の左右の余白
  TL_RESIZE_STEP_FRAMES: 1,    // 右端をドラッグして尺を変えるときの刻み（コマ）
  TL_AUTOSCROLL_EDGE_PX: 48,   // ドラッグ中、帯の端からこの距離に入ると自動スクロール
  TL_AUTOSCROLL_SPEED: 14,
  TL_DROP_ON_MAP_UNADOPTS: true, // タイムラインのカードをマップへドラッグで戻すと「外す」
  MIN_DURATION_FRAMES: 1,

  // ---- 描画パネル ----
  // 線の座標は「絵の幅＝DRAW_BASE_W」の単位で保存する（画面の大きさに左右されない）
  DRAW_BASE_W: 1000,
  DRAW_COLORS: [
    { name: '黒', value: '#1d1d1f' },
    { name: '赤', value: '#e03131' },
    { name: '青', value: '#1c6fe0' },
  ],
  DRAW_SIZES: [                // ペンの太さ（DRAW_BASE_W に対する太さ）
    { name: '細', value: 3 },
    { name: '中', value: 6 },
    { name: '太', value: 12 },
  ],
  DRAW_DEFAULT_SIZE_INDEX: 1,
  ERASER_SIZE: 40,
  DRAW_MIN_PRESSURE_RATIO: 0.25, // 筆圧ゼロのときの太さの割合（1にすると筆圧無視）
  DRAW_NONPEN_PRESSURE: 0.7,     // マウス・指は筆圧がないので、この値で描く
  DRAW_PEN_ONLY_AFTER_PEN: true, // Apple Pencilを一度使ったら、指では描かない（手のひら誤爆対策）
  DRAW_MIN_POINT_DIST: 1.5,      // これより近い点は記録しない（データを軽くする）
  DRAW_UNDO_LIMIT: 100,
  DRAW_THUMB_W: 320,             // サムネイル画像の幅（px）

  // ---- 保存 ----
  AUTOSAVE_DELAY_MS: 500,      // 最後の変更からこの時間で自動保存

  // ---- プロジェクトの既定値 ----
  DEFAULT_FPS: 24,
  FPS_OPTIONS: [24, 30],
  DEFAULT_ASPECT: '16:9',
  ASPECT_OPTIONS: ['16:9', '4:3', '1:1', '9:16', '2.39:1'],
  DEFAULT_DURATION_SEC: 3,     // 新しいカードの尺（秒）
};
