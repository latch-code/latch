// Latch local presence confirmation helper (macOS).
//
// Reads one JSON request line from stdin, recomputes the preview hash and the reason sentence itself, asks for Touch ID
// or the login password through the system's own LocalAuthentication sheet with that sentence, and writes one JSON
// result line to stdout. It draws no window of its own. It reads nothing but stdin (and, in --self-test mode, the
// vectors file named on the command line, checking canonical JSON, preview hashes, the display escaping, the reason
// sentences and request validation), writes nothing but stdout, makes no network calls and ignores its environment.

import CryptoKit
import Foundation
import LocalAuthentication

// MARK: - JSON that keeps UTF-16 code units (lone surrogates survive, as in JavaScript)

indirect enum JSONValue {
  case null
  case bool(Bool)
  case integer(Int64)
  case string([UInt16])
  case array([JSONValue])
  case object([(key: [UInt16], value: JSONValue)])

  subscript(key: String) -> JSONValue? {
    guard case .object(let members) = self else { return nil }
    let units = Array(key.utf16)
    return members.last(where: { $0.key == units })?.value
  }

  var stringValue: String? {
    guard case .string(let units) = self else { return nil }
    return String(decoding: units, as: UTF16.self)
  }

  var keys: [String] {
    guard case .object(let members) = self else { return [] }
    return members.map { String(decoding: $0.key, as: UTF16.self) }
  }
}

struct JSONError: Error {}

struct JSONParser {
  private let bytes: [UInt8]
  private var index = 0
  private var depth = 0
  private static let maxSafeInteger: Int64 = 9_007_199_254_740_991

  init(_ bytes: [UInt8]) { self.bytes = bytes }

  static func parse(_ bytes: [UInt8]) throws -> JSONValue {
    var parser = JSONParser(bytes)
    parser.skipWhitespace()
    let value = try parser.parseValue()
    parser.skipWhitespace()
    guard parser.index == parser.bytes.count else { throw JSONError() }
    return value
  }

  private mutating func skipWhitespace() {
    while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
  }

  private mutating func expect(_ literal: String) throws {
    for byte in literal.utf8 {
      guard index < bytes.count, bytes[index] == byte else { throw JSONError() }
      index += 1
    }
  }

  private mutating func parseValue() throws -> JSONValue {
    guard index < bytes.count else { throw JSONError() }
    switch bytes[index] {
    case UInt8(ascii: "n"): try expect("null"); return .null
    case UInt8(ascii: "t"): try expect("true"); return .bool(true)
    case UInt8(ascii: "f"): try expect("false"); return .bool(false)
    case UInt8(ascii: "\""): return .string(try parseString())
    case UInt8(ascii: "["): return try parseArray()
    case UInt8(ascii: "{"): return try parseObject()
    default: return try parseInteger()
    }
  }

