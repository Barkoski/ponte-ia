/* Gera build/icon.ico e build/icon.png sem nenhuma dependência externa.
   Desenha dois círculos sobrepostos — Claude (terracota) e ChatGPT (verde-azulado) —
   sobre um quadrado arredondado cor de areia. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AREIA   = [244, 241, 236];
const TERRA   = [181, 113, 78];
const VERDE   = [76, 133, 119];
const MISTURA = [128, 123, 98];   // interseção dos dois

function draw(S){
  const px = Buffer.alloc(S * S * 4);
  const r  = S * 0.27;                    // raio dos círculos
  const cy = S * 0.5;
  const cxA = S * 0.38, cxB = S * 0.62;   // centros, com sobreposição
  const radius = S * 0.22;                // canto arredondado do fundo
  const AA = 1.2;                         // suavização de borda em px

  // cobertura de um disco no ponto (x,y), 0..1
  const disc = (x, y, cx) => {
    const d = Math.hypot(x - cx, y - cy);
    return Math.min(1, Math.max(0, (r - d) / AA + 0.5));
  };
  // cobertura do quadrado arredondado
  const rrect = (x, y) => {
    const m = S * 0.055;                  // margem
    const qx = Math.max(m + radius - x, 0, x - (S - m - radius));
    const qy = Math.max(m + radius - y, 0, y - (S - m - radius));
    const d  = Math.hypot(qx, qy) - radius;
    const inside = (x >= m && x <= S - m && y >= m && y <= S - m);
    if (qx === 0 && qy === 0) return inside ? 1 : 0;
    return Math.min(1, Math.max(0, -d / AA + 0.5));
  };

  for (let y = 0; y < S; y++){
    for (let x = 0; x < S; x++){
      const px0 = x + 0.5, py0 = y + 0.5;
      const bg = rrect(px0, py0);
      const a = disc(px0, py0, cxA);
      const b = disc(px0, py0, cxB);

      let col = AREIA, alpha = bg;
      if (a > 0 || b > 0){
        const both = Math.min(a, b);
        // mistura das cores conforme a cobertura de cada disco
        const wA = a - both, wB = b - both, wM = both;
        const tot = wA + wB + wM;
        if (tot > 0){
          const mix = [0,1,2].map(i =>
            (TERRA[i]*wA + VERDE[i]*wB + MISTURA[i]*wM) / tot);
          const cov = Math.min(1, Math.max(a, b));
          col = [0,1,2].map(i => AREIA[i]*(1-cov) + mix[i]*cov);
        }
      }
      const o = (y * S + x) * 4;
      px[o]   = Math.round(col[0]);
      px[o+1] = Math.round(col[1]);
      px[o+2] = Math.round(col[2]);
      px[o+3] = Math.round(alpha * 255);
    }
  }
  return px;
}

function png(S, rgba){
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++){
    raw[y * (S * 4 + 1)] = 0;                                   // filtro none
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td  = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let TBL = null;
function crc32(buf){
  if (!TBL){
    TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++){
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TBL[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function ico(sizes){
  const imgs = sizes.map(S => png(S, draw(S)));
  const head = Buffer.alloc(6 + 16 * imgs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2);
  head.writeUInt16LE(imgs.length, 4);
  let off = head.length;
  imgs.forEach((img, i) => {
    const S = sizes[i], e = 6 + i * 16;
    head[e]   = S >= 256 ? 0 : S;
    head[e+1] = S >= 256 ? 0 : S;
    head[e+2] = 0; head[e+3] = 0;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(img.length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += img.length;
  });
  return Buffer.concat([head, ...imgs]);
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, {recursive: true});
fs.writeFileSync(path.join(out, 'icon.ico'), ico([16, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(out, 'icon.png'), png(256, draw(256)));
console.log('icon.ico e icon.png gerados em build/');
