/*
 * AP.Mp4：H.264 の映像だけの小さな MP4 を組み立てる（ライブラリを使わない方針のため自前。音声なし）。
 * - WebCodecs の VideoEncoder が出したチャンク（avc 形式＝長さ付きNAL）と、decoderConfig.description（avcC）を受け取る。
 * - moov を先頭に置く（faststart）。サンプルは1つのチャンクにまとめて mdat に並べる。
 * - 1コマの長さはすべて同じ（timescale＝fps×100、1コマ＝100）。Bフレームは使わない前提（ctts なし）。
 */
(function () {
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function str(s) { return Array.prototype.map.call(s, function (c) { return c.charCodeAt(0); }); }
  function zeros(n) { return new Array(n).fill(0); }

  // box(type, ...中身) → Uint8Array。中身は数値の配列か Uint8Array
  function box(type) {
    const parts = Array.prototype.slice.call(arguments, 1);
    let len = 8;
    parts.forEach(function (p) { len += p.length; });
    const out = new Uint8Array(len);
    out.set(u32(len), 0);
    out.set(str(type), 4);
    let o = 8;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }
  function full(type, version, flags) {
    return box.apply(null, [type, [version].concat(u32(flags).slice(1))].concat(Array.prototype.slice.call(arguments, 3)));
  }

  const MATRIX = [].concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

  /**
   * samples: [{ data: Uint8Array, key: bool }]、avcC: Uint8Array（decoderConfig.description）
   * → Blob（video/mp4）
   */
  function build(opts) {
    const W = opts.width, H = opts.height, fps = opts.fps;
    const samples = opts.samples;
    const n = samples.length;
    const timescale = fps * 100, delta = 100, duration = n * delta;

    const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));

    function moov(mdatDataOffset) {
      const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100),
        zeros(10), MATRIX, zeros(24), u32(2));
      const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0), u16(0),
        MATRIX, u32(W << 16), u32(H << 16));
      const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)); // 言語 und
      const hdlr = full('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('VideoHandler'), [0]);
      const vmhd = full('vmhd', 0, 1, zeros(8));
      const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
      const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(W), u16(H), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
        zeros(32), u16(0x0018), u16(0xffff), box('avcC', opts.avcC));
      const stsd = full('stsd', 0, 0, u32(1), avc1);
      const stts = full('stts', 0, 0, u32(1), u32(n), u32(delta));
      const keys = [];
      samples.forEach(function (s, i) { if (s.key) keys.push(i + 1); });
      const stss = full('stss', 0, 0, u32(keys.length), [].concat.apply([], keys.map(u32)));
      const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
      const sizes = new Uint8Array(n * 4);
      samples.forEach(function (s, i) { sizes.set(u32(s.data.length), i * 4); });
      const stsz = full('stsz', 0, 0, u32(0), u32(n), sizes);
      const stco = full('stco', 0, 0, u32(1), u32(mdatDataOffset));
      const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
      const minf = box('minf', vmhd, dinf, stbl);
      const mdia = box('mdia', mdhd, hdlr, minf);
      const trak = box('trak', tkhd, mdia);
      return box('moov', mvhd, trak);
    }

    // moov の大きさは stco の値によらないので、一度作って大きさを測ってから本番を作る
    const moovSize = moov(0).length;
    let dataLen = 0;
    samples.forEach(function (s) { dataLen += s.data.length; });
    const mdatHeader = new Uint8Array([].concat(u32(dataLen + 8), str('mdat')));
    const offset = ftyp.length + moovSize + 8;
    return new Blob([ftyp, moov(offset), mdatHeader].concat(samples.map(function (s) { return s.data; })), { type: 'video/mp4' });
  }

  AP.Mp4 = { build: build };
})();
