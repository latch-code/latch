// An Agent's home, by descriptor: written into a zip archive (stored, no compression) or removed for good. The Host
// checks the home against its record and authorizes the request before this process starts; this process checks it
// again on the handles it opens and never resolves a path below the start directory again: every step below the home
// is `openat`, `fstatat` and `unlinkat` on a directory it holds open, without following a link. A link inside the home
// is never followed: it is left out of an archive and removed as a link. Another device below the home stops either
// operation before anything is written or removed.
import Darwin
import Foundation

private let inputLimit = 65_536
private let nameLimit = 255
private let pathLimit = 4096
private let archiveEntries = 50_000
private let archiveBytes: UInt64 = 2 * 1024 * 1024 * 1024
private let removeEntries = 500_000
private let depthLimit = 64

private enum Failure: Error {
  case invalidInput, changed, unreadable, mount, busy, budget, mismatch, unwritable
  case tooLarge(entries: Int, bytes: UInt64)

  var code: String {
    switch self {
    case .invalidInput: "invalid-input"
    case .changed: "changed"
    case .unreadable: "unreadable"
    case .mount: "mount"
    case .busy: "busy"
    case .budget: "budget"
    case .mismatch: "mismatch"
    case .unwritable: "unwritable"
    case .tooLarge: "too-large"
    }
  }
}

private struct Identity: Equatable {
  let device: UInt64
  let inode: UInt64
  init(_ value: stat) {
    device = UInt64(bitPattern: Int64(value.st_dev))
    inode = value.st_ino
  }
  init?(_ text: String) {
    let parts = text.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2, let device = UInt64(parts[0]), let inode = UInt64(parts[1]) else { return nil }
    self.device = device
    self.inode = inode
  }
}

private func metadata(_ fd: Int32) throws -> stat {
  var value = stat()
  guard fstat(fd, &value) == 0 else { throw Failure.unreadable }
  return value
}

/** The entry `name` in `directory`, never through a link; nil when it is gone. */
private func entry(_ directory: Int32, _ name: String) throws -> stat? {
  var value = stat()
  if fstatat(directory, name, &value, AT_SYMLINK_NOFOLLOW) == 0 { return value }
  if errno == ENOENT { return nil }
  throw Failure.unreadable
}

private func kind(_ value: stat) -> mode_t { value.st_mode & S_IFMT }

/** A directory below `parent`, opened without following a link, that is still the entry `seen` was read from. */
private func openDirectory(_ parent: Int32, _ name: String, _ seen: stat) throws -> Int32 {
  let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard fd >= 0 else { throw Failure.changed }
  do {
    guard try Identity(metadata(fd)) == Identity(seen) else { throw Failure.changed }
  } catch {
    Darwin.close(fd)
    throw error
  }
  return fd
}

/** The names in a directory held open, read through a copy of its descriptor. */
private func names(_ directory: Int32) throws -> [String] {
  let copy = dup(directory)
  guard copy >= 0 else { throw Failure.unreadable }
  guard let stream = fdopendir(copy) else {
    Darwin.close(copy)
    throw Failure.unreadable
  }
  defer { closedir(stream) }
  // The copy shares the descriptor's offset, which an earlier read left at the end.
  rewinddir(stream)
  var result: [String] = []
  while true {
    errno = 0
    guard let item = readdir(stream) else {
      guard errno == 0 else { throw Failure.unreadable }
      break
    }
    let bytes: [UInt8] = withUnsafePointer(to: &item.pointee.d_name) { pointer in
      pointer.withMemoryRebound(to: UInt8.self, capacity: Int(MAXNAMLEN) + 1) { start in
        Array(UnsafeBufferPointer(start: start, count: Int(item.pointee.d_namlen)))
      }
    }
    guard let name = String(bytes: bytes, encoding: .utf8) else { throw Failure.unreadable }
    if name == "." || name == ".." { continue }
    guard !name.isEmpty, !name.contains("/"), name.utf8.count <= nameLimit else { throw Failure.unreadable }
    result.append(name)
  }
  return result.sorted()
}

private func absoluteParts(_ root: String) throws -> [Substring] {
  let pieces = root.split(separator: "/", omittingEmptySubsequences: false)
  guard root.hasPrefix("/"), root.utf8.count <= pathLimit,
    root == "/" || pieces.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
    !root.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw Failure.invalidInput }
  return root == "/" ? [] : Array(pieces.dropFirst())
}