  /// Integers only (the previews and vectors contain no fractions); -0 becomes 0 as in JavaScript.
  private mutating func parseInteger() throws -> JSONValue {
    var negative = false
    if bytes[index] == UInt8(ascii: "-") { negative = true; index += 1 }
    guard index < bytes.count, (0x30...0x39).contains(bytes[index]) else { throw JSONError() }
    if bytes[index] == 0x30, index + 1 < bytes.count, (0x30...0x39).contains(bytes[index + 1]) { throw JSONError() }
    var value: Int64 = 0
    while index < bytes.count, (0x30...0x39).contains(bytes[index]) {
      value = value * 10 + Int64(bytes[index] - 0x30)
      guard value <= JSONParser.maxSafeInteger else { throw JSONError() }
      index += 1
    }
    if index < bytes.count, [UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E")].contains(bytes[index]) { throw JSONError() }
    return .integer(negative ? -value : value)
  }

  private mutating func hex4() throws -> UInt16 {
    guard index + 4 <= bytes.count else { throw JSONError() }
    var value: UInt16 = 0
    for _ in 0..<4 {
      let byte = bytes[index]
      let digit: UInt16
      switch byte {
      case 0x30...0x39: digit = UInt16(byte - 0x30)
      case 0x41...0x46: digit = UInt16(byte - 0x41 + 10)
      case 0x61...0x66: digit = UInt16(byte - 0x61 + 10)
      default: throw JSONError()
      }
      value = value << 4 | digit
      index += 1
    }
    return value
  }

  private mutating func parseString() throws -> [UInt16] {
    index += 1
    var units: [UInt16] = []
    while true {
      guard index < bytes.count else { throw JSONError() }
      let byte = bytes[index]
      if byte == UInt8(ascii: "\"") { index += 1; return units }
      if byte < 0x20 { throw JSONError() }
      if byte == UInt8(ascii: "\\") {
        index += 1
        guard index < bytes.count else { throw JSONError() }
        let escape = bytes[index]
        index += 1
        switch escape {
        case UInt8(ascii: "\""): units.append(0x22)
        case UInt8(ascii: "\\"): units.append(0x5C)
        case UInt8(ascii: "/"): units.append(0x2F)
        case UInt8(ascii: "b"): units.append(0x08)
        case UInt8(ascii: "f"): units.append(0x0C)
        case UInt8(ascii: "n"): units.append(0x0A)
        case UInt8(ascii: "r"): units.append(0x0D)
        case UInt8(ascii: "t"): units.append(0x09)
        case UInt8(ascii: "u"): units.append(try hex4())
        default: throw JSONError()
        }
        continue
      }
      // One UTF-8 sequence → one scalar → UTF-16.
      let scalar: UInt32
      var length = 0
      switch byte {
      case 0x00...0x7F: scalar = UInt32(byte); length = 1
      case 0xC2...0xDF: scalar = UInt32(byte & 0x1F); length = 2
      case 0xE0...0xEF: scalar = UInt32(byte & 0x0F); length = 3
      case 0xF0...0xF4: scalar = UInt32(byte & 0x07); length = 4
      default: throw JSONError()
      }
      guard index + length <= bytes.count else { throw JSONError() }
      var value = scalar
      for offset in 1..<max(length, 1) where length > 1 {
        let next = bytes[index + offset]
        guard next & 0xC0 == 0x80 else { throw JSONError() }
        value = value << 6 | UInt32(next & 0x3F)
      }
      let minimum: [UInt32] = [0, 0, 0x80, 0x800, 0x10000]
      guard value >= minimum[length], value <= 0x10FFFF, !(0xD800...0xDFFF).contains(value), let unicode = Unicode.Scalar(value) else { throw JSONError() }
      units.append(contentsOf: Character(unicode).utf16)
      index += length
    }
  }

  private mutating func nest() throws {
    depth += 1
    guard depth <= 64 else { throw JSONError() }
  }

  private mutating func parseArray() throws -> JSONValue {
    try nest()
    defer { depth -= 1 }
    index += 1
    var items: [JSONValue] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
    while true {
      skipWhitespace()
      items.append(try parseValue())
      skipWhitespace()
      guard index < bytes.count else { throw JSONError() }
      if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
      if bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
      throw JSONError()
    }
  }

  private mutating func parseObject() throws -> JSONValue {
    try nest()
    defer { depth -= 1 }
    index += 1
    var members: [(key: [UInt16], value: JSONValue)] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "}") { index += 1; return .object(members) }
    while true {
      skipWhitespace()
      guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw JSONError() }
      let key = try parseString()
      skipWhitespace()
      guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw JSONError() }
      index += 1
      skipWhitespace()
      let value = try parseValue()
      // Duplicate keys: the last one wins, as with JSON.parse.
      members.removeAll { $0.key == key }
      members.append((key: key, value: value))
      skipWhitespace()
      guard index < bytes.count else { throw JSONError() }
      if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
      if bytes[index] == UInt8(ascii: "}") { index += 1; return .object(members) }
      throw JSONError()
    }
  }
}

