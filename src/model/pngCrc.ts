const table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
