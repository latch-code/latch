import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_AVATAR_IMAGE } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { syncDirectory } from '@latch/core/node-kit'

const HASH = /^[a-f0-9]{64}$/u
/** What the Host stores and serves is always this: its own PNG, `size` pixels a side, never larger than this many bytes. */
const STORED_BYTES = 512 * 1024
const CODEC_MS = 10_000
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The kind of picture a file is, by its first bytes alone: never its name or the type it was sent as. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | undefined {
  const at = (offset: number, text: string) =>
    bytes.length >= offset + text.length && [...text].every((letter, index) => bytes[offset + index] === letter.charCodeAt(0))
  if (bytes.length >= 8 && PNG_MAGIC.every((byte, index) => bytes[index] === byte)) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp'
  return undefined
}

/**
 * The decoder, run as its own short-lived process with an empty environment: the Host itself parses no image. It reads
 * one PNG from stdin and accepts only what a canvas writes (8-bit RGB or RGBA, not interlaced), with every chunk's
 * length and CRC checked, the declared size bounded before anything is inflated and the inflated size bounded by it. It
 * takes the pixels only (centre square, averaged down to a fixed size) and writes a new PNG of IHDR, IDAT and IEND to
 * stdout: no metadata, no other chunk, nothing after the end. Anything else exits with a reason on stderr.
 */
const CODEC_SOURCE = String.raw`
const { crc32, deflateSync, inflateSync } = require('node:zlib')
const LIMITS = ${JSON.stringify(AGENT_AVATAR_IMAGE)}
const fail = reason => {
  process.stderr.write(reason)
  process.exit(3)
}
const chunks = []
let total = 0
process.stdin.on('data', chunk => {
  total += chunk.length
  if (total > LIMITS.bytes) fail('too-large')
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  try {
    process.stdout.write(encode(decode(Buffer.concat(chunks))), () => process.exit(0))
  } catch (error) {
    fail(error && typeof error.reason === 'string' ? error.reason : 'unreadable')
  }
})
const refuse = reason => {
  throw Object.assign(new Error(reason), { reason })
}
function decode(file) {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (file.length < 8 || magic.some((byte, index) => file[index] !== byte)) refuse('unreadable')
  let offset = 8
  let header
  let ended = false
  const data = []
  while (!ended) {
    if (offset + 12 > file.length) refuse('unreadable')
    const length = file.readUInt32BE(offset)
    if (length > file.length - offset - 12) refuse('unreadable')
    const type = file.toString('latin1', offset + 4, offset + 8)
    const body = file.subarray(offset + 8, offset + 8 + length)
    if (crc32(file.subarray(offset + 4, offset + 8 + length)) !== file.readUInt32BE(offset + 8 + length)) refuse('unreadable')
    offset += 12 + length
    if (!header) {
      if (type !== 'IHDR' || length !== 13) refuse('unreadable')
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      }
      if (header.width < 1 || header.height < 1) refuse('unreadable')
      // Before anything is inflated: a picture that declares more than this is refused by what it says.
      if (header.width > LIMITS.maxSide || header.height > LIMITS.maxSide) refuse('too-many-pixels')
      if (header.width < LIMITS.minSide || header.height < LIMITS.minSide) refuse('too-small')
      if (header.depth !== 8 || (header.colour !== 2 && header.colour !== 6) || header.compression || header.filter || header.interlace)
        refuse('unsupported')
    } else if (type === 'IHDR') refuse('unreadable')
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') ended = true
    // PLTE is only a suggestion beside true colour; every other chunk a decoder must understand is not understood here.
    else if (type !== 'PLTE' && (type.charCodeAt(0) & 0x20) === 0) refuse('unsupported')
  }
  if (!data.length) refuse('unreadable')
  const channels = header.colour === 6 ? 4 : 3
  const stride = header.width * channels
  const expected = header.height * (stride + 1)
  let raw
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected })
  } catch {
    refuse('unreadable')
  }
  if (raw.length !== expected) refuse('unreadable')
  const pixels = Buffer.alloc(header.width * header.height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    if (filter > 4) refuse('unreadable')
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const corner = x >= channels ? previous[x - channels] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - corner
        const a = Math.abs(estimate - left)
        const b = Math.abs(estimate - up)
        const c = Math.abs(estimate - corner)
        predicted = a <= b && a <= c ? left : b <= c ? up : corner
      }
      line[x] = (line[x] + predicted) & 0xff
    }
    for (let x = 0; x < header.width; x++) {
      const to = (y * header.width + x) * 4
      pixels[to] = line[x * channels]
      pixels[to + 1] = line[x * channels + 1]
      pixels[to + 2] = line[x * channels + 2]
      pixels[to + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    previous = line
  }
  return { width: header.width, height: header.height, pixels }
}
function encode(image) {
  const size = LIMITS.size
  const side = Math.min(image.width, image.height)
  const left = (image.width - side) >> 1
  const top = (image.height - side) >> 1
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * side) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * side) / size))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * side) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * side) / size))
      // Colour is averaged by how opaque it is, so a transparent pixel's hidden colour adds nothing.
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const from = ((top + sy) * image.width + left + sx) * 4
          const opacity = image.pixels[from + 3]
          red += image.pixels[from] * opacity
          green += image.pixels[from + 1] * opacity
          blue += image.pixels[from + 2] * opacity
          alpha += opacity
        }
      const to = y * (size * 4 + 1) + 1 + x * 4
      const count = (y1 - y0) * (x1 - x0)
      if (alpha > 0) {
        raw[to] = Math.round(red / alpha)
        raw[to + 1] = Math.round(green / alpha)
        raw[to + 2] = Math.round(blue / alpha)
        raw[to + 3] = Math.round(alpha / count)
      }
    }
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'latin1')
    body.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(size, 0)
  head.writeUInt32BE(size, 4)
  head[8] = 8
  head[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
`

