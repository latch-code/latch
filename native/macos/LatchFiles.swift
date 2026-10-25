// A descriptor-relative, metadata-only directory reader. Host authorization happens before this process starts.
import CoreFoundation
import Darwin
import Foundation

private let byteLimit = 1_048_576
private let pathLimit = 4096
private let safeInteger = 9_007_199_254_740_991.0

private enum Failure: String, Error {
  case invalidInput = "invalid-input", protected, changed, unreadable, budget
}

private final class Output: @unchecked Sendable {
  private let lock = NSLock()
  func finish(_ data: Data, status: Int32) -> Never {
    lock.lock()
    data.withUnsafeBytes { raw in
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
  func fail(_ error: Failure) -> Never {
    finish(Data("{\"error\":\"\(error.rawValue)\"}\n".utf8), status: 1)
  }
}

private struct Identity: Hashable {
  let device: Int32
  let inode: UInt64
  init(_ value: stat) { device = value.st_dev; inode = value.st_ino }
}

private func metadata(_ fd: Int32) throws -> stat {
  var value = stat()
  guard fstat(fd, &value) == 0 else { throw Failure.unreadable }
  return value
}

private func descriptorPath(_ fd: Int32) throws -> String {
  var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  let result = buffer.withUnsafeMutableBufferPointer { fcntl(fd, F_GETPATH, $0.baseAddress!) }
  guard result == 0, let path = String(validating: buffer.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self) else {
    throw Failure.changed
  }
  return path
}

private func inside(_ path: String, _ root: String) -> Bool {
  path == root || root == "/" || path.hasPrefix(root + "/")
}

private func validText(_ value: String) -> Bool {
  !value.isEmpty && value.utf8.count <= pathLimit
    && !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}

private func absolute(_ value: String) throws -> String {
  guard validText(value), value.hasPrefix("/"), !value.contains("\\") else { throw Failure.invalidInput }
  let pieces = value.split(separator: "/", omittingEmptySubsequences: false)
  guard value == "/" || pieces.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
    throw Failure.invalidInput
  }
  return value
}

private func canonicalProtection(_ path: String) throws -> String {
  var current = path
  var suffix: [String] = []
  while true {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    if realpath(current, &buffer) != nil {
      guard let resolved = String(validating: buffer.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self) else {
        throw Failure.unreadable
      }
      return suffix.reduce(resolved) { ($0 == "/" ? "/" : $0 + "/") + $1 }
    }
    guard errno == ENOENT || errno == ENOTDIR else { throw Failure.unreadable }
    guard current != "/" else { throw Failure.unreadable }
    suffix.insert((current as NSString).lastPathComponent, at: 0)
    current = (current as NSString).deletingLastPathComponent
    if current.isEmpty { current = "/" }
  }
}

private struct Protection {
  let spelling: String
  let canonical: String
  let identity: Identity?
  init(_ path: String) throws {
    spelling = try absolute(path)
    canonical = try canonicalProtection(path)
    var value = stat()
    if fstatat(AT_FDCWD, path, &value, 0) == 0 { identity = Identity(value) }
    else if errno == ENOENT || errno == ENOTDIR { identity = nil }
    else { throw Failure.unreadable }
  }
  func verify() throws {
    let current = try Protection(spelling)
    guard current.canonical == canonical && current.identity == identity else { throw Failure.changed }
  }
  func contains(_ path: String, _ value: Identity) -> Bool {
    inside(path, spelling) || inside(path, canonical) || identity == value
  }
}

private struct Node {
  let fd: Int32
  let parent: Int32?
  let name: String?
  let path: String
  let identity: Identity
}

private final class Namespace {
  var nodes: [Node] = []
  deinit { for node in nodes.reversed() { Darwin.close(node.fd) } }

  func openRoot(_ path: String) throws -> Node {
    let slash = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard slash >= 0 else { throw Failure.unreadable }
    let first = Node(fd: slash, parent: nil, name: nil, path: "/", identity: Identity(try metadata(slash)))
    nodes.append(first)
    var current = first
    for component in path.split(separator: "/") { current = try append(String(component), to: current) }
    return current
  }

  func append(_ name: String, to parent: Node) throws -> Node {
    let fd = openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw Failure.unreadable }
    let value: stat
    do { value = try metadata(fd) }
    catch { Darwin.close(fd); throw error }
    let path = parent.path == "/" ? "/" + name : parent.path + "/" + name
    let node = Node(fd: fd, parent: parent.fd, name: name, path: path, identity: Identity(value))
    nodes.append(node)
    guard try descriptorPath(fd) == path else { throw Failure.changed }
    return node
  }

  func verify(root: Node, target: Node, protections: [Protection]) throws {
    for node in nodes {
      guard Identity(try metadata(node.fd)) == node.identity, try descriptorPath(node.fd) == node.path else {
        throw Failure.changed
      }
      if let parent = node.parent, let name = node.name {
        var value = stat()
        guard fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0,
          value.st_mode & S_IFMT == S_IFDIR, Identity(value) == node.identity else { throw Failure.changed }
      }
      if protections.contains(where: { $0.contains(node.path, node.identity) }) { throw Failure.protected }
    }
    guard inside(try descriptorPath(target.fd), try descriptorPath(root.fd)) else { throw Failure.changed }
  }
}