// MARK: - Canonical JSON, byte-for-byte equal to the Host's canonicalJson

enum Canonical {
  private static let hexDigits: [UInt16] = Array("0123456789abcdef".utf16)

  private static func appendEscape(_ unit: UInt16, to output: inout [UInt16]) {
    output.append(contentsOf: Array("\\u".utf16))
    for shift in stride(from: 12, through: 0, by: -4) { output.append(hexDigits[Int((unit >> UInt16(shift)) & 0xF)]) }
  }

  /// JSON.stringify string quoting: short escapes, other C0 as lowercase \u00xx, lone surrogates as lowercase \udxxx.
  static func quote(_ units: [UInt16], into output: inout [UInt16]) {
    output.append(0x22)
    var position = 0
    while position < units.count {
      let unit = units[position]
      switch unit {
      case 0x22: output.append(contentsOf: Array("\\\"".utf16))
      case 0x5C: output.append(contentsOf: Array("\\\\".utf16))
      case 0x08: output.append(contentsOf: Array("\\b".utf16))
      case 0x0C: output.append(contentsOf: Array("\\f".utf16))
      case 0x0A: output.append(contentsOf: Array("\\n".utf16))
      case 0x0D: output.append(contentsOf: Array("\\r".utf16))
      case 0x09: output.append(contentsOf: Array("\\t".utf16))
      case 0x00...0x1F: appendEscape(unit, to: &output)
      case 0xD800...0xDBFF:
        if position + 1 < units.count, (0xDC00...0xDFFF).contains(units[position + 1]) {
          output.append(unit)
          output.append(units[position + 1])
          position += 1
        } else { appendEscape(unit, to: &output) }
      case 0xDC00...0xDFFF: appendEscape(unit, to: &output)
      default: output.append(unit)
      }
      position += 1
    }
    output.append(0x22)
  }

  private static func lessThan(_ a: [UInt16], _ b: [UInt16]) -> Bool {
    for (left, right) in zip(a, b) where left != right { return left < right }
    return a.count < b.count
  }

  static func encode(_ value: JSONValue, into output: inout [UInt16]) {
    switch value {
    case .null: output.append(contentsOf: Array("null".utf16))
    case .bool(let flag): output.append(contentsOf: Array((flag ? "true" : "false").utf16))
    case .integer(let number): output.append(contentsOf: Array(String(number).utf16))
    case .string(let units): quote(units, into: &output)
    case .array(let items):
      output.append(0x5B)
      for (position, item) in items.enumerated() {
        if position > 0 { output.append(0x2C) }
        encode(item, into: &output)
      }
      output.append(0x5D)
    case .object(let members):
      output.append(0x7B)
      for (position, member) in members.sorted(by: { lessThan($0.key, $1.key) }).enumerated() {
        if position > 0 { output.append(0x2C) }
        quote(member.key, into: &output)
        output.append(0x3A)
        encode(member.value, into: &output)
      }
      output.append(0x7D)
    }
  }

  /// UTF-8 of the canonical text (always well-formed: lone surrogates are escaped).
  static func bytes(_ value: JSONValue) -> Data {
    var units: [UInt16] = []
    encode(value, into: &units)
    return Data(String(decoding: units, as: UTF16.self).utf8)
  }

  static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  static func hashDisplay(_ hex: String) -> String {
    let head = Array(hex.prefix(16))
    return stride(from: 0, to: head.count, by: 4).map { String(head[$0..<min($0 + 4, head.count)]) }.joined(separator: "-")
  }
}

// MARK: - Output

func emit(_ fields: [(String, String)]) -> Never {
  var units: [UInt16] = [0x7B]
  units.append(contentsOf: Array("\"v\":1".utf16))
  for (key, value) in fields {
    units.append(0x2C)
    Canonical.quote(Array(key.utf16), into: &units)
    units.append(0x3A)
    Canonical.quote(Array(value.utf16), into: &units)
  }
  units.append(0x7D)
  units.append(0x0A)
  FileHandle.standardOutput.write(Data(String(decoding: units, as: UTF16.self).utf8))
  exit(0)
}

