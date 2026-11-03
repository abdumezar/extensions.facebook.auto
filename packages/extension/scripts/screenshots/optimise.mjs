// Keeps only the chunks a PNG needs to be drawn, so a picture carries no text, time,
// colour-profile or EXIF metadata — whatever the browser it came from chose to add.
//
// The pixels and the compressed data are copied byte for byte. Re-compressing them was
// tried and gains nothing: node:zlib at level 9, with the default, filtered and RLE
// strategies, came out between 2% larger and 1% smaller than Chrome's own encoding of
// these flat, UI-style images, and a palette would soften the text.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

export function stripPngMetadata(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file");
  const kept = [SIGNATURE];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12; // length, type, data, CRC
    if (KEEP.has(png.toString("ascii", offset + 4, offset + 8))) kept.push(png.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(kept);
}
