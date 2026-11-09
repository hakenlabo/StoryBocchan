/*
 * AP.Mp4：H.264 の映像（＋あれば AAC の音）の小さな MP4 を組み立てる（ライブラリを使わない方針のため自前）。
 * - 音：opts.audio = { samples: [{ data }], rate, channels, asc（AudioSpecificConfig） }。1サンプル＝1024 標本の AAC-LC。
 *   mdat には映像の塊のあとに音の塊を置く（トラックごとに1チャンク）。
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

    const audio = opts.audio && opts.audio.samples.length ? opts.audio : null;
    const AAC_FRAME = 1024;
    const aDurMedia = audio ? audio.samples.length * AAC_FRAME : 0;              // 音の timescale（＝rate）で
    const aDurMovie = audio ? Math.round(aDurMedia / audio.rate * timescale) : 0; // 映像の timescale で
    const movieDur = Math.max(duration, aDurMovie);

    // 長さ n の記述子（esds の中身）。中身は 127 バイト未満なので長さは1バイト
    function desc(tag, body) { return [tag, body.length].concat(body); }
    function audioTrak(dataOffset) {
      const a = audio;
      const n2 = a.samples.length;
      const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(aDurMovie), zeros(8), u16(0), u16(1), u16(0x0100), u16(0),
        MATRIX, u32(0), u32(0));
      const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(a.rate), u32(aDurMedia), u16(0x55c4), u16(0));
      const hdlr = full('hdlr', 0, 0, u32(0), str('soun'), zeros(12), str('SoundHandler'), [0]);
      const smhd = full('smhd', 0, 0, u16(0), u16(0));
      const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
      const asc = Array.prototype.slice.call(a.asc);
      const dcd = desc(0x04, [0x40, 0x15, 0, 0, 0].concat(u32(a.bitrate || 0), u32(a.bitrate || 0), desc(0x05, asc)));
      const esd = desc(0x03, u16(2).concat([0], dcd, desc(0x06, [0x02])));
      const esds = full('esds', 0, 0, esd);
      const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), u16(0), u16(0), u32(a.rate * 65536), esds);
      const stsd = full('stsd', 0, 0, u32(1), mp4a);
      const stts = full('stts', 0, 0, u32(1), u32(n2), u32(AAC_FRAME));
      const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(n2), u32(1));
      const sizes = new Uint8Array(n2 * 4);
      a.samples.forEach(function (s, i) { sizes.set(u32(s.data.length), i * 4); });
      const stsz = full('stsz', 0, 0, u32(0), u32(n2), sizes);
      const stco = full('stco', 0, 0, u32(1), u32(dataOffset));
      const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
      return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', smhd, dinf, stbl)));
    }

    const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));

    function moov(mdatDataOffset, audioOffset) {
      const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(movieDur), u32(0x00010000), u16(0x0100),
        zeros(10), MATRIX, zeros(24), u32(audio ? 3 : 2));
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
      return audio ? box('moov', mvhd, trak, audioTrak(audioOffset)) : box('moov', mvhd, trak);
    }

    // moov の大きさは stco の値によらないので、一度作って大きさを測ってから本番を作る
    const moovSize = moov(0, 0).length;
    let dataLen = 0, audioLen = 0;
    samples.forEach(function (s) { dataLen += s.data.length; });
    if (audio) audio.samples.forEach(function (s) { audioLen += s.data.length; });
    const mdatHeader = new Uint8Array([].concat(u32(dataLen + audioLen + 8), str('mdat')));
    const offset = ftyp.length + moovSize + 8;
    const parts = [ftyp, moov(offset, offset + dataLen), mdatHeader].concat(samples.map(function (s) { return s.data; }));
    if (audio) audio.samples.forEach(function (s) { parts.push(s.data); });
    return new Blob(parts, { type: 'video/mp4' });
  }

  AP.Mp4 = { build: build };
})();
