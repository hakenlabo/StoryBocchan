/* 小さな道具：ID、尺の変換、トースト */
(function () {
  const U = {};

  U.uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  U.clamp = function (v, min, max) {
    return Math.max(min, Math.min(max, v));
  };

  // 尺：内部はコマ数。表示は「秒+コマ」 例) 60コマ@24fps → "2+12"
  U.framesToLabel = function (frames, fps) {
    const s = Math.floor(frames / fps);
    const k = frames % fps;
    return s + '+' + k;
  };

  // "2+12" / "2" / "+12" / "2.5" を受け付けてコマ数に。読めなければ null
  U.labelToFrames = function (label, fps) {
    const t = String(label).trim().replace(/＋/g, '+').replace(/[０-９．]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    let m = t.match(/^(\d*)\s*\+\s*(\d+)$/);
    if (m) return (parseInt(m[1] || '0', 10) * fps) + parseInt(m[2], 10);
    m = t.match(/^\d+(\.\d+)?$/);
    if (m) return Math.round(parseFloat(t) * fps);
    return null;
  };

  // 画面比 "16:9" → 数値（幅/高さ）
  U.aspectRatio = function (aspect) {
    const p = String(aspect).split(':');
    const r = parseFloat(p[0]) / parseFloat(p[1]);
    return isFinite(r) && r > 0 ? r : 16 / 9;
  };

  U.timeLabel = function (date) {
    const d = date || new Date();
    const z = function (n) { return (n < 10 ? '0' : '') + n; };
    return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  };

  let toastTimer = null;
  U.toast = function (msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  };

  // 選択肢つきの確認。choices: [{label, value, primary?}]。選んだ value（やめたら null）を返す Promise
  U.choose = function (title, message, choices) {
    return new Promise(function (resolve) {
      const back = document.createElement('div');
      back.className = 'dialog-back';
      const box = document.createElement('div');
      box.className = 'dialog';
      box.setAttribute('role', 'dialog');
      const h = document.createElement('div');
      h.className = 'dialog-title';
      h.textContent = title;
      const m = document.createElement('div');
      m.className = 'dialog-msg';
      m.textContent = message;
      const btns = document.createElement('div');
      btns.className = 'dialog-buttons';
      const done = function (v) {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(v);
      };
      const onKey = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      };
      choices.concat([{ label: 'やめる', value: null }]).forEach(function (c) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.label;
        if (c.primary) b.className = 'primary';
        if (c.value !== null && c.value !== undefined) b.dataset.value = c.value;
        b.addEventListener('click', function () { done(c.value === undefined ? null : c.value); });
        btns.appendChild(b);
      });
      box.appendChild(h);
      box.appendChild(m);
      box.appendChild(btns);
      back.appendChild(box);
      back.addEventListener('pointerdown', function (e) { if (e.target === back) done(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      const first = btns.querySelector('.primary') || btns.firstChild;
      if (first) first.focus();
    });
  };

  AP.util = U;
})();