private struct MoveDestination {
  let root: String
  let rootId: Identity
  let parentId: Identity
  let name: String

  init(_ data: Any?) throws {
    guard let data = data as? [String: Any], Set(data.keys) == ["root", "rootId", "parentId", "name"],
      let root = data["root"] as? String, let rootId = (data["rootId"] as? String).flatMap(Identity.init),
      let parentId = (data["parentId"] as? String).flatMap(Identity.init), let name = data["name"] as? String,
      name.range(of: #"^general(-[0-9a-f]{8})?$"#, options: .regularExpression) != nil else { throw Failure.invalidInput }
    _ = try absoluteParts(root)
    self.root = root
    self.rootId = rootId
    self.parentId = parentId
    self.name = name
  }
}

private struct Request {
  let operation: String
  let root: String
  let rootId: Identity
  let helpersId: Identity
  let name: String
  let homeId: Identity
  let top: String?
  let expect: (entries: Int, bytes: UInt64)?
  let destination: MoveDestination?
  let deadline: ContinuousClock.Instant

  init(_ data: Data) throws {
    guard !data.isEmpty, data.count <= inputLimit,
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let operation = value["op"] as? String, ["archive", "remove", "count", "move-general"].contains(operation),
      let root = value["root"] as? String, let rootId = (value["rootId"] as? String).flatMap(Identity.init),
      let helpersId = (value["helpersId"] as? String).flatMap(Identity.init),
      let name = value["name"] as? String, let homeId = (value["homeId"] as? String).flatMap(Identity.init),
      let seconds = value["seconds"] as? Int, seconds > 0, seconds <= 900 else { throw Failure.invalidInput }
    let common: Set<String> = ["op", "root", "rootId", "helpersId", "name", "homeId", "seconds"]
    let allowed: Set<String>
    switch operation {
    case "archive": allowed = common.union(["top"])
    case "remove": allowed = common.union(["expect"])
    case "move-general": allowed = common.union(["destination"])
    default: allowed = common
    }
    guard Set(value.keys).isSubset(of: allowed) else { throw Failure.invalidInput }
    // The start directory as the Host resolved it: absolute, no `.` or `..`, nothing below it but `helpers/<name>`.
    _ = try absoluteParts(root)
    // The home's own name shape: the owner's ID, alone or with a data directory's tag.
    guard name.range(of: #"^(general|agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(-[0-9a-f]{8})?$"#,
      options: .regularExpression) != nil else { throw Failure.invalidInput }
    if operation == "move-general" {
      guard name == "general" || name.hasPrefix("general-") else { throw Failure.invalidInput }
      destination = try MoveDestination(value["destination"])
    } else {
      destination = nil
    }
    if operation == "archive" {
      guard let top = value["top"] as? String, !top.isEmpty, top.utf8.count <= 128, top != ".", top != "..",
        !top.contains("/"), !top.contains("\\"),
        !top.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw Failure.invalidInput }
      self.top = top
    } else {
      self.top = nil
    }
    if let expect = value["expect"] {
      guard let object = expect as? [String: Any], Set(object.keys) == ["entries", "bytes"],
        let entries = object["entries"] as? Int, entries >= 0, entries <= removeEntries,
        let bytes = object["bytes"] as? Int, bytes >= 0 else { throw Failure.invalidInput }
      self.expect = (entries, UInt64(bytes))
    } else {
      self.expect = nil
    }
    self.operation = operation
    self.root = root
    self.rootId = rootId
    self.helpersId = helpersId
    self.name = name
    self.homeId = homeId
    deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
  }
}

/** The start directory, `helpers` and the home, each opened without following a link and matched to the Host's record. */
private final class Home {
  let helpers: Int32
  let home: Int32
  let identity: Identity
  let device: UInt64
  private var held: [Int32] = []

