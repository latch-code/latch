// A real, decodable PNG of one colour, for fakes that hand out pictures: no media files in the repository.
import { crc32, deflateSync } from 'node:zlib'

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

/** A `width`×`height` RGB PNG filled with `rgb`, shaded left to right so a crop or stretch shows. */
export function png(width, height, rgb = [74, 120, 220]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3
      const shade = 0.6 + (0.4 * x) / Math.max(1, width - 1)
      rows[at] = Math.round(rgb[0] * shade)
      rows[at + 1] = Math.round(rgb[1] * shade)
      rows[at + 2] = Math.round(rgb[2] * shade)
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