private struct Entry: Encodable {
  let name: String
  let kind: String
  let size: Int64
  let mtime: Double
}

private struct Listing: Encodable {
  let entries: [Entry]
  let truncated: Bool
}

private struct Request {
  let root: String
  let components: [String]
  let protections: [Protection]
  let showHidden: Bool

  init(_ data: Data) throws {
    guard !data.isEmpty, data.count <= byteLimit,
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == Set(["root", "dir", "protectedPaths", "showHidden"]),
      let root = value["root"] as? String, let dir = value["dir"] as? String,
      let protected = value["protectedPaths"] as? [String], protected.count <= 256,
      let hidden = value["showHidden"] as? NSNumber, CFGetTypeID(hidden) == CFBooleanGetTypeID(),
      dir.utf8.count <= pathLimit, !dir.hasPrefix("/"), !dir.contains("\\"),
      dir.isEmpty || validText(dir) else { throw Failure.invalidInput }
    self.root = try absolute(root)
    components = dir.isEmpty ? [] : dir.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard components.count <= 128,
      components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
      self.root.utf8.count + dir.utf8.count + 1 <= pathLimit else { throw Failure.invalidInput }
    protections = try protected.map(Protection.init)
    showHidden = hidden.boolValue
  }
}

private func list(_ request: Request, deadline: ContinuousClock.Instant) throws -> Data {
  let namespace = Namespace()
  let root = try namespace.openRoot(request.root)
  var target = root
  for part in request.components { target = try namespace.append(part, to: target) }
  try namespace.verify(root: root, target: target, protections: request.protections)
  for protection in request.protections { try protection.verify() }
  let copy = dup(target.fd)
  guard copy >= 0 else { throw Failure.unreadable }
  guard let stream = fdopendir(copy) else { Darwin.close(copy); throw Failure.unreadable }
  defer { closedir(stream) }
  let generated = Set(["node_modules", "dist", "build", ".next", ".venv", "__pycache__"])
  var entries: [Entry] = []
  var visited = 0
  var truncated = false
  var encodedBytes = 64
  let encoder = JSONEncoder()
  while true {
    if ContinuousClock.now >= deadline || visited >= 50_000 || entries.count >= 2000 {
      truncated = true
      break
    }
    errno = 0
    guard let item = readdir(stream) else {
      guard errno == 0 else { throw Failure.unreadable }
      break
    }
    visited += 1
    let name: String? = withUnsafePointer(to: &item.pointee.d_name) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(validatingCString: $0) }
    }
    guard let name, name != ".", name != ".." else { continue }
    if !request.showHidden && (name.hasPrefix(".") || generated.contains(name) || name.hasSuffix(".tmp")) { continue }
    guard validText(name), !name.contains("/") else { continue }
    var value = stat()
    guard fstatat(target.fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0 else {
      if errno == ENOENT { continue }
      throw Failure.unreadable
    }
    let path = target.path == "/" ? "/" + name : target.path + "/" + name
    if request.protections.contains(where: { $0.contains(path, Identity(value)) }) { continue }
    let kind: String
    switch value.st_mode & S_IFMT {
    case S_IFREG: kind = "file"
    case S_IFDIR: kind = "directory"
    case S_IFLNK: kind = "symlink"
    default: kind = "other"
    }
    let modified = Double(value.st_mtimespec.tv_sec) * 1000 + Double(value.st_mtimespec.tv_nsec) / 1_000_000
    guard value.st_size >= 0, Double(value.st_size) <= safeInteger,
      modified.isFinite, abs(modified) <= safeInteger else { throw Failure.unreadable }
    let entry = Entry(name: name, kind: kind, size: value.st_size, mtime: modified)
    let count = try encoder.encode(entry).count + 1
    if encodedBytes + count > byteLimit { truncated = true; break }
    entries.append(entry)
    encodedBytes += count
  }
  try namespace.verify(root: root, target: target, protections: request.protections)
  for protection in request.protections { try protection.verify() }
  let result = try encoder.encode(Listing(entries: entries, truncated: truncated))
  guard result.count <= byteLimit else { throw Failure.budget }
  return result
}

@main private struct LatchFiles {
  static func main() {
    let output = Output()
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2) { output.fail(.budget) }
    do {
      let deadline = ContinuousClock.now.advanced(by: .milliseconds(1800))
      var input = Data()
      while true {
        guard let part = try FileHandle.standardInput.read(upToCount: min(65_536, byteLimit + 1 - input.count)),
          !part.isEmpty else { break }
        input.append(part)
        guard input.count <= byteLimit else { throw Failure.invalidInput }
      }
      let request = try Request(input)
      output.finish(try list(request, deadline: deadline), status: 0)
    } catch let failure as Failure { output.fail(failure) }
    catch { output.fail(.invalidInput) }
  }
}