  init(_ request: Request) throws {
    var current = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard current >= 0 else { throw Failure.unreadable }
    held.append(current)
    for component in request.root.split(separator: "/") {
      let next = openat(current, String(component), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else { throw Failure.changed }
      held.append(next)
      current = next
    }
    guard try Identity(metadata(current)) == request.rootId else { throw Failure.changed }
    guard let parent = try entry(current, "helpers"), kind(parent) == S_IFDIR, Identity(parent) == request.helpersId else {
      throw Failure.changed
    }
    helpers = try openDirectory(current, "helpers", parent)
    held.append(helpers)
    let owner = getuid()
    let parentInfo = try metadata(helpers)
    guard parentInfo.st_uid == owner, parentInfo.st_mode & 0o077 == 0 else { throw Failure.changed }
    guard let found = try entry(helpers, request.name), kind(found) == S_IFDIR, Identity(found) == request.homeId else {
      throw Failure.changed
    }
    home = try openDirectory(helpers, request.name, found)
    held.append(home)
    let info = try metadata(home)
    guard info.st_uid == owner, info.st_mode & 0o077 == 0 else { throw Failure.changed }
    identity = Identity(info)
    device = identity.device
  }

  deinit { for fd in held.reversed() { Darwin.close(fd) } }
}

/** An exclusive rename of the verified directory; distinct files and mounts are left in place. */
private func moveGeneral(_ request: Request) throws -> [String: Any] {
  guard let destination = request.destination else { throw Failure.invalidInput }
  let source = try Home(request)
  // Keep every ancestor open and never follow a link while walking the destination.
  let root = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard root >= 0 else { throw Failure.unreadable }
  var held = [root]
  defer { for fd in held.reversed() { Darwin.close(fd) } }
  for component in try absoluteParts(destination.root) {
    let fd = openat(held.last!, String(component), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw Failure.changed }
    held.append(fd)
  }
  let base = held.last!
  let baseInfo = try metadata(base)
  guard Identity(baseInfo) == destination.rootId, baseInfo.st_uid == getuid(), baseInfo.st_mode & 0o022 == 0,
    let seen = try entry(base, "agent-homes"), kind(seen) == S_IFDIR, Identity(seen) == destination.parentId,
    seen.st_uid == getuid(), seen.st_mode & 0o077 == 0 else { throw Failure.changed }
  let target = try openDirectory(base, "agent-homes", seen)
  held.append(target)
  guard destination.parentId.device == source.device else { throw Failure.mount }
  var totals = Totals()
  try survey(source.home, device: source.device, depth: 0, limit: removeEntries, deadline: request.deadline, into: &totals)
  guard let current = try entry(source.helpers, request.name), Identity(current) == source.identity else { throw Failure.changed }
  guard renameatx_np(source.helpers, request.name, target, destination.name, UInt32(RENAME_EXCL)) == 0 else {
    throw errno == EEXIST ? Failure.changed : Failure.unwritable
  }
  guard let moved = try entry(target, destination.name), Identity(moved) == source.identity else { throw Failure.changed }
  return ["moved": true]
}

private struct Totals {
  var entries = 0
  var files = 0
  var directories = 0
  var skipped = 0
  var bytes: UInt64 = 0
}

/** Counts everything below `directory` without changing it; another device below the home stops it. */
private func survey(_ directory: Int32, device: UInt64, depth: Int, limit: Int, deadline: ContinuousClock.Instant, into totals: inout Totals) throws {
  guard depth <= depthLimit else { throw Failure.tooLarge(entries: totals.entries, bytes: totals.bytes) }
  for name in try names(directory) {
    guard ContinuousClock.now < deadline else { throw Failure.budget }
    guard let found = try entry(directory, name) else { continue }
    totals.entries += 1
    guard totals.entries <= limit else { throw Failure.tooLarge(entries: totals.entries, bytes: totals.bytes) }
    switch kind(found) {
    case S_IFDIR:
      guard Identity(found).device == device else { throw Failure.mount }
      totals.directories += 1
      let child = try openDirectory(directory, name, found)
      defer { Darwin.close(child) }
      try survey(child, device: device, depth: depth + 1, limit: limit, deadline: deadline, into: &totals)
    case S_IFREG:
      totals.files += 1
      totals.bytes += UInt64(max(0, found.st_size))
    default:
      totals.skipped += 1
    }
  }
}

// MARK: Removal

/** Called between steps by the self-test only: it changes the tree the way a racing process could. */
private typealias Step = (_ directory: Int32, _ name: String) -> Void

/** Empties `directory` by descriptor: a link or file is unlinked, a directory emptied and then removed if it is the same one. */
private func purge(_ directory: Int32, device: UInt64, depth: Int, deadline: ContinuousClock.Instant, removed: inout Int, step: Step?) throws {
  guard depth <= depthLimit else { throw Failure.changed }
  for name in try names(directory) {
    guard ContinuousClock.now < deadline else { throw Failure.budget }
    guard let found = try entry(directory, name) else { continue }
    if kind(found) == S_IFDIR {
      guard Identity(found).device == device else { throw Failure.mount }
      let child = try openDirectory(directory, name, found)
      step?(directory, name)
      do {
        try purge(child, device: device, depth: depth + 1, deadline: deadline, removed: &removed, step: step)
      } catch {
        Darwin.close(child)
        throw error
      }
      Darwin.close(child)
      // Only the directory just emptied: a link or another directory put in its place stops the removal.
      guard let again = try entry(directory, name), kind(again) == S_IFDIR, Identity(again) == Identity(found) else {
        throw Failure.changed
      }
      guard unlinkat(directory, name, AT_REMOVEDIR) == 0 else { throw errno == ENOTEMPTY ? Failure.busy : Failure.unreadable }
    } else {
      // A link is removed as a link; its target is never touched.
      guard unlinkat(directory, name, 0) == 0 else {
        if errno == ENOENT { continue }
        throw Failure.unreadable
      }
    }
    removed += 1
  }
}

private func remove(_ request: Request, step: Step? = nil) throws -> [String: Any] {
  let home = try Home(request)
  var totals = Totals()
  try survey(home.home, device: home.device, depth: 0, limit: removeEntries, deadline: request.deadline, into: &totals)
  if let expect = request.expect, expect.entries != totals.entries || expect.bytes != totals.bytes { throw Failure.mismatch }
  var removed = 0
  try purge(home.home, device: home.device, depth: 0, deadline: request.deadline, removed: &removed, step: step)
  guard let last = try entry(home.helpers, request.name), kind(last) == S_IFDIR, Identity(last) == home.identity else {
    throw Failure.changed
  }
  guard unlinkat(home.helpers, request.name, AT_REMOVEDIR) == 0 else { throw errno == ENOTEMPTY ? Failure.busy : Failure.unreadable }
  guard try entry(home.helpers, request.name) == nil else { throw Failure.changed }
  return ["removed": removed]
}

/** What a removal would count now, changing nothing: what the person is shown before choosing. */
private func count(_ request: Request) throws -> [String: Any] {
  let home = try Home(request)
  var totals = Totals()
  try survey(home.home, device: home.device, depth: 0, limit: removeEntries, deadline: request.deadline, into: &totals)
  return ["entries": totals.entries, "bytes": totals.bytes]
}

// MARK: Archive

private let crcTable: [UInt32] = (0..<256).map { index in
  var value = UInt32(index)
  for _ in 0..<8 { value = value & 1 == 1 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1 }
  return value
}

private func crc32(_ crc: UInt32, _ bytes: UnsafeRawBufferPointer) -> UInt32 {
  var value = ~crc
  for byte in bytes { value = crcTable[Int((value ^ UInt32(byte)) & 0xFF)] ^ (value >> 8) }
  return ~value
}

private struct Little {
  var data = Data()
  mutating func u16(_ value: Int) { u16(UInt16(truncatingIfNeeded: value)) }
  mutating func u16(_ value: UInt16) { data.append(UInt8(value & 0xFF)); data.append(UInt8(value >> 8)) }
  mutating func u32(_ value: UInt32) { for shift in stride(from: 0, to: 32, by: 8) { data.append(UInt8((value >> UInt32(shift)) & 0xFF)) } }
  mutating func u32(_ value: UInt64) { u32(UInt32(truncatingIfNeeded: value)) }
}

private struct Central {
  let name: Data
  let crc: UInt32
  let size: UInt32
  let offset: UInt32
  let mode: UInt16
  let time: UInt16
  let date: UInt16
  let directory: Bool
}

private final class Archive {
  private let fd: Int32
  private(set) var offset: UInt64 = 0
  private var central: [Central] = []
  private(set) var bytes: UInt64 = 0
  var count: Int { central.count }