const REFUSALS: Record<string, () => AppError> = {
  'too-large': () => tooLarge(),
  'too-many-pixels': () =>
    new AppError(413, 'agent-avatar-too-large', `图片太大，每边最多 ${AGENT_AVATAR_IMAGE.maxSide} 像素。`, { limit: 'pixels' }),
  'too-small': () => new AppError(422, 'agent-avatar-unreadable', `图片太小，每边至少 ${AGENT_AVATAR_IMAGE.minSide} 像素。`),
  unsupported: () => new AppError(415, 'agent-avatar-type', '这种 PNG 读不了，请换一张图片。'),
}
const tooLarge = () =>
  new AppError(413, 'agent-avatar-too-large', `图片太大，最多 ${AGENT_AVATAR_IMAGE.bytes / 1024 / 1024} MB。`, { limit: 'bytes' })
const unreadable = () => new AppError(422, 'agent-avatar-unreadable', '读不了这张图片。')

/** Whether these bytes are exactly what the decoder writes: checked by fixed offsets, not by parsing. */
function ownPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 + 25 + 12 + 12
    && bytes.length <= STORED_BYTES
    && PNG_MAGIC.equals(bytes.subarray(0, 8))
    && bytes.readUInt32BE(8) === 13
    && bytes.toString('latin1', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) === AGENT_AVATAR_IMAGE.size
    && bytes.readUInt32BE(20) === AGENT_AVATAR_IMAGE.size
    && bytes[24] === 8
    && bytes[25] === 6
    && bytes.toString('latin1', bytes.length - 8, bytes.length - 4) === 'IEND'
  )
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * A person's picture as the Host keeps it. The kind comes from the first bytes: anything but PNG, JPEG or WebP is
 * refused; a JPEG or WebP is refused too, by name, because this computer decodes only PNG (the page converts those in
 * the browser before it uploads). A PNG goes through the decoder process, one at a time, and only that process's own
 * PNG comes back. Refusals say which: too large, wrong type, could not read.
 */
