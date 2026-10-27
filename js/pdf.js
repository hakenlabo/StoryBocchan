/*
 * AP.Pdf：PDF書き出し（絵コンテ用紙／マインドマップ型）。
 * - ライブラリを使わない方針のため、各ページをキャンバスに描いてJPEGにし、それを並べただけの小さなPDFを自前で作る。
 *   日本語の文字もそのまま絵として入る（フォントの埋め込みが要らない）。かわりにPDFの文字は選択できない。
 * - 絵コンテ用紙：Vコンテのシーン構成の順に、カット・画面・内容・セリフ・秒 の表。
 * - マインドマップ型：マップ全体（線つき）を1ページに収める。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  const FONT = '-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif';
  const PAPER_MM = { A4: [210, 297], A3: [297, 420] };

  // ------------------------------------------------------------
  // PDF（JPEGの画像だけのページ）
  // ------------------------------------------------------------
  function canvasJpeg(cv) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (b) {
        if (!b) return reject(new Error('画像にできませんでした'));
        b.arrayBuffer().then(function (ab) { resolve(new Uint8Array(ab)); });
      }, 'image/jpeg', C.PDF_JPEG_QUALITY);
    });
  }

  // pages: [{ canvas, wPt, hPt }] → Blob
  async function makePdf(pages) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let pos = 0;
    const push = function (data) {
      const b = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(b);
      pos += b.length;
    };
    const obj = function (n, body) { offsets[n] = pos; push(n + ' 0 obj\n'); body(); push('\nendobj\n'); };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    // 1: カタログ、2: ページの一覧、以降 ページごとに [ページ, 中身, 画像] の3つ
    const n = pages.length;
    const kids = [];
    for (let i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');
    obj(1, function () { push('<< /Type /Catalog /Pages 2 0 R >>'); });
    obj(2, function () { push('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>'); });
    for (let i = 0; i < n; i++) {
      const p = pages[i];
      const jpg = await canvasJpeg(p.canvas);
      const pageNo = 3 + i * 3, contNo = pageNo + 1, imgNo = pageNo + 2;
      const w = p.wPt.toFixed(2), h = p.hPt.toFixed(2);
      obj(pageNo, function () {
        push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] ' +
          '/Resources << /XObject << /Im' + i + ' ' + imgNo + ' 0 R >> >> /Contents ' + contNo + ' 0 R >>');
      });
      const content = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im' + i + ' Do Q';
      obj(contNo, function () { push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'); });
      obj(imgNo, function () {
        push('<< /Type /XObject /Subtype /Image /Width ' + p.canvas.width + ' /Height ' + p.canvas.height +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n');
        push(jpg);
        push('\nendstream');
      });
    }
    const total = 3 + n * 3;
    const xref = pos;
    let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  }

  // ------------------------------------------------------------
  // 描画の道具
  // ------------------------------------------------------------
  function newPage(paper, landscape) {
    const mm = PAPER_MM[paper] || PAPER_MM.A4;
    const wmm = landscape ? mm[1] : mm[0], hmm = landscape ? mm[0] : mm[1];
    const px = function (m) { return Math.round(m / 25.4 * C.PDF_DPI); };
    const cv = document.createElement('canvas');
    cv.width = px(wmm);
    cv.height = px(hmm);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    return { canvas: cv, ctx: ctx, wPt: wmm / 25.4 * 72, hPt: hmm / 25.4 * 72, W: cv.width, H: cv.height, u: C.PDF_DPI / 150 };
  }

  function font(ctx, size, bold) { ctx.font = (bold ? 'bold ' : '') + Math.round(size) + 'px ' + FONT; }

  // 日本語も折り返す（1文字ずつ測る）。maxLines を超えたら … にする
  function wrap(ctx, text, maxW, maxLines) {
    const out = [];
    String(text || '').split('\n').forEach(function (para) {
      let line = '';
      for (const ch of para) {
        if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
        else line += ch;
      }
      out.push(line);
    });
    if (maxLines && out.length > maxLines) {
      const cut = out.slice(0, maxLines);
      let last = cut[maxLines - 1];
      while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      cut[maxLines - 1] = last + '…';
      return cut;
    }
    return out;
  }

  function drawLines(ctx, lines, x, y, lh) {
    lines.forEach(function (l, i) { ctx.fillText(l, x, y + i * lh); });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ------------------------------------------------------------
  // 絵コンテ用紙
  // ------------------------------------------------------------
  function storyboardPages(opts) {
    const st = Store.settings();
    const fps = st.fps;
    const ratio = U.aspectRatio(st.aspect);
    const list = Store.playlist();
    const perPage = opts.perPage || C.PDF_CUTS_PER_PAGE;
    const totalFrames = list.reduce(function (s, p) { return s + p.card.duration; }, 0);
    const pageCount = Math.max(1, Math.ceil(list.length / perPage));
    const pages = [];
    const title = Store.project().title || '無題の作品';
    const date = new Date().toLocaleDateString();

    for (let pi = 0; pi < pageCount; pi++) {
      const pg = newPage(opts.paper, false);
      const ctx = pg.ctx, u = pg.u;
      const M = 60 * u;
      const x0 = M, x1 = pg.W - M;
      const cw = x1 - x0;
      // 見出し
      ctx.fillStyle = '#111';
      ctx.textBaseline = 'alphabetic';
      font(ctx, 34 * u, true);
      ctx.fillText(title, x0, M + 34 * u);
      font(ctx, 18 * u);
      ctx.fillStyle = '#555';
      ctx.textAlign = 'right';
      ctx.fillText('絵コンテ　' + (pi + 1) + ' / ' + pageCount + '　' + date + '　' + fps + 'fps ' + st.aspect, x1, M + 30 * u);
      ctx.textAlign = 'left';
      const headTop = M + 60 * u;
      const headH = 44 * u;
      const footH = 50 * u;
      const rowsTop = headTop + headH;
      const rowH = (pg.H - M - footH - rowsTop) / perPage;
      // 列の幅：画面は行の高さに合わせる（ただし幅の45%まで）
      const colC = 100 * u, colSec = 100 * u;
      let picH = rowH - 24 * u, picW = picH * ratio;
      if (picW > cw * 0.45) { picW = cw * 0.45; picH = picW / ratio; }
      const colPic = picW + 24 * u;
      const rest = cw - colC - colPic - colSec;
      const colText = rest * 0.55, colNote = rest - colText;
      const xs = [x0, x0 + colC, x0 + colC + colPic, x0 + colC + colPic + colText, x0 + colC + colPic + colText + colNote, x1];
      // 列見出し
      ctx.fillStyle = '#f0f1f3';
      ctx.fillRect(x0, headTop, cw, headH);
      ctx.fillStyle = '#222';
      font(ctx, 20 * u, true);
      ctx.textAlign = 'center';
      ['カット', '画面', '内容', 'セリフ', '秒'].forEach(function (h, i) { ctx.fillText(h, (xs[i] + xs[i + 1]) / 2, headTop + headH * 0.68); });
      ctx.textAlign = 'left';

      let pageFrames = 0;
      const slice = list.slice(pi * perPage, pi * perPage + perPage);
      slice.forEach(function (p, ri) {
        const y = rowsTop + ri * rowH;
        const prev = list[pi * perPage + ri - 1];
        const newScene = !prev || prev.sceneId !== p.sceneId;
        const src = Store.source(p.card);
        pageFrames += p.card.duration;
        // カット番号（シーンの始まりならシーン名も）
        ctx.fillStyle = '#111';
        if (newScene) {
          font(ctx, 15 * u, true);
          ctx.fillStyle = '#b8650a';
          drawLines(ctx, wrap(ctx, 'S' + p.sceneNo + ' ' + Store.sceneName(p.sceneId), colC - 12 * u, 3), xs[0] + 8 * u, y + 24 * u, 19 * u);
          ctx.fillStyle = '#111';
        }
        font(ctx, 30 * u, true);
        ctx.textAlign = 'center';
        ctx.fillText(String(p.cutNo), (xs[0] + xs[1]) / 2, y + rowH / 2 + 12 * u);
        ctx.textAlign = 'left';
        // 画面：最初のコマ（カメラワークの始まり）を描く
        const pic = document.createElement('canvas');
        pic.width = Math.round(picW);
        pic.height = Math.round(picH);
        AP.Vconte.renderCut(pic.getContext('2d'), pic.width, pic.height, p.card, 0, 0, { overlays: false, fade: false }); // F.Iで真っ黒にならないように
        const px = xs[1] + (colPic - picW) / 2, py = y + (rowH - picH) / 2;
        ctx.drawImage(pic, px, py, picW, picH);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2 * u;
        ctx.strokeRect(px, py, picW, picH);
        // 内容：カメラワーク＋カードの文字
        const pad = 10 * u;
        let ty = y + 30 * u;
        const camLabel = AP.Camera.label(p.card.camera);
        if (camLabel) {
          font(ctx, 18 * u, true);
          ctx.fillStyle = '#b8650a';
          ctx.fillText(camLabel.split(' ').map(function (s) { return '【' + s + '】'; }).join(''), xs[2] + pad, ty);
          ty += 28 * u;
        }
        ctx.fillStyle = '#111';
        font(ctx, 19 * u);
        const lh = 27 * u;
        drawLines(ctx, wrap(ctx, src.text, colText - pad * 2, Math.max(1, Math.floor((y + rowH - ty) / lh))), xs[2] + pad, ty, lh);
        // セリフ（メモ）
        drawLines(ctx, wrap(ctx, src.note || '', colNote - pad * 2, Math.max(1, Math.floor((rowH - 30 * u) / lh))), xs[3] + pad, y + 30 * u, lh);
        // 秒
        font(ctx, 22 * u, true);
        ctx.textAlign = 'center';
        ctx.fillText(U.framesToLabel(p.card.duration, fps), (xs[4] + xs[5]) / 2, y + rowH / 2 + 8 * u);
        ctx.textAlign = 'left';
      });
      // 罫線
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 2 * u;
      ctx.strokeRect(x0, headTop, cw, headH + rowH * perPage);
      ctx.lineWidth = 1.2 * u;
      for (let r = 0; r <= perPage; r++) {
        const yy = rowsTop + r * rowH;
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
      }
      xs.slice(1, 5).forEach(function (xx) {
        ctx.beginPath(); ctx.moveTo(xx, headTop); ctx.lineTo(xx, rowsTop + rowH * perPage); ctx.stroke();
      });
      // 足：このページと全体の尺
      font(ctx, 18 * u);
      ctx.fillStyle = '#333';
      ctx.textAlign = 'right';
      ctx.fillText('このページ ' + U.framesToLabel(pageFrames, fps) + '　／　総尺 ' + U.framesToLabel(totalFrames, fps) +
        '（' + list.length + 'カット）', x1, pg.H - M + 8 * u);
      ctx.textAlign = 'left';
      if (!list.length) {
        font(ctx, 22 * u);
        ctx.fillStyle = '#888';
        ctx.fillText('タイムラインにカットがありません（Vコンテのシーン構成でオンのシーンが書き出されます）', x0 + 20 * u, rowsTop + 50 * u);
      }
      pages.push(pg);
    }
    return pages;
  }

  // ------------------------------------------------------------
  // マインドマップ型
  // ------------------------------------------------------------
  function mapPages(opts) {
    const st = Store.settings();
    const ratio = U.aspectRatio(st.aspect);
    const cards = Store.activeCards();
    // 向きはマップの形に合わせる（横に広ければ横向き、縦に長ければ縦向き）
    let landscape = true;
    if (cards.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      cards.forEach(function (c) {
        x0 = Math.min(x0, c.mapPos.x); y0 = Math.min(y0, c.mapPos.y);
        x1 = Math.max(x1, c.mapPos.x + C.CARD_W); y1 = Math.max(y1, c.mapPos.y + C.CARD_H_ESTIMATE);
      });
      landscape = (x1 - x0) >= (y1 - y0);
    }
    const pg = newPage(opts.paper, landscape);
    const ctx = pg.ctx, u = pg.u;
    const M = 50 * u;
    ctx.fillStyle = '#111';
    font(ctx, 30 * u, true);
    ctx.fillText((Store.project().title || '無題の作品') + '　マップ', M, M + 30 * u);
    font(ctx, 16 * u);
    ctx.fillStyle = '#666';
    ctx.textAlign = 'right';
    ctx.fillText(new Date().toLocaleDateString() + '　カード' + cards.length + '枚', pg.W - M, M + 26 * u);
    ctx.textAlign = 'left';
    if (!cards.length) return [pg];

    // カードの大きさ（ワールド座標）：サムネ＋文字3行まで
    const CW = C.CARD_W;
    const thumbH = CW / ratio;
    const measure = document.createElement('canvas').getContext('2d');
    font(measure, 13);
    const info = new Map();
    cards.forEach(function (c) {
      const lines = wrap(measure, c.text || '', CW - 16, 3);
      info.set(c.id, { lines: lines, h: thumbH + 12 + Math.max(1, lines.length) * 17 });
    });
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    cards.forEach(function (c) {
      bx0 = Math.min(bx0, c.mapPos.x); by0 = Math.min(by0, c.mapPos.y);
      bx1 = Math.max(bx1, c.mapPos.x + CW); by1 = Math.max(by1, c.mapPos.y + info.get(c.id).h);
    });
    const top = M + 60 * u;
    const availW = pg.W - M * 2, availH = pg.H - top - M;
    const s = Math.min(availW / (bx1 - bx0), availH / (by1 - by0), C.PDF_MAP_MAX_SCALE * u);
    const ox = M + (availW - (bx1 - bx0) * s) / 2 - bx0 * s;
    const oy = top + (availH - (by1 - by0) * s) / 2 - by0 * s;
    const X = function (x) { return ox + x * s; }, Y = function (y) { return oy + y * s; };

    // 親子線（マップと同じ形の曲線）
    ctx.lineWidth = Math.max(1, 2 * s);
    cards.forEach(function (c) {
      const p = c.parentId && Store.get(c.parentId);
      if (!p || p.status !== 'active') return;
      const lc = Store.colorOf(c);
      ctx.strokeStyle = lc ? lc.line : '#9aa1ab';
      const ph = info.get(p.id).h, ch = info.get(c.id).h;
      const pc = { x: p.mapPos.x + CW / 2, y: p.mapPos.y + ph / 2 }, cc = { x: c.mapPos.x + CW / 2, y: c.mapPos.y + ch / 2 };
      const right = cc.x >= pc.x;
      const sx = pc.x + (right ? CW / 2 : -CW / 2), ex = cc.x + (right ? -CW / 2 : CW / 2);
      const k = Math.max(30, Math.abs(ex - sx) / 2) * (right ? 1 : -1);
      ctx.beginPath();
      ctx.moveTo(X(sx), Y(pc.y));
      ctx.bezierCurveTo(X(sx + k), Y(pc.y), X(ex - k), Y(cc.y), X(ex), Y(cc.y));
      ctx.stroke();
    });
    // カード
    const nums = Store.cutNumbers();
    cards.forEach(function (c) {
      const inf = info.get(c.id);
      const x = X(c.mapPos.x), y = Y(c.mapPos.y), w = CW * s, h = inf.h * s;
      const col = Store.colorOf(c);
      ctx.save();
      roundRect(ctx, x, y, w, h, 8 * s);
      ctx.fillStyle = col ? col.bg : '#fff';
      ctx.fill();
      ctx.clip();
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(x, y, w, thumbH * s);
      // 絵（用紙全体を枠に収める）
      const paper = c.paper || { w: 1, h: 1 };
      const pw = C.DRAW_BASE_W * paper.w, ph = (C.DRAW_BASE_W / ratio) * paper.h;
      const k = Math.min(w / pw, (thumbH * s) / ph);
      // 透明な層に描いてから重ねる（消しゴムで紙に穴があいて黒くならないように）
      if (c.strokes.length) {
        ctx.drawImage(AP.Draw.strokesLayer(c.strokes, pw * k, ph * k, k), x + (w - pw * k) / 2, y + (thumbH * s - ph * k) / 2);
      }
      ctx.restore();
      ctx.save();
      roundRect(ctx, x, y, w, h, 8 * s);
      ctx.strokeStyle = col ? col.border : '#c9ced6';
      ctx.lineWidth = Math.max(1, 1.5 * s);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#111';
      font(ctx, 13 * s);
      drawLines(ctx, inf.lines, x + 8 * s, y + thumbH * s + 18 * s, 17 * s);
      const n = nums.get(c.id);
      if (n) {
        font(ctx, 11 * s, true);
        const label = n.map(function (v) { return '#' + v; }).join(' ');
        const lw = ctx.measureText(label).width + 10 * s;
        ctx.fillStyle = '#2f6fde';
        ctx.fillRect(x + 4 * s, y + 4 * s, lw, 16 * s);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 9 * s, y + 16 * s);
      }
    });
    return [pg];
  }

  // ------------------------------------------------------------
  // 書き出しの画面
  // ------------------------------------------------------------
  let back = null;
  const choice = { kind: 'storyboard', paper: 'A4', perPage: C.PDF_CUTS_PER_PAGE };

  async function build(opts) {
    const pages = opts.kind === 'map' ? mapPages(opts) : storyboardPages(opts);
    const blob = await makePdf(pages);
    const name = String(Store.project().title || '無題の作品').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) +
      (opts.kind === 'map' ? '_マップ' : '_絵コンテ') + '.pdf';
    return { blob: blob, name: name, pages: pages.length };
  }

  async function exportPdf() {
    U.toast('PDFを作っています…');
    try {
      const r = await build(choice);
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      U.toast('「' + r.name + '」を保存しました（' + r.pages + 'ページ）');
      close();
    } catch (e) {
      console.error(e);
      U.toast('PDFを作れませんでした：' + e.message);
    }
  }

  function render() {
    const body = back.querySelector('.pdf-body');
    const seg = function (title, items, key) {
      const row = document.createElement('div');
      row.className = 'cam-row';
      row.innerHTML = '<div class="cam-label">' + title + '</div>';
      const g = document.createElement('div');
      g.className = 'cam-seg';
      items.forEach(function (it) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.label;
        b.dataset.v = String(it.id);
        if (choice[key] === it.id) b.classList.add('active');
        b.addEventListener('click', function () { choice[key] = it.id; render(); });
        g.appendChild(b);
      });
      row.appendChild(g);
      return row;
    };
    body.innerHTML = '';
    body.appendChild(seg('形式', [
      { id: 'storyboard', label: '絵コンテ用紙' },
      { id: 'map', label: 'マインドマップ型' },
    ], 'kind'));
    body.appendChild(seg('用紙', [{ id: 'A4', label: 'A4' }, { id: 'A3', label: 'A3' }], 'paper'));
    if (choice.kind === 'storyboard') {
      body.appendChild(seg('1ページ', [4, 5, 6].map(function (n) { return { id: n, label: n + 'カット' }; }), 'perPage'));
    }
    const note = document.createElement('p');
    note.className = 'pdf-note';
    const n = Store.playlist().length;
    note.textContent = choice.kind === 'storyboard'
      ? 'Vコンテのシーン構成でオンにしたシーンを、その順に書き出します（' + n + 'カット・' +
        Math.max(1, Math.ceil(n / choice.perPage)) + 'ページ）。縦向き。画面にはカメラワークの始まりのコマが入ります。'
      : 'マップ全体を1ページに収めて書き出します（カード' + Store.activeCards().length + '枚）。向きはマップの形に合わせて縦・横を選びます。';
    body.appendChild(note);
  }

  function open() {
    if (!back) {
      back = document.createElement('div');
      back.className = 'dialog-back pdf-back';
      back.innerHTML =
        '<div class="dialog pdf-dialog" role="dialog">' +
        '  <div class="dialog-title">PDFに書き出す</div>' +
        '  <div class="pdf-body"></div>' +
        '  <div class="dialog-buttons"><button type="button" class="pdf-cancel">やめる</button>' +
        '  <button type="button" class="primary pdf-go">書き出す</button></div>' +
        '</div>';
      document.body.appendChild(back);
      back.querySelector('.pdf-cancel').addEventListener('click', close);
      back.querySelector('.pdf-go').addEventListener('click', exportPdf);
      back.addEventListener('pointerdown', function (e) { if (e.target === back) close(); });
      document.addEventListener('keydown', function (e) {
        if (!back.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      }, true);
    }
    back.hidden = false;
    render();
  }

  function close() { if (back) back.hidden = true; }

  function init() {
    document.getElementById('btn-pdf').addEventListener('click', open);
  }

  AP.Pdf = {
    init: init,
    open: open,
    close: close,
    isOpen: function () { return !!back && !back.hidden; },
    build: build,
    makePdf: makePdf,
  };
})();