  init(_ fd: Int32) throws {
    let info = try metadata(fd)
    guard kind(info) == S_IFREG, info.st_size == 0 else { throw Failure.unwritable }
    self.fd = fd
  }

  private func write(_ data: Data) throws {
    try data.withUnsafeBytes { raw in
      var done = 0
      while done < raw.count {
        let count = Darwin.write(fd, raw.baseAddress!.advanced(by: done), raw.count - done)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw Failure.unwritable }
        done += count
      }
    }
    offset += UInt64(data.count)
    guard offset < 0xFFFF_0000 else { throw Failure.tooLarge(entries: central.count, bytes: bytes) }
  }

  private static func dosTime(_ seconds: Int) -> (time: UInt16, date: UInt16) {
    var clock = time_t(seconds)
    var parts = tm()
    guard localtime_r(&clock, &parts) != nil, parts.tm_year >= 80 else { return (0, 0x21) }
    let time = UInt16((parts.tm_hour << 11) | (parts.tm_min << 5) | (parts.tm_sec / 2))
    let date = UInt16(((parts.tm_year - 80) << 9) | ((parts.tm_mon + 1) << 5) | parts.tm_mday)
    return (time, date)
  }

  private func local(_ name: Data, _ stamp: (time: UInt16, date: UInt16)) -> Data {
    var header = Little()
    header.u32(UInt32(0x0403_4B50))
    header.u16(20)
    header.u16(0x0800)
    header.u16(0)
    header.u16(stamp.time)
    header.u16(stamp.date)
    header.u32(UInt32(0))
    header.u32(UInt32(0))
    header.u32(UInt32(0))
    header.u16(name.count)
    header.u16(0)
    header.data.append(name)
    return header.data
  }

