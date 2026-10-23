/*
 * AP.Zip：小さなzipの読み書き（ライブラリを使わない方針のため自前）。
 * - 書き出しは無圧縮（store）。中身はJSONとPNGなので、圧縮してもあまり小さくならない。
 * - 読み込みは無圧縮と deflate に対応（deflate はブラウザの DecompressionStream を使う）。
 * - ファイル名はUTF-8（日本語のファイル名も可）。
 */
(function () {
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(data);
  }

  // files: [{ name, data: string|Uint8Array|ArrayBuffer }] → Blob
  function create(files) {
    const enc = new TextEncoder();
    const now = dosTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach(function (f) {
      const name = enc.encode(f.name);
      const data = toBytes(f.data);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);      // UTF-8 のファイル名
      local.setUint16(8, 0, true);           // 無圧縮
      local.setUint16(10, now.time, true);
      local.setUint16(12, now.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, name, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, now.time, true);
      cen.setUint16(14, now.date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);
      offset += 30 + name.length + data.length;
    });
    const cenSize = central.reduce(function (s, b) { return s + b.byteLength; }, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end.buffer]), { type: 'application/zip' });
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('このブラウザでは圧縮されたzipを読めません');
    const ds = new DecompressionStream('deflate-raw');
    const out = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  // ArrayBuffer → { 'ファイル名': Uint8Array }
  async function read(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    }
    if (e < 0) throw new Error('zipファイルではありません');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const dec = new TextDecoder();
    const files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zipファイルが壊れています');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lofs = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      const dataStart = lofs + 30 + dv.getUint16(lofs + 26, true) + dv.getUint16(lofs + 28, true);
      const raw = u8.subarray(dataStart, dataStart + csize);
      if (method === 0) files[name] = raw;
      else if (method === 8) files[name] = await inflate(raw);
      p += 46 + nlen + xlen + clen;
    }
    return files;
  }

  AP.Zip = { create: create, read: read, crc32: crc32 };
})();
