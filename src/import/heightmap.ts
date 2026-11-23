import {
  checkFloatSamples,
  checkRasterDimensions,
  encodeSamples,
  MAX_PROJECT_RASTER_BYTES,
  type HeightRaster,
} from '../model/heightRaster';
import { crc32 } from '../model/pngCrc';

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

async function readPngRows(idat: Blob, length: number) {
  const rows = new Uint8Array(length);
  const reader = idat.stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let used = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (used + value.length > length) {
        await reader.cancel();
        throw new Error('PNG image exceeds its declared dimensions.');
      }
      rows.set(value, used);
      used += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (used !== length) throw new Error('Truncated PNG pixels.');
  return rows;
}

function paeth(left: number, up: number, corner: number) {
  const estimate = left + up - corner;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dc = Math.abs(estimate - corner);
  if (dl <= du && dl <= dc) return left;
  return du <= dc ? up : corner;
}

/** Preserve linear integer samples, bypassing browser display profiles and 8-bit canvas conversion. */
async function decodePng(file: Uint8Array<ArrayBuffer>) {
  if (!pngSignature.every((value, i) => value === file[i]))
    throw new Error('Invalid PNG signature.');
  const view = new DataView(file.buffer);
  let width = 0,
    height = 0,
    depth = 0;
  let end = false,
    idatEnded = false;
  const compressed = new Uint8Array(file.length);
  let idatSize = 0;
  let seenData = false;
  for (let p = 8; p < file.length;) {
    if (p + 12 > file.length) throw new Error('Truncated PNG chunk header.');
    const count = view.getUint32(p);
    const next = p + 12 + count;
    if (next > file.length) throw new Error('Truncated PNG chunk.');
    const type = String.fromCharCode(...file.subarray(p + 4, p + 8));
    if (crc32(file.subarray(p + 4, next - 4)) !== view.getUint32(next - 4))
      throw new Error('The PNG checksum is invalid.');
    if (p === 8 && type !== 'IHDR') throw new Error('Missing PNG header.');
    if (seenData && type !== 'IDAT') idatEnded = true;
    if (type === 'IHDR') {
      if (p !== 8 || count !== 13) throw new Error('Invalid PNG header.');
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      checkRasterDimensions(width, height);
      depth = file[p + 16];
      if (
        (depth !== 8 && depth !== 16) ||
        file[p + 17] !== 0 ||
        file[p + 18] !== 0 ||
        file[p + 19] !== 0 ||
        file[p + 20] !== 0
      )
        throw new Error('Choose a non-interlaced grayscale PNG with 8 or 16 bits per sample.');
    } else if (type === 'IDAT') {
      if (idatEnded) throw new Error('PNG image chunks must be consecutive.');
      seenData = true;
      compressed.set(file.subarray(p + 8, next - 4), idatSize);
      idatSize += count;
    } else if (type === 'IEND') {
      if (count !== 0 || next !== file.length) throw new Error('Invalid PNG ending.');
      end = true;
    } else if ((file[p + 4] & 32) === 0) {
      throw new Error('Unsupported critical PNG chunk.');
    }
    p = next;
  }
  if (!end || !idatSize) throw new Error('Incomplete PNG image.');
  const bpp = depth / 8;
  const stride = width * bpp + 1;
  const rows = await readPngRows(new Blob([compressed.subarray(0, idatSize)]), height * stride);
  const samples = new Uint8Array(width * height * 2);
  let dest = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const filter = rows[row];
    if (filter > 4) throw new Error('Unknown PNG scanline filter.');
    for (let x = 0; x < stride - 1; x++) {
      const i = row + 1 + x;
      const left = x >= bpp ? rows[i - bpp] : 0;
      const up = y > 0 ? rows[i - stride] : 0;
      const corner = y > 0 && x >= bpp ? rows[i - stride - bpp] : 0;
      switch (filter) {
        case 1:
          rows[i] += left;
          break;
        case 2:
          rows[i] += up;
          break;
        case 3:
          rows[i] += (left + up) >>> 1;
          break;
        case 4:
          rows[i] += paeth(left, up, corner);
          break;
      }
    }
    for (let i = row + 1; i < row + stride; i += bpp) {
      // Expand 8-bit gray exactly (x * 257), or swap the PNG's big-endian UInt16.
      samples[dest++] = rows[i + bpp - 1];
      samples[dest++] = rows[i];
    }
  }
  return { width, height, format: 'u16le' as const, samples };
}

export async function importHeightRaster(file: File): Promise<HeightRaster> {
  if (file.size > MAX_PROJECT_RASTER_BYTES)
    throw new Error('Choose a heightmap file of 16 MiB or less.');
  const name = file.name.slice(0, 160);
  if (/\.png$/i.test(file.name)) {
    const { width, height, format, samples } = await decodePng(
      new Uint8Array(await file.arrayBuffer()),
    );
    return { name, width, height, format, data: encodeSamples(samples) };
  }
  if (!/\.(r16|r32|raw)$/i.test(file.name))
    throw new Error('Choose a grayscale PNG, R16, R32, or RAW file.');
  const float = /(?:\.r32|f32le\.raw)$/i.test(file.name);
  const side = Math.sqrt(file.size / (float ? 4 : 2));
  if (!Number.isInteger(side))
    throw new Error('RAW heightmaps must be headerless square sample grids.');
  checkRasterDimensions(side, side);
  const samples = new Uint8Array(await file.arrayBuffer());
  if (float) checkFloatSamples(samples);
  return {
    name,
    width: side,
    height: side,
    format: float ? 'f32le' : 'u16le',
    data: encodeSamples(samples),
  };
}