  func directory(_ path: String, _ info: stat) throws {
    let name = Data((path + "/").utf8)
    let stamp = Archive.dosTime(Int(info.st_mtimespec.tv_sec))
    let start = offset
    try write(local(name, stamp))
    central.append(Central(name: name, crc: 0, size: 0, offset: UInt32(start), mode: UInt16(S_IFDIR) | 0o755,
      time: stamp.time, date: stamp.date, directory: true))
  }

  /** A regular file read through `file`, exactly `expected` bytes; the header's CRC and sizes are written after. */
  func file(_ path: String, _ file: Int32, _ info: stat, deadline: ContinuousClock.Instant) throws {
    let name = Data(path.utf8)
    let stamp = Archive.dosTime(Int(info.st_mtimespec.tv_sec))
    let start = offset
    try write(local(name, stamp))
    let expected = UInt64(max(0, info.st_size))
    var crc: UInt32 = 0
    var read: UInt64 = 0
    var buffer = [UInt8](repeating: 0, count: 1 << 20)
    while true {
      guard ContinuousClock.now < deadline else { throw Failure.budget }
      let count = buffer.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress!, $0.count) }
      if count < 0 && errno == EINTR { continue }
      guard count >= 0 else { throw Failure.unreadable }
      if count == 0 { break }
      read += UInt64(count)
      guard read <= expected else { throw Failure.changed }
      let chunk = buffer.withUnsafeBytes { raw in Data(raw.prefix(count)) }
      crc = chunk.withUnsafeBytes { crc32(crc, $0) }
      try write(chunk)
    }
    guard read == expected else { throw Failure.changed }
    var patch = Little()
    patch.u32(crc)
    patch.u32(expected)
    patch.u32(expected)
    let written = patch.data.withUnsafeBytes { pwrite(fd, $0.baseAddress!, $0.count, off_t(start + 14)) }
    guard written == 12 else { throw Failure.unwritable }
    bytes += expected
    central.append(Central(name: name, crc: crc, size: UInt32(expected), offset: UInt32(start),
      mode: UInt16(S_IFREG) | UInt16(info.st_mode & 0o777), time: stamp.time, date: stamp.date, directory: false))
  }

  func finish() throws {
    let start = offset
    var directory = Little()
    for item in central {
      directory.u32(UInt32(0x0201_4B50))
      directory.u16((3 << 8) | 20)
      directory.u16(20)
      directory.u16(0x0800)
      directory.u16(0)
      directory.u16(item.time)
      directory.u16(item.date)
      directory.u32(item.crc)
      directory.u32(item.size)
      directory.u32(item.size)
      directory.u16(item.name.count)
      directory.u16(0)
      directory.u16(0)
      directory.u16(0)
      directory.u16(0)
      directory.u32(UInt32(item.mode) << 16 | (item.directory ? 0x10 : 0))
      directory.u32(item.offset)
      directory.data.append(item.name)
    }
    try write(directory.data)
    var end = Little()
    end.u32(UInt32(0x0605_4B50))
    end.u16(0)
    end.u16(0)
    end.u16(central.count)
    end.u16(central.count)
    end.u32(UInt64(directory.data.count))
    end.u32(start)
    end.u16(0)
    try write(end.data)
    guard fsync(fd) == 0 else { throw Failure.unwritable }
  }
}