func emitError(_ message: String) -> Never {
  emit([("result", "error"), ("error", String(message.prefix(200)))])
}

// MARK: - Display text

/// The Host's listener classes, the only requesters a preview may name.
let listeners: Set<String> = ["unix", "loopback-tcp", "lan-tls", "tailnet-tls", "native-direct", "native-relay", "cli"]

/// Combining marks kept in a row; later ones in the same run are escaped, so stacked marks cannot cover other lines.
let maxCombiningRun = 4

/// Every "other" code point (controls, format, surrogates, private use, unassigned), line and paragraph separators,
/// and default-ignorable code points.
func isInvisible(_ scalar: Unicode.Scalar) -> Bool {
  switch scalar.properties.generalCategory {
  case .control, .format, .surrogate, .privateUse, .unassigned, .lineSeparator, .paragraphSeparator: return true
  default: return scalar.properties.isDefaultIgnorableCodePoint
  }
}

func isMark(_ scalar: Unicode.Scalar) -> Bool {
  switch scalar.properties.generalCategory {
  case .nonspacingMark, .spacingMark, .enclosingMark: return true
  default: return false
  }
}

/// Swift's scalar properties do not expose Extended_Pictographic; ICU's regular expressions do.
let pictographic = try! NSRegularExpression(pattern: "^\\p{Extended_Pictographic}$")

