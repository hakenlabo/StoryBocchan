/*
 * 操作感の定数はすべてここに集める。
 * 触ってみて「重い」「誤爆する」と感じたら、まずこのファイルの数値を変える。
 */
window.AP = window.AP || {};

AP.CONFIG = {
  APP_NAME: 'ストーリー坊ちゃん',     // アプリの名前（画面・保存ファイルの説明に出る）
  APP_VERSION: '2026102901',          // 版番号（index.html の ?v=・sw.js の VERSION と同じ。tools/bump-version.sh で変える）

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

  // ---- グリッド・整列 ----
  GRID_SIZE: 20,               // グリッドの目の大きさ（ワールドpx）。吸着もこの単位
  GRID_DEFAULT_SNAP: false,    // 新しいプロジェクトで最初から吸着するか
  GRID_MIN_SCREEN_PX: 8,       // 縮小して目がこれより細かくなったら背景の点を消す
  ARRANGE_GAP_X: 20,           // ツリー整列：親と子の横の間隔（グリッド1つ分。場所を取らないように）
  ARRANGE_GAP_Y: 20,           // ツリー整列：兄弟の縦の間隔
  ARRANGE_ROOT_GAP: 20,        // ツリー整列：いちばん上の階層（シーン）どうしの縦の間隔
  ARRANGE_UNDO_MS: 8000,       // 整列のあと「元に戻す」を押せる時間

  // ---- カードの色（パステル4色） ----
  // card.color は番号（0〜3）か null。色のないカードは、いちばん近い先祖の色になる（枝ごと色分けできる）
  CARD_COLORS: [
    { name: 'ピンク', bg: '#fde4e8', border: '#f2a7b5', line: '#e98a9d' },
    { name: 'きいろ', bg: '#fff4c7', border: '#ecc95c', line: '#dcb43a' },
    { name: 'みどり', bg: '#dcf3e1', border: '#8fcf9f', line: '#6dbb81' },
    { name: 'みずいろ', bg: '#dceafd', border: '#93bdf3', line: '#6fa3e8' },
  ],

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
  TL_HEIGHT_MIN: 190,          // タイムラインの高さ（上の端をドラッグ）の下限
  TL_HEIGHT_MAX_RATIO: 0.7,    // 上限（作業領域の高さに対する割合）
  TL_ZOOM_STEP: 1.25,          // －／＋ボタン1回の倍率
  TL_ZOOM_MIN: 0.25,
  TL_ZOOM_MAX: 6,
  TL_MIN_CARD_PX: 6,           // 尺がとても短いカードでも最低この幅は描く
  TL_PADDING_PX: 16,           // 帯の左右の余白
  TL_RESIZE_STEP_FRAMES: 1,    // 右端をドラッグして尺を変えるときの刻み（コマ）
  VC_EDGE_GRAB_PX: 10,         // Vコンテのバー：カットの境目からこの距離をつかむと尺を伸び縮み（指はこの2倍）
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
  IMAGE_MAX_PX: 1600,            // 読み込んだ写真・絵は長い辺をこの大きさまで縮める（作品データを重くしすぎないため）
  IMAGE_JPEG_QUALITY: 0.85,      // 読み込んだ画像を JPEG にするときの画質
  IMAGE_IMPORT_GAP: 20,          // まとめて読み込んだ画像のカードを横に並べるときの間隔
  THUMB_MIN_LINE_PX: 2.5,        // サムネイルでの線の最小の太さ（320px幅の画像で。縮めても線が見えるように）
  // 用紙：画面の何倍の大きさに描くか（PAN・FOLLOW用の長い絵）。w＝横、h＝縦
  DRAW_PAPERS: [
    { name: '標準（画面と同じ）', w: 1, h: 1 },
    { name: '横長 ×1.5', w: 1.5, h: 1 },
    { name: '横長 ×2', w: 2, h: 1 },
    { name: '横長 ×3', w: 3, h: 1 },
    { name: '縦長 ×1.5', w: 1, h: 1.5 },
    { name: '縦長 ×2', w: 1, h: 2 },
    { name: '縦長 ×3', w: 1, h: 3 },
  ],

  // ---- Vコンテ ----
  VC_FONT_RATIO: 0.045,        // カット番号・テキストの文字の大きさ（画面の高さに対する割合）
  VC_SHOW_CUT_NO: true,        // カット番号と時間を絵に重ねる（既定値。画面のチェックで変えられる）
  VC_SHOW_TEXT: true,          // カードの文字を下に字幕のように重ねる（既定値）
  VC_SHOW_NOTE: true,          // セリフ・メモを字幕として重ねる（既定値）

  // ---- カメラワーク ----
  CAM_PAN_AMOUNTS: [1.2, 1.5, 2],     // PAN：絵を何倍に拡大して端から端へ動かすか
  CAM_ZOOM_AMOUNTS: [1.2, 1.5, 2],    // T.U／T.B：何倍まで寄るか
  CAM_FOLLOW_AMOUNTS: [0.5, 1, 2],    // FOLLOW：1カットで絵が何画面ぶん流れるか
  CAM_FADE_SECS: [0.25, 0.5, 1, 1.5, 2, 3], // FI／FO の長さ（秒）の選択肢
  CAM_DEFAULT_AMOUNT_INDEX: 1,
  CAM_PREVIEW_W: 360,                 // 設定パネルのプレビューの幅

  // ---- 取り消し（Undo／Redo） ----
  UNDO_LIMIT: 200,             // さかのぼれる回数
  UNDO_GROUP_MS: 600,          // この時間内に続いた同じ種類の変更（ドラッグ・文字入力）は1回にまとめる
  UNDO_SAME_ACTION_MS: 50,     // これより短い間に続いた変更は、種類が違っても1つの操作とみなす（貼り付けなど）

  // ---- ムービー（MP4）書き出し ----
  MOVIE_BITS_PER_PIXEL: 0.12,  // 画質（1画素・1コマあたりのビット数）。720p・24fpsで約2.6Mbps
  MOVIE_KEYFRAME_SEC: 2,       // この秒数ごとに頭出しできるコマ（キーフレーム）を入れる
  MOVIE_PROBE_MS: 3000,        // 書き出しの前に、この時間で試しに数コマ符号化してみる（出てこない設定は使わない）
  MOVIE_STALL_MS: 10000,       // 符号化がこの時間まったく進まなければ「止まった」として、次の設定か録画に切り替える

  // ---- PDF書き出し ----
  PDF_DPI: 150,                // ページを描く細かさ（上げるときれいだがファイルが大きくなる）
  PDF_JPEG_QUALITY: 0.88,
  PDF_CUTS_PER_PAGE: 5,        // 絵コンテ用紙の1ページのカット数（既定）
  PDF_MAP_MAX_SCALE: 3,        // マインドマップ型：カードが少ないときに拡大しすぎない上限

  // ---- 保存 ----
  EXPORT_IMAGE_W: 960,         // 「ファイルに保存」でzipに入れる各カットの絵の幅（px）
  AUTOSAVE_DELAY_MS: 500,      // 最後の変更からこの時間で自動保存

  // ---- プロジェクトの既定値 ----
  DEFAULT_FPS: 24,
  FPS_OPTIONS: [24, 30],
  DEFAULT_ASPECT: '16:9',
  ASPECT_OPTIONS: ['16:9', '4:3', '1:1', '9:16', '2.39:1'],
  DEFAULT_DURATION_SEC: 3,     // 新しいカードの尺（秒）
};