private func pack(_ directory: Int32, prefix: String, device: UInt64, depth: Int, archive: Archive, totals: inout Totals, deadline: ContinuousClock.Instant) throws {
  guard depth <= depthLimit else { throw Failure.changed }
  for name in try names(directory) {
    guard ContinuousClock.now < deadline else { throw Failure.budget }
    guard let found = try entry(directory, name) else { throw Failure.changed }
    // A backslash is a separator to some extractors: it never reaches the archive as one.
    let path = prefix + "/" + name.replacingOccurrences(of: "\\", with: "\u{2216}")
    guard path.utf8.count <= pathLimit else { throw Failure.unreadable }
    totals.entries += 1
    switch kind(found) {
    case S_IFDIR:
      guard Identity(found).device == device else { throw Failure.mount }
      let child = try openDirectory(directory, name, found)
      defer { Darwin.close(child) }
      totals.directories += 1
      try archive.directory(path, found)
      try pack(child, prefix: path, device: device, depth: depth + 1, archive: archive, totals: &totals, deadline: deadline)
    case S_IFREG:
      // Non-blocking: a FIFO put in its place cannot hold the read; the type and identity are checked on the handle.
      let file = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
      guard file >= 0 else { throw Failure.changed }
      defer { Darwin.close(file) }
      let opened = try metadata(file)
      guard kind(opened) == S_IFREG, Identity(opened) == Identity(found), opened.st_size == found.st_size else { throw Failure.changed }
      totals.files += 1
      totals.bytes += UInt64(max(0, opened.st_size))
      try archive.file(path, file, opened, deadline: deadline)
    default:
      // A link or anything else that is not a file or directory is left out: nothing is read through it.
      totals.skipped += 1
    }
  }
}

private func archive(_ request: Request, output: Int32) throws -> [String: Any] {
  let home = try Home(request)
  var counted = Totals()
  try survey(home.home, device: home.device, depth: 0, limit: archiveEntries, deadline: request.deadline, into: &counted)
  guard counted.bytes <= archiveBytes else { throw Failure.tooLarge(entries: counted.entries, bytes: counted.bytes) }
  let writer = try Archive(output)
  var totals = Totals()
  try pack(home.home, prefix: request.top!, device: home.device, depth: 0, archive: writer, totals: &totals, deadline: request.deadline)
  // What was written is what was counted: a file added, removed or resized meanwhile fails the export.
  guard totals.entries == counted.entries, totals.bytes == counted.bytes, totals.skipped == counted.skipped,
    writer.count == totals.files + totals.directories else { throw Failure.changed }
  try writer.finish()
  return ["entries": totals.entries, "archived": writer.count, "bytes": totals.bytes, "skipped": totals.skipped]
}

// MARK: Self-test