export function reencodeAvatar(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > AGENT_AVATAR_IMAGE.bytes) return Promise.reject(tooLarge())
  const kind = sniffImage(bytes)
  if (!kind) return Promise.reject(new AppError(415, 'agent-avatar-type', '只能用 PNG、JPEG 或 WebP 图片。'))
  if (kind !== 'png')
    return Promise.reject(new AppError(415, 'agent-avatar-convert', '这台电脑只读 PNG：JPEG 和 WebP 要先在页面里转成 PNG 再上传。'))
  const run = queue.catch(() => {}).then(() => decodeInChild(bytes))
  queue = run
  return run
}

function decodeInChild(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-sigusr1', '--max-old-space-size=128', '-e', CODEC_SOURCE], {
      env: {},
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    let size = 0
    let reason = ''
    let settled = false
    const finish = (error?: AppError, value?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      if (error) reject(error)
      else resolve(value!)
    }
    const timer = setTimeout(() => {
      finish(unreadable())
    }, CODEC_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > STORED_BYTES) finish(unreadable())
      else out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (reason.length < 64) reason += chunk.toString('latin1').slice(0, 64)
    })
    child.on('error', () => {
      finish(unreadable())
    })
    child.stdin.on('error', () => {})
    child.on('close', code => {
      const made = Buffer.concat(out)
      if (code === 0 && ownPng(made)) finish(undefined, made)
      else finish((Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason]! : unreadable)())
    })
    child.stdin.end(bytes)
  })
}

/**
 * The pictures of Agents, by the SHA-256 of the Host's own re-encoded bytes: `agents/avatars/<hash>.png`, 0600 in a 0700
 * directory. A picture no Agent names any more is removed.
 */
export class AvatarImages {
  private constructor(private readonly directory: string) {}

  static async open(dataDir: string): Promise<AvatarImages> {
    const directory = join(dataDir, 'agents', 'avatars')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const folder = await lstat(directory)
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new AppError(500, 'agent-private', 'Agent 头像目录必须是只有本人可访问的目录。')
    return new AvatarImages(directory)
  }

  /** Decodes and re-encodes, then keeps the result; answers its hash. The same picture is kept once. */
  async put(bytes: Buffer): Promise<string> {
    const made = await reencodeAvatar(bytes)
    const hash = createHash('sha256').update(made).digest('hex')
    if (await this.read(hash).catch(() => undefined)) return hash
    // Written whole under another name, then moved into place: a reader never sees part of a picture.
    const temporary = join(this.directory, `.${hash}-${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(made)
      await file.sync()
      await file.close()
      await rename(temporary, this.path(hash))
    } catch (error) {
      await file.close().catch(() => {})
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await syncDirectory(this.directory).catch(() => {})
    return hash
  }

  /** The stored bytes, re-checked as the Host's own picture of that hash; anything else reads as missing. */
  async read(hash: string): Promise<Buffer> {
    const missing = () => new AppError(404, 'agent-avatar-missing', '找不到这张头像。')
    if (!HASH.test(hash)) throw missing()
    let bytes: Buffer
    try {
      const file = await open(this.path(hash), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > STORED_BYTES) throw missing()
        bytes = await file.readFile()
      } finally {
        await file.close()
      }
    } catch {
      throw missing()
    }
    if (!ownPng(bytes) || createHash('sha256').update(bytes).digest('hex') !== hash) throw missing()
    return bytes
  }

  /**
   * Removes every stored picture that `used` does not name. Failures leave files for the next sweep. `partial`, at start
   * only, when no upload of this Host can be writing: files an upload cut short left half-written go too.
   */
  async sweep(used: ReadonlySet<string>, partial = false): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[])
    for (const name of names) {
      // Only pictures: a file still being written has another name and is left alone.
      const hash = /^([a-f0-9]{64})\.png$/u.exec(name)?.[1]
      if (hash ? used.has(hash) : !(partial && name.endsWith('.tmp'))) continue
      await rm(join(this.directory, name), { force: true }).catch(() => {})
    }
  }

  private path(hash: string): string {
    return join(this.directory, `${hash}.png`)
  }
}