/// A pictograph that is itself shown as it is (unassigned pictographic code points are escaped).
func isShownPictograph(_ scalar: Unicode.Scalar?) -> Bool {
  guard let scalar, !isInvisible(scalar) else { return false }
  let text = String(Character(scalar))
  return pictographic.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

/// The emoji joiners left as they are: a zero-width joiner between two pictographs, and a presentation selector right
/// after a pictograph or between a keycap base and U+20E3.
func joinsEmoji(_ scalars: [Unicode.Scalar], _ index: Int) -> Bool {
  let before = index > 0 ? scalars[index - 1] : nil
  let after = index + 1 < scalars.count ? scalars[index + 1] : nil
  switch scalars[index].value {
  case 0x200D: return isShownPictograph(before) && isShownPictograph(after)
  case 0xFE0E, 0xFE0F:
    if isShownPictograph(before) { return true }
    guard let before, let after else { return false }
    return "0123456789#*".unicodeScalars.contains(before) && after.value == 0x20E3
  default: return false
  }
}

/// Same rule as the Host's escapeSecurityText; already-escaped text is unchanged. Escapes invisible code points
/// (except the emoji joiners above) and combining marks beyond `maxCombiningRun` in a row.
func visible(_ text: String) -> String {
  let scalars = Array(text.unicodeScalars)
  var output = ""
  var marks = 0
  for (index, scalar) in scalars.enumerated() {
    if isInvisible(scalar) && !joinsEmoji(scalars, index) {
      marks = 0
      output += String(format: "\\u{%04X}", scalar.value)
    } else if isMark(scalar) {
      marks += 1
      if marks > maxCombiningRun { output += String(format: "\\u{%04X}", scalar.value) } else { output.unicodeScalars.append(scalar) }
    } else {
      marks = 0
      output.unicodeScalars.append(scalar)
    }
  }
  return output
}

// MARK: - Reason: the sentence the system sheet shows, byte-for-byte equal to the Host's presenceReason

/// A literal, or a slot: escaped and cut to `max` grapheme clusters with "…" (at its start when `keepEnd`, so a path
/// keeps its file name and a host name its domain). A slot must have text.
enum Segment {
  case text(String)
  case slot(String, max: Int, keepEnd: Bool)
}

struct ReasonForm {
  let actions: Set<String>
  let segments: [Segment]
}

func slot(_ name: String, _ max: Int, keepEnd: Bool = false) -> Segment {
  .slot(name, max: max, keepEnd: keepEnd)
}

let deviceSlot = slot("device", 20)
let countSlot = slot("count", 4)
let deviceConnects: [Segment] = [.text("允许「"), deviceSlot, .text("」连接这台 Mac")]

/// The same table as REASON_FORMS in apps/host/src/presence-reason.ts; the shared vectors pin both.
let reasonForms: [String: ReasonForm] = [
  "device.enroll-named": ReasonForm(actions: ["device.enroll"], segments: deviceConnects),
  "device.enroll-native": ReasonForm(actions: ["device.enroll-native"], segments: deviceConnects),
  "device.grant": ReasonForm(actions: ["device.grant"], segments: [.text("为「"), deviceSlot, .text("」增加权限："), slot("change", 40)]),
  "origin.confirm": ReasonForm(actions: ["provider.confirm-origin", "policy.change"], segments: [
    .text("允许 Latch 连接 "), slot("target", 48, keepEnd: true),
  ]),
  "policy.egress-many": ReasonForm(actions: ["policy.change"], segments: [.text("允许 Latch 连接 "), countSlot, .text(" 个新地址")]),
  "policy.several": ReasonForm(actions: ["policy.change"], segments: [.text("放宽这台 Mac 的安全设置："), countSlot, .text(" 项更改")]),
  "plugin.package.apply": ReasonForm(actions: ["plugin.package.apply"], segments: [.text("应用插件「"), slot("plugin", 24), .text("」")]),
  "plugin.package.apply-pages": ReasonForm(actions: ["plugin.package.apply"], segments: [
    .text("让插件页面可以："), slot("capabilities", 48), .text("（插件「"), slot("plugin", 16), .text("」）"),
  ]),
  "mcp.server.apply": ReasonForm(actions: ["mcp.server.apply"], segments: [
    .text("让 Agent 运行 "), slot("command", 40, keepEnd: true), .text("（MCP 服务器「"), slot("server", 16), .text("」）"),
  ]),
  "mcp.server.apply-runner": ReasonForm(actions: ["mcp.server.apply"], segments: [
    .text("让 Agent 运行 "), slot("command", 12, keepEnd: true), .text(" "), slot("target", 32),
    .text("（"), slot("hash", 4), .text("，MCP「"), slot("server", 10), .text("」）"),
  ]),
  "mcp.server.apply-remote": ReasonForm(actions: ["mcp.server.apply"], segments: [
    .text("让 Latch 连接 "), slot("target", 40, keepEnd: true), .text("（MCP 服务器「"), slot("server", 16), .text("」）"),
  ]),
  "relay.add": ReasonForm(actions: ["policy.change"], segments: [
    .text("添加中继 "), slot("target", 32, keepEnd: true), .text("（"), countSlot, .text(" 个地址，密钥 "), slot("hash", 8), .text("）"),
  ]),
  "harness.command.apply": ReasonForm(actions: ["harness.command.apply"], segments: [
    .text("让 Harness 运行 "), slot("command", 40, keepEnd: true), .text("（「"), slot("harness", 16), .text("」）"),
  ]),
]

/// The reason for `action` from a subject, or nil when the form, its action or its slots do not match exactly.
func presenceReason(action: String, form name: String, slots: [String: String]) -> String? {
  guard let form = reasonForms[name], form.actions.contains(action) else { return nil }
  var names: [String] = []
  for segment in form.segments { if case .slot(let slot, _, _) = segment { names.append(slot) } }
  guard slots.count == names.count, Set(slots.keys) == Set(names) else { return nil }
  var reason = ""
  for segment in form.segments {
    switch segment {
    case .text(let text): reason += text
    case .slot(let slot, let max, let keepEnd):
      guard let value = slots[slot], !value.isEmpty else { return nil }
      // Swift's Character is an extended grapheme cluster, as Intl.Segmenter's graphemes are on the Host.
      let clusters = Array(visible(value))
      reason += clusters.count <= max ? String(clusters) : keepEnd ? "…" + String(clusters.suffix(max - 1)) : String(clusters.prefix(max - 1)) + "…"
    }
  }
  return reason
}

/// A subject's form and slots, or nil unless it is exactly `{ form, slots: { name: text } }`.
func subjectParts(_ subject: JSONValue?) -> (form: String, slots: [String: String])? {
  guard let subject, Set(subject.keys) == ["form", "slots"], let form = subject["form"]?.stringValue,
        case .object(let members)? = subject["slots"] else { return nil }
  var slots: [String: String] = [:]
  for member in members {
    guard let value = member.value.stringValue else { return nil }
    slots[String(decoding: member.key, as: UTF16.self)] = value
  }
  return (form, slots)
}

// MARK: - Request

struct Request {
  let nonce: String
  let previewHash: String
  let reason: String
  let timeoutSeconds: Int
  let requireBiometric: Bool
}

struct Refusal: Error {
  let code: String
}

func strings(_ value: JSONValue?) -> [String]? {
  guard case .array(let items)? = value else { return nil }
  var output: [String] = []
  for item in items {
    guard let text = item.stringValue else { return nil }
    output.append(text)
  }
  return output
}

/// The request, unless it is malformed, its preview does not hash to `previewHash`, or its reason is not exactly the
/// sentence its subject produces (compared as UTF-16 code units, never by Unicode equivalence).
func parseRequest(_ bytes: [UInt8]) throws -> Request {
  let lineEnd = bytes.firstIndex(of: 0x0A) ?? bytes.count
  guard let root = try? JSONParser.parse(Array(bytes[..<lineEnd])) else { throw Refusal(code: "request-invalid") }
  guard Set(root.keys) == ["v", "preview", "previewHash", "timeoutSeconds", "requireBiometric"], case .integer(2)? = root["v"],
        let preview = root["preview"], case .object = preview, let previewHash = root["previewHash"]?.stringValue,
        case .integer(let timeout)? = root["timeoutSeconds"], (1...120).contains(timeout),
        case .bool(let requireBiometric)? = root["requireBiometric"] else { throw Refusal(code: "request-invalid") }

  guard Canonical.sha256Hex(Canonical.bytes(preview)) == previewHash else { throw Refusal(code: "preview-hash-mismatch") }

  let allowed: Set<String> = ["v", "hostId", "action", "title", "reason", "subject", "requester", "lines", "warnings", "nonce", "expiresAt"]
  guard Set(preview.keys) == allowed, case .integer(2)? = preview["v"],
        preview["hostId"]?.stringValue != nil, let action = preview["action"]?.stringValue, preview["title"]?.stringValue != nil,
        preview["expiresAt"]?.stringValue != nil, let nonce = preview["nonce"]?.stringValue,
        case .string(let given)? = preview["reason"], let subject = subjectParts(preview["subject"]),
        let requester = preview["requester"], Set(requester.keys).isSubset(of: ["deviceId", "deviceName", "listener", "remoteAddress"]),
        let listener = requester["listener"]?.stringValue, listeners.contains(listener),
        requester["remoteAddress"]?.stringValue != nil, strings(preview["warnings"]) != nil,
        case .array(let lineItems)? = preview["lines"] else { throw Refusal(code: "preview-invalid") }
  for item in lineItems {
    guard Set(item.keys) == ["label", "value"], item["label"]?.stringValue != nil, item["value"]?.stringValue != nil else {
      throw Refusal(code: "preview-invalid")
    }
  }
  guard let reason = presenceReason(action: action, form: subject.form, slots: subject.slots) else { throw Refusal(code: "preview-invalid") }
  guard Array(reason.utf16) == given else { throw Refusal(code: "reason-mismatch") }
  return Request(nonce: nonce, previewHash: previewHash, reason: reason, timeoutSeconds: Int(timeout), requireBiometric: requireBiometric)
}

/// Reads stdin until the first newline or end of input.
func readRequestLine(limit: Int) -> Data {
  var buffer = Data()
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { break }
    buffer.append(chunk)
    if buffer.count > limit { emitError("request-too-large") }
    if chunk.contains(0x0A) { break }
  }
  return buffer
}

