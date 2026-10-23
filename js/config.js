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

  // ---- 保存 ----
  AUTOSAVE_DELAY_MS: 500,      // 最後の変更からこの時間で自動保存

  // ---- プロジェクトの既定値 ----
  DEFAULT_FPS: 24,
  FPS_OPTIONS: [24, 30],
  DEFAULT_ASPECT: '16:9',
  ASPECT_OPTIONS: ['16:9', '4:3', '1:1', '9:16', '2.39:1'],
  DEFAULT_DURATION_SEC: 3,     // 新しいカードの尺（秒）
};