/** Exercises the built artifact in a scratch directory the build made: archive, a link left alone, a swap mid-removal. */
private func selfTest(_ scratch: String) throws {
  func make(_ path: String, _ text: String? = nil) throws {
    if let text { guard FileManager.default.createFile(atPath: path, contents: Data(text.utf8)) else { throw Failure.unwritable } }
    else { guard mkdir(path, 0o700) == 0 else { throw Failure.unwritable } }
  }
  func id(_ path: String) throws -> String {
    var value = stat()
    guard lstat(path, &value) == 0 else { throw Failure.unreadable }
    let identity = Identity(value)
    return "\(identity.device):\(identity.inode)"
  }
  var resolved = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  guard realpath(scratch, &resolved) != nil else { throw Failure.invalidInput }
  let root = String(decoding: resolved.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
  let name = "agt_00000000-0000-4000-8000-000000000000"
  let home = root + "/helpers/" + name
  try make(root + "/helpers")
  try make(home)
  try make(home + "/sub")
  try make(home + "/sub/note.txt", "note")
  try make(root + "/outside")
  try make(root + "/outside/keep.txt", "keep")
  guard symlink(root + "/outside", home + "/link") == 0 else { throw Failure.unwritable }
  let originalHomeId = try id(home)
  func request(_ operation: String, _ extra: [String: Any] = [:]) throws -> Request {
    var value: [String: Any] = [
      "op": operation, "root": root, "rootId": try id(root), "helpersId": try id(root + "/helpers"), "name": name,
      "homeId": originalHomeId, "seconds": 30,
    ]
    for (key, item) in extra { value[key] = item }
    return try Request(JSONSerialization.data(withJSONObject: value))
  }
  let counted = try count(try request("count"))
  guard counted["entries"] as? Int == 3, counted["bytes"] as? UInt64 == 4 else { throw Failure.mismatch }
  let zip = Darwin.open(root + "/out.zip", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard zip >= 0 else { throw Failure.unwritable }
  defer { Darwin.close(zip) }
  let packed = try archive(try request("archive", ["top": "home"]), output: zip)
  guard packed["archived"] as? Int == 2, packed["skipped"] as? Int == 1, packed["bytes"] as? UInt64 == 4 else { throw Failure.mismatch }
  // The directory being emptied is swapped for a link to `outside` mid-walk: what is outside stays, the removal stops.
  let swapped = try request("remove")
  var swappedOnce = false
  do {
    _ = try remove(swapped) { _, child in
      guard child == "sub", !swappedOnce else { return }
      swappedOnce = true
      _ = rename(home + "/sub", root + "/moved")
      _ = symlink(root + "/outside", home + "/sub")
    }
    throw Failure.mismatch
  } catch Failure.changed {}
  guard swappedOnce, FileManager.default.fileExists(atPath: root + "/outside/keep.txt") else { throw Failure.mismatch }
  // Removing the rest: the link to `outside` goes as a link.
  _ = unlink(home + "/sub")
  _ = try remove(try request("remove"))
  var gone = stat()
  guard lstat(home, &gone) != 0, errno == ENOENT, FileManager.default.fileExists(atPath: root + "/outside/keep.txt") else {
    throw Failure.mismatch
  }
  let oldGeneral = root + "/helpers/general"
  let newParent = root + "/agent-homes"
  let newGeneral = newParent + "/general"
  try make(oldGeneral)
  try make(oldGeneral + "/keep.txt", "keep")
  try make(newParent)
  try make(newGeneral)
  let original = try id(oldGeneral)
  let move = try request("move-general", [
    "name": "general", "homeId": original,
    "destination": ["root": root, "rootId": try id(root), "parentId": try id(newParent), "name": "general"],
  ])
  let occupied = try id(newGeneral)
  do {
    _ = try moveGeneral(move)
    throw Failure.mismatch
  } catch Failure.changed {}
  guard try id(newGeneral) == occupied, rmdir(newGeneral) == 0 else { throw Failure.mismatch }
  _ = try moveGeneral(move)
  guard try id(newGeneral) == original, FileManager.default.fileExists(atPath: newGeneral + "/keep.txt"),
    lstat(oldGeneral, &gone) != 0, errno == ENOENT else { throw Failure.mismatch }
}

// MARK: Main

private func reply(_ value: [String: Any], status: Int32) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{\"error\":\"invalid-input\"}".utf8)
  var line = data
  line.append(0x0A)
  line.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let count = Darwin.write(STDOUT_FILENO, raw.baseAddress!.advanced(by: offset), raw.count - offset)
      if count < 0 && errno == EINTR { continue }
      if count <= 0 { break }
      offset += count
    }
  }
  Darwin._exit(status)
}

private func failure(_ error: Error) -> Never {
  guard let failure = error as? Failure else { reply(["error": "invalid-input"], status: 1) }
  if case let .tooLarge(entries, bytes) = failure { reply(["error": failure.code, "entries": entries, "bytes": bytes], status: 1) }
  reply(["error": failure.code], status: 1)
}

@main private struct LatchHome {
  static func main() {
    let arguments = CommandLine.arguments
    if arguments.count == 3, arguments[1] == "--self-test" {
      do {
        try selfTest(arguments[2])
        reply(["ok": true], status: 0)
      } catch { failure(error) }
    }
    guard arguments.count == 1 else { reply(["error": "invalid-input"], status: 1) }
    do {
      var input = Data()
      while true {
        guard let part = try FileHandle.standardInput.read(upToCount: inputLimit + 1 - input.count), !part.isEmpty else { break }
        input.append(part)
        guard input.count <= inputLimit else { throw Failure.invalidInput }
      }
      let request = try Request(input)
      // The archive goes to descriptor 3, a new empty file the Host opened (O_EXCL, 0600) where the person chose.
      let result: [String: Any]
      switch request.operation {
      case "archive": result = try archive(request, output: 3)
      case "remove": result = try remove(request)
      case "move-general": result = try moveGeneral(request)
      default: result = try count(request)
      }
      reply(result, status: 0)
    } catch { failure(error) }
  }
}