// MARK: - Self-test (no LocalAuthentication)

enum SelfTest {
  static func run(path: String) -> Int32 {
    guard let data = FileManager.default.contents(atPath: path), let root = try? JSONParser.parse([UInt8](data)) else {
      FileHandle.standardOutput.write(Data("{\"v\":1,\"ok\":false,\"error\":\"vectors-unreadable\"}\n".utf8))
      return 1
    }
    var ok = true
    var canonicalResults: [String] = []
    var cases: [JSONValue] = []
    if let single = root["canonicalJson"] { cases.append(single) }
    if case .array(let extra)? = root["canonicalJsonCases"] { cases.append(contentsOf: extra) }
    for item in cases {
      guard let input = item["input"], let output = item["output"]?.stringValue, let expected = item["sha256"]?.stringValue else {
        ok = false
        canonicalResults.append("{\"ok\":false}")
        continue
      }
      let bytes = Canonical.bytes(input)
      let hash = Canonical.sha256Hex(bytes)
      let match = hash == expected && bytes == Data(output.utf8)
      ok = ok && match
      canonicalResults.append("{\"ok\":\(match),\"sha256\":\"\(hash)\"}")
    }
    var previewResults: [String] = []
    if case .array(let previews)? = root["previewHash"] {
      for item in previews {
        guard let preview = item["preview"], let expected = item["previewHash"]?.stringValue, let display = item["hashDisplay"]?.stringValue else {
          ok = false
          previewResults.append("{\"ok\":false}")
          continue
        }
        let hash = Canonical.sha256Hex(Canonical.bytes(preview))
        let match = hash == expected && Canonical.hashDisplay(hash) == display
        ok = ok && match
        previewResults.append("{\"ok\":\(match),\"previewHash\":\"\(hash)\",\"hashDisplay\":\"\(Canonical.hashDisplay(hash))\"}")
      }
    } else { ok = false }
    // Text in the sheet must be escaped exactly as the Host escapes it.
    var escapeResults: [String] = []
    if case .array(let escapes)? = root["escapePreviewText"] {
      for item in escapes {
        guard let input = item["input"]?.stringValue, let expected = item["output"]?.stringValue else {
          ok = false
          escapeResults.append("false")
          continue
        }
        let match = visible(input) == expected
        ok = ok && match
        escapeResults.append(match ? "true" : "false")
      }
    } else { ok = false }
    // The sheet's sentence must be built exactly as the Host builds it.
    var reasonResults: [String] = []
    if case .array(let reasons)? = root["presenceReason"] {
      for item in reasons {
        guard let action = item["action"]?.stringValue, let subject = subjectParts(item["subject"]),
              case .string(let expected)? = item["reason"],
              let reason = presenceReason(action: action, form: subject.form, slots: subject.slots) else {
          ok = false
          reasonResults.append("false")
          continue
        }
        let match = Array(reason.utf16) == expected
        ok = ok && match
        reasonResults.append(match ? "true" : "false")
      }
    } else { ok = false }
    // Requests are accepted or refused with the expected code.
    var requestResults: [String] = []
    if case .array(let requests)? = root["presenceRequest"] {
      for item in requests {
        guard let request = item["request"], let expected = item["result"]?.stringValue else {
          ok = false
          requestResults.append("\"invalid-vector\"")
          continue
        }
        var outcome = "ok"
        do { _ = try parseRequest([UInt8](Canonical.bytes(request))) } catch let refusal as Refusal { outcome = refusal.code } catch { outcome = "error" }
        ok = ok && outcome == expected
        requestResults.append("\"\(outcome)\"")
      }
    } else { ok = false }
    let line = "{\"v\":1,\"ok\":\(ok),\"canonicalJson\":[\(canonicalResults.joined(separator: ","))],\"previewHash\":[\(previewResults.joined(separator: ","))],\"escapePreviewText\":[\(escapeResults.joined(separator: ","))],\"presenceReason\":[\(reasonResults.joined(separator: ","))],\"presenceRequest\":[\(requestResults.joined(separator: ","))]}\n"
    FileHandle.standardOutput.write(Data(line.utf8))
    return ok ? 0 : 1
  }
}

