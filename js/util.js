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
  // action: { label, fn, ms } を渡すと、押せるボタン付きで（ms の間）出す
  U.toast = function (msg, action) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('has-action', !!action);
    if (action) {
      const ver = AP.Store && AP.Store.version ? AP.Store.version() : null;
      el.dataset.ver = ver === null ? '' : String(ver);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', function () {
        el.classList.remove('show', 'has-action');
        action.fn();
      });
      el.appendChild(b);
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show', 'has-action'); }, action && action.ms ? action.ms : 2200);
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

  // 文字を入力してもらう小さなダイアログ。保存なら文字、やめたら null を返す Promise
  U.editText = function (title, value, placeholder) {
    return new Promise(function (resolve) {
      const back = document.createElement('div');
      back.className = 'dialog-back';
      back.innerHTML =
        '<div class="dialog" role="dialog"><div class="dialog-title"></div>' +
        '<textarea class="dialog-textarea" rows="4"></textarea>' +
        '<div class="dialog-buttons"><button type="button" data-v="cancel">やめる</button>' +
        '<button type="button" class="primary" data-v="ok">保存</button></div></div>';
      back.querySelector('.dialog-title').textContent = title;
      const ta = back.querySelector('textarea');
      ta.value = value || '';
      ta.placeholder = placeholder || '';
      const done = function (v) {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(v);
      };
      const onKey = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); done(ta.value); }
        else e.stopPropagation();
      };
      back.querySelector('[data-v="cancel"]').addEventListener('click', function () { done(null); });
      back.querySelector('[data-v="ok"]').addEventListener('click', function () { done(ta.value); });
      back.addEventListener('pointerdown', function (e) { if (e.target === back) done(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      ta.focus();
    });
  };

  AP.util = U;
})();