// MARK: - Authentication

/// One run of the system's LocalAuthentication sheet with the Host's reason. Latch draws nothing itself: the sheet's
/// sentence is the step the person verifies. SIGTERM from the Host (cancelled or expired), the Host's exit and the
/// helper's own timer all close the sheet.
@MainActor
final class Authentication {
  private let request: Request
  private let context = LAContext()
  private var sources: [DispatchSourceProtocol] = []
  private var finished = false

  init(request: Request) { self.request = request }

  func start() {
    signal(SIGTERM, SIG_IGN)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminate.setEventHandler { MainActor.assumeIsolated { self.finish(result: "cancelled") } }
    terminate.resume()
    sources.append(terminate)
    let parent = getppid()
    let host = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
    host.setEventHandler { MainActor.assumeIsolated { self.finish(result: "cancelled") } }
    host.resume()
    sources.append(host)
    // Started by a process that is already gone (re-parented to launchd): nobody would read the result.
    if parent <= 1 || getppid() != parent { finish(result: "cancelled") }
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(request.timeoutSeconds)) {
      MainActor.assumeIsolated { self.finish(result: "timeout") }
    }

    var policy = LAPolicy.deviceOwnerAuthentication
    var method = "password"
    var probe: NSError?
    if request.requireBiometric, context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &probe) {
      policy = .deviceOwnerAuthenticationWithBiometrics
      method = "biometric"
      // Class A takes Touch ID only; a password button here could only end as a refusal.
      context.localizedFallbackTitle = ""
    }
    var availability: NSError?
    guard context.canEvaluatePolicy(policy, error: &availability) else {
      finish(result: "error", error: "此 Mac 未设置登录密码或 Touch ID")
      return
    }
    context.evaluatePolicy(policy, localizedReason: request.reason) { success, error in
      let code = (error as? LAError)?.code
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          if success { self.finish(result: "approved", method: method); return }
          switch code {
          case .userCancel?, .authenticationFailed?, .userFallback?, .systemCancel?, .appCancel?: self.finish(result: "denied")
          case .passcodeNotSet?: self.finish(result: "error", error: "此 Mac 未设置登录密码或 Touch ID")
          // Too many failed fingers: the next run cannot use Touch ID and takes the login password, which unlocks it.
          case .biometryLockout?: self.finish(result: "error", error: "biometry-lockout")
          default: self.finish(result: "error", error: "本机认证不可用")
          }
        }
      }
    }
  }

  private func finish(result: String, method: String? = nil, error: String? = nil) {
    guard !finished else { return }
    finished = true
    context.invalidate()
    var fields: [(String, String)] = [("nonce", request.nonce), ("previewHash", request.previewHash), ("result", result)]
    if let method, result == "approved" { fields.append(("method", method)) }
    if let error, result == "error" { fields.append(("error", error)) }
    emit(fields)
  }
}

@main
struct LatchPresence {
  static func main() {
    let arguments = CommandLine.arguments
    if arguments.count == 3, arguments[1] == "--self-test" { exit(SelfTest.run(path: arguments[2])) }
    guard arguments.count == 1 else { emitError("usage") }
    let request: Request
    do {
      request = try parseRequest([UInt8](readRequestLine(limit: 256 * 1024)))
    } catch let refusal as Refusal {
      emitError(refusal.code)
    } catch {
      emitError("request-invalid")
    }
    let session = MainActor.assumeIsolated { () -> Authentication in
      let session = Authentication(request: request)
      session.start()
      return session
    }
    withExtendedLifetime(session) { dispatchMain() }
  }
}
