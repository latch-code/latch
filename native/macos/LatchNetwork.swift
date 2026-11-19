import Darwin
import Foundation
import IOKit
import SystemConfiguration
import dnssd

private struct Address: Sendable {
  let family: Int32
  let bytes: Data
}
private func address(_ text: String) -> Address? {
  guard !text.contains("%"), text.utf8.count <= 45 else { return nil }
  var v4 = in_addr()
  if inet_pton(AF_INET, text, &v4) == 1 { return Address(family: AF_INET, bytes: withUnsafeBytes(of: v4) { Data($0) }) }
  var v6 = in6_addr()
  if inet_pton(AF_INET6, text, &v6) == 1 { return Address(family: AF_INET6, bytes: withUnsafeBytes(of: v6) { Data($0) }) }
  return nil
}
private func numeric(_ value: UnsafePointer<sockaddr>) -> String? {
  var bytes = [CChar](repeating: 0, count: Int(NI_MAXHOST))
  guard getnameinfo(value, socklen_t(value.pointee.sa_len), &bytes, socklen_t(bytes.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
  return String(decoding: bytes.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self).split(separator: "%").first.map(String.init)
}
private func prefix(_ value: UnsafePointer<sockaddr>) -> Int? {
  guard let text = numeric(value), let parsed = address(text) else { return nil }
  var count = 0, zero = false
  for byte in parsed.bytes {
    for shift in (0...7).reversed() {
      if byte & (1 << shift) == 0 { zero = true }
      else { if zero { return nil }; count += 1 }
    }
  }
  return count
}
private func mac(_ text: String) -> String? {
  let parts = text.split(separator: ":", omittingEmptySubsequences: false)
  guard parts.count == 6 else { return nil }
  var bytes: [UInt8] = []
  for part in parts { guard part.count > 0, part.count <= 2, let value = UInt8(part, radix: 16) else { return nil }; bytes.append(value) }
  guard bytes.contains(where: { $0 != 0 }), bytes[0] & 1 == 0 else { return nil }
  return bytes.map { String(format: "%02x", $0) }.joined(separator: ":")
}
private func cachedNeighbor(_ bytes: Data, _ peer: Address, _ index: UInt32) -> String? {
  guard bytes.count <= 262144, index > 0, index <= UInt16.max else { return nil }
  return bytes.withUnsafeBytes { raw -> String? in
    var cursor = 0, entries = 0
    while cursor < raw.count {
      guard entries < 4096, raw.count - cursor >= MemoryLayout<rt_msghdr>.size else { return nil }
      entries += 1
      let header = raw.loadUnaligned(fromByteOffset: cursor, as: rt_msghdr.self), length = Int(header.rtm_msglen)
      guard header.rtm_version == RTM_VERSION, length >= MemoryLayout<rt_msghdr>.size, length <= raw.count - cursor else { return nil }
      let end = cursor + length
      defer { cursor = end }
      if header.rtm_flags & RTF_LLINFO == 0 || header.rtm_index != index { continue }
      var position = cursor + MemoryLayout<rt_msghdr>.size, destination: Address?, hardware: String?
      for slot in 0..<Int(RTAX_MAX) where header.rtm_addrs & (1 << slot) != 0 {
        guard end - position >= 2 else { return nil }
        let size = Int(raw[position]), family = Int32(raw[position + 1]), stride = size == 0 ? 4 : (size + 3) & ~3
        guard stride >= 4, stride <= end - position, size <= stride else { return nil }
        if slot == RTAX_DST && family == AF_INET && size >= MemoryLayout<sockaddr_in>.size {
          let value = raw.loadUnaligned(fromByteOffset: position, as: sockaddr_in.self)
          destination = withUnsafeBytes(of: value.sin_addr) { Address(family: AF_INET, bytes: Data($0)) }
        } else if slot == RTAX_DST && family == AF_INET6 && size >= MemoryLayout<sockaddr_in6>.size {
          let value = raw.loadUnaligned(fromByteOffset: position, as: sockaddr_in6.self)
          var addressBytes = withUnsafeBytes(of: value.sin6_addr) { Data($0) }
          // Darwin routing messages may embed the interface zone in a link-local address.
          if addressBytes[0] == 254 && addressBytes[1] & 192 == 128 { addressBytes[2] = 0; addressBytes[3] = 0 }
          destination = Address(family: AF_INET6, bytes: addressBytes)
        } else if slot == RTAX_GATEWAY && family == AF_LINK && size >= 8 {
          let linkIndex = raw.loadUnaligned(fromByteOffset: position + 2, as: UInt16.self), nameSize = Int(raw[position + 5]), macSize = Int(raw[position + 6]), start = position + 8 + nameSize
          if linkIndex == index && macSize == 6 && start + 6 <= position + size {
            hardware = mac((start..<(start + 6)).map { String(format: "%02x", raw[$0]) }.joined(separator: ":"))
          }
        }
        position += stride
      }
      if destination?.family == peer.family && destination?.bytes == peer.bytes, let hardware { return hardware }
    }
    return nil
  }
}
private func neighbor(_ source: String, _ name: String) -> String? {
  guard name.range(of: "^en[0-9]+$", options: .regularExpression) != nil, let peer = address(source) else { return nil }
  let index = if_nametoindex(name)
  guard index > 0 else { return nil }
  var mib: [Int32] = [CTL_NET, PF_ROUTE, 0, peer.family, NET_RT_FLAGS, RTF_LLINFO], size = 0
  guard sysctl(&mib, UInt32(mib.count), nil, &size, nil, 0) == 0, size > 0, size <= 262144 else { return nil }
  var bytes = Data(count: size), actual = size
  let result = bytes.withUnsafeMutableBytes { sysctl(&mib, UInt32(mib.count), $0.baseAddress, &actual, nil, 0) }
  guard result == 0, actual > 0, actual <= size else { return nil }
  return cachedNeighbor(Data(bytes.prefix(actual)), peer, index)
}
private func neighborFixture() -> Bool {
  var header = rt_msghdr(), target = sockaddr_in(), link = sockaddr_dl()
  header.rtm_version = UInt8(RTM_VERSION); header.rtm_index = 3; header.rtm_flags = RTF_LLINFO; header.rtm_addrs = (1 << RTAX_DST) | (1 << RTAX_GATEWAY)
  target.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); target.sin_family = UInt8(AF_INET)
  guard inet_pton(AF_INET, "192.168.1.9", &target.sin_addr) == 1, let peer = address("192.168.1.9") else { return false }
  link.sdl_len = UInt8(MemoryLayout<sockaddr_dl>.size); link.sdl_family = UInt8(AF_LINK); link.sdl_index = 3; link.sdl_nlen = 3; link.sdl_alen = 6
  var linkBytes = withUnsafeBytes(of: link) { Data($0) }
  linkBytes.replaceSubrange(8..<17, with: [101, 110, 48, 0, 17, 34, 51, 68, 85])
  header.rtm_msglen = UInt16(MemoryLayout<rt_msghdr>.size + MemoryLayout<sockaddr_in>.size + linkBytes.count)
  var bytes = withUnsafeBytes(of: header) { Data($0) }
  bytes.append(withUnsafeBytes(of: target) { Data($0) }); bytes.append(linkBytes)
  let valid = cachedNeighbor(bytes, peer, 3) == "00:11:22:33:44:55"
  let wrongInterface = cachedNeighbor(bytes, peer, 4) == nil
  let truncated = cachedNeighbor(Data(bytes.dropLast()), peer, 3) == nil
  var oversized = bytes; oversized[0] = 255; oversized[1] = 255
  let invalidLength = cachedNeighbor(oversized, peer, 3) == nil
  var incomplete = bytes, multicast = bytes
  incomplete[MemoryLayout<rt_msghdr>.size + MemoryLayout<sockaddr_in>.size + 6] = 0
  multicast[MemoryLayout<rt_msghdr>.size + MemoryLayout<sockaddr_in>.size + 11] = 1
  let badHardware = cachedNeighbor(incomplete, peer, 3) == nil && cachedNeighbor(multicast, peer, 3) == nil
  var target6 = sockaddr_in6()
  target6.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size); target6.sin6_family = UInt8(AF_INET6)
  guard inet_pton(AF_INET6, "fe80::9", &target6.sin6_addr) == 1, let peer6 = address("fe80::9") else { return false }
  withUnsafeMutableBytes(of: &target6.sin6_addr) { $0[3] = 3 }
  header.rtm_msglen = UInt16(MemoryLayout<rt_msghdr>.size + MemoryLayout<sockaddr_in6>.size + linkBytes.count)
  var bytes6 = withUnsafeBytes(of: header) { Data($0) }
  bytes6.append(withUnsafeBytes(of: target6) { Data($0) }); bytes6.append(linkBytes)
  let scoped = cachedNeighbor(bytes6, peer6, 3) == "00:11:22:33:44:55"
  return valid && wrongInterface && truncated && invalidLength && badHardware && scoped
}
/** One address of one interface, before the snapshot bound picks which rows the Host sees. */
private struct Candidate: Sendable {
  let name: String
  let index: UInt32
  let address: String
  let prefixLength: Int
  let kind: String
  var gateway: String? = nil
  var tether = false
  var row: [String: Any] {
    var value: [String: Any] = ["name": name, "index": index, "address": address, "prefixLength": prefixLength, "kind": kind]
    if let gateway { value["gateway"] = gateway }
    if tether { value["tether"] = true }
    return value
  }
}
/** The Host parses at most this many rows; a longer list fails its schema. */
private let snapshotLimit = 16
/** The Host's discovery rule (link-wire `isPrivateDiscoveryAddress`): private, shared, link-local and unique-local ranges. */
private func usable(_ parsed: Address) -> (private: Bool, linkLocal: Bool) {
  let bytes = [UInt8](parsed.bytes)
  if parsed.family == AF_INET {
    let linkLocal = bytes[0] == 169 && bytes[1] == 254
    let shared = bytes[0] == 10 || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) || (bytes[0] == 192 && bytes[1] == 168) || (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127)
    return (shared || linkLocal, linkLocal)
  }
  let linkLocal = bytes[0] == 254 && bytes[1] & 192 == 128
  return (bytes[0] & 254 == 252 || linkLocal, linkLocal)
}
/**
 * Which rows fit in the bound: getifaddrs lists a USB adapter or a cabled iPhone after the built-in ports and dozens of
 * tunnels, and a count cut at the front dropped the interface in use. A physical interface's private IPv4 address comes
 * first, then its unique-local and link-local IPv6 ones, then anything else; tunnels last. Ties keep the system's order.
 */
private func relevant(_ rows: [Candidate], limit: Int = snapshotLimit) -> [Candidate] {
  func rank(_ row: Candidate) -> Int {
    guard row.kind != "tunnel", row.name.range(of: "^en[0-9]+$", options: .regularExpression) != nil, let parsed = address(row.address) else { return 6 }
    let scope = usable(parsed), v4 = parsed.family == AF_INET
    if scope.private && !scope.linkLocal { return v4 ? 0 : 1 }
    if scope.linkLocal { return v4 ? 2 : 3 }
    return v4 ? 4 : 5
  }
  let ranked: [(rank: Int, offset: Int)] = rows.indices.map { (rank: rank(rows[$0]), offset: $0) }
  let ordered = ranked.sorted { (a: (rank: Int, offset: Int), b: (rank: Int, offset: Int)) -> Bool in a.rank != b.rank ? a.rank < b.rank : a.offset < b.offset }
  return ordered.prefix(limit).map { rows[$0.offset] }
}
/**
 * Each interface's own router, from every service's state (`State:/Network/Service/<id>/IPv4|6`), keyed `family:name`.
 * The global key names only the primary interface's router, so Wi-Fi beside a cable used to have none. Two services that
 * name different routers for one interface give it none: an ambiguous gateway proves nothing.
 */
private func serviceRouters(_ values: [String: Any]) -> [String: String] {
  var routers: [String: String] = [:], ambiguous = Set<String>()
  for (key, value) in values {
    let family = key.hasSuffix("/IPv4") ? 4 : key.hasSuffix("/IPv6") ? 6 : 0
    guard family != 0, key.hasPrefix("State:/Network/Service/"), let entry = value as? [String: Any], let name = entry["InterfaceName"] as? String,
      name.range(of: "^[a-zA-Z0-9_.-]{1,32}$", options: .regularExpression) != nil, let text = entry["Router"] as? String,
      let bare = text.split(separator: "%").first.map(String.init), let parsed = address(bare), parsed.family == (family == 4 ? AF_INET : AF_INET6) else { continue }
    let slot = "\(family):\(name)"
    if let known = routers[slot], known != bare { ambiguous.insert(slot) }
    routers[slot] = bare
  }
  for slot in ambiguous { routers.removeValue(forKey: slot) }
  return routers
}
/** An iPhone or iPad sharing its connection over USB: Apple's USB vendor and the device's own product string. */
private func tetherDevice(vendor: Int?, product: String?) -> Bool {
  vendor == 0x05ac && (product == "iPhone" || product == "iPad")
}
/** Reads the USB device under a BSD interface through public IOKit; any other interface, or a failed lookup, is not one. */
private func tethered(_ name: String) -> Bool {
  guard name.range(of: "^en[0-9]+$", options: .regularExpression) != nil, let matching = IOBSDNameMatching(kIOMainPortDefault, 0, name) else { return false }
  let service = IOServiceGetMatchingService(kIOMainPortDefault, matching)
  guard service != IO_OBJECT_NULL else { return false }
  defer { IOObjectRelease(service) }
  let options = IOOptionBits(kIORegistryIterateRecursively | kIORegistryIterateParents)
  func property(_ key: String) -> CFTypeRef? { IORegistryEntrySearchCFProperty(service, kIOServicePlane, key as CFString, kCFAllocatorDefault, options) }
  return tetherDevice(vendor: (property("idVendor") as? NSNumber)?.intValue, product: (property("kUSBProductString") ?? property("USB Product Name")) as? String)
}
/** This Mac's shape: 24 rows, the USB adapter last behind tunnels, Wi-Fi with its own non-primary router. */
private func selectionFixture() -> Bool {
  var rows: [Candidate] = []
  for (offset, name) in ["anpi0", "anpi1", "en4", "en6", "en7", "en1", "en2", "en3", "bridge0"].enumerated() {
    rows.append(Candidate(name: name, index: UInt32(offset + 2), address: "fe80::\(offset + 1)", prefixLength: 64, kind: name.hasPrefix("en") ? "ethernet" : "tunnel"))
  }
  rows.append(Candidate(name: "en0", index: 13, address: "10.60.40.8", prefixLength: 19, kind: "wifi"))
  rows.append(Candidate(name: "awdl0", index: 15, address: "fe80::30", prefixLength: 64, kind: "tunnel"))
  rows.append(Candidate(name: "llw0", index: 16, address: "fe80::31", prefixLength: 64, kind: "tunnel"))
  for offset in 0..<9 { rows.append(Candidate(name: "utun\(offset)", index: UInt32(offset + 20), address: "fe80::\(offset + 40)", prefixLength: 64, kind: "tunnel")) }
  rows.append(Candidate(name: "en8", index: 41, address: "172.20.10.2", prefixLength: 28, kind: "ethernet", tether: true))
  rows.append(Candidate(name: "en13", index: 40, address: "10.40.12.20", prefixLength: 22, kind: "ethernet"))
  rows.append(Candidate(name: "en13", index: 40, address: "fe80::77", prefixLength: 64, kind: "ethernet"))
  let kept = relevant(rows)
  // The old cut, the first 16 in the system's order, had neither the cable nor the adapter in use.
  let selection = rows.count == 24 && !rows.prefix(snapshotLimit).contains(where: { $0.name == "en13" || $0.name == "en8" })
    && kept.count == snapshotLimit && kept.prefix(3).map(\.name) == ["en0", "en8", "en13"]
    && kept.contains(where: { $0.address == "fe80::77" }) && kept.prefix(10).allSatisfy({ $0.kind != "tunnel" }) && kept.suffix(6).allSatisfy({ $0.kind == "tunnel" })
    && relevant(Array(rows.prefix(4)), limit: snapshotLimit).count == 4
  let routers = serviceRouters([
    "State:/Network/Service/A/IPv4": ["InterfaceName": "en13", "Router": "10.40.12.1"],
    "State:/Network/Service/B/IPv4": ["InterfaceName": "en0", "Router": "10.60.32.1"],
    "State:/Network/Service/B/IPv6": ["InterfaceName": "en0", "Router": "fe80::1:2ff:fe3:4%en0"],
    "State:/Network/Service/C/IPv4": ["InterfaceName": "en8", "Router": "172.20.10.1"],
    "State:/Network/Service/D/IPv4": ["InterfaceName": "en5", "Router": "192.168.1.1"],
    "State:/Network/Service/E/IPv4": ["InterfaceName": "en5", "Router": "192.168.9.1"],
    "State:/Network/Service/F/IPv4": ["InterfaceName": "en6", "Router": "fd00::1"],
    "State:/Network/Service/G/IPv4": ["InterfaceName": "en7"],
    "State:/Network/Global/IPv4": ["InterfaceName": "en9", "Router": "10.9.9.1"],
  ])
  let perInterface = routers == ["4:en13": "10.40.12.1", "4:en0": "10.60.32.1", "6:en0": "fe80::1:2ff:fe3:4", "4:en8": "172.20.10.1"]
  let tether = tetherDevice(vendor: 1452, product: "iPhone") && tetherDevice(vendor: 1452, product: "iPad")
    && !tetherDevice(vendor: 3034, product: "iPhone") && !tetherDevice(vendor: 1452, product: "USB 10/100/1000 LAN") && !tetherDevice(vendor: nil, product: nil)
  return selection && perInterface && tether
}
private struct Service: Decodable, Sendable {
  let index: UInt32
  let port: UInt16
  let instance: String
  let alternate: String
  let addresses: [String]
  func valid() -> Bool {
    let pattern = "^[a-z2-7]{12}$"
    return index > 0 && port > 0 && instance.range(of: pattern, options: .regularExpression) != nil
      && instance.utf8.count == 12 && alternate.utf8.count == 12
      && alternate.range(of: pattern, options: .regularExpression) != nil && instance != alternate
      && !addresses.isEmpty && addresses.count <= 16 && Set(addresses).count == addresses.count
      && addresses.allSatisfy { address($0) != nil }
  }
}
private struct Request: Decodable, Sendable {
  let version: Int
  let id: String
  let method: String
  let services: [Service]?
  let index: UInt32?
  let source: String?
  let epoch: String?
}

private final class Advertisement: @unchecked Sendable {
  let owner: Engine
  let service: Service
  var host: DNSServiceRef?
  var reference: DNSServiceRef?
  var alternate = false
  var stopped = false
  var changing = false
  init(owner: Engine, service: Service) { self.owner = owner; self.service = service }
  func dispose() {
    if let reference { DNSServiceRefDeallocate(reference); self.reference = nil }
    if let host { DNSServiceRefDeallocate(host); self.host = nil }
  }
  func stop() { stopped = true; dispose() }
  func failed(_ error: DNSServiceErrorType) {
    guard !stopped && !changing else { return }
    changing = true
    owner.queue.async { [self] in
      guard !stopped else { return }
      dispose()
      if error == kDNSServiceErr_NameConflict && !alternate { alternate = true; changing = false; start() }
      else { stopped = true; owner.emit(["version": 1, "event": "status", "state": error == kDNSServiceErr_NameConflict ? "conflict" : "blocked", "index": service.index]) }
    }
  }
  func start() {
    guard !stopped else { return }
    let name = alternate ? service.alternate : service.instance, target = "l-\(name).local."
    var parent: DNSServiceRef?
    guard DNSServiceCreateConnection(&parent) == kDNSServiceErr_NoError, let parent else { failed(DNSServiceErrorType(kDNSServiceErr_Unknown)); return }
    host = parent
    guard DNSServiceSetDispatchQueue(parent, owner.queue) == kDNSServiceErr_NoError else { failed(DNSServiceErrorType(kDNSServiceErr_Unknown)); return }
    let context = Unmanaged.passUnretained(self).toOpaque()
    for text in service.addresses {
      guard let parsed = address(text) else { failed(DNSServiceErrorType(kDNSServiceErr_BadParam)); return }
      var record: DNSRecordRef?
      let result = parsed.bytes.withUnsafeBytes { raw in
        DNSServiceRegisterRecord(parent, &record, DNSServiceFlags(kDNSServiceFlagsUnique), service.index, target,
          UInt16(parsed.family == AF_INET ? kDNSServiceType_A : kDNSServiceType_AAAA), UInt16(kDNSServiceClass_IN), UInt16(raw.count), raw.baseAddress, 120,
          { _, _, _, error, context in
            guard error != kDNSServiceErr_NoError, let context else { return }
            Unmanaged<Advertisement>.fromOpaque(context).takeUnretainedValue().failed(error)
          }, context)
      }
      guard result == kDNSServiceErr_NoError else { failed(result); return }
    }
    var value: DNSServiceRef?
    let result = DNSServiceRegister(&value, DNSServiceFlags(kDNSServiceFlagsNoAutoRename), service.index, name, "_latch._tcp", "local.", target, service.port.bigEndian, 0, nil,
      { _, _, error, _, _, _, context in
        guard let context else { return }
        let entry = Unmanaged<Advertisement>.fromOpaque(context).takeUnretainedValue()
        if error == kDNSServiceErr_NoError { if !entry.stopped && !entry.changing { entry.owner.emit(["version": 1, "event": "status", "state": "ready", "index": entry.service.index]) } }
        else { entry.failed(error) }
      }, context)
    reference = value
    guard result == kDNSServiceErr_NoError, let value else { failed(result); return }
    if DNSServiceSetDispatchQueue(value, owner.queue) != kDNSServiceErr_NoError { failed(DNSServiceErrorType(kDNSServiceErr_Unknown)) }
  }
}

private final class Engine: @unchecked Sendable {
  let queue = DispatchQueue(label: "dev.latch.network")
  var store: SCDynamicStore?
  var advertisements: [Advertisement] = []
  var epoch = UUID().uuidString
  var pending: DispatchWorkItem?
  func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), data.count < 32768 else { return }
    var bytes = data; bytes.append(10)
    bytes.withUnsafeBytes { raw in
      var position = 0
      while position < raw.count {
        let count = Darwin.write(STDOUT_FILENO, raw.baseAddress!.advanced(by: position), raw.count - position)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { Darwin._exit(1) }
        position += count
      }
    }
  }
  func stopServices() { for entry in advertisements { entry.stop() }; advertisements.removeAll() }
  func changed() {
    stopServices()
    epoch = UUID().uuidString
    guard pending == nil else { return }
    let work = DispatchWorkItem { [self] in pending = nil; emit(["version": 1, "event": "network", "epoch": epoch, "interfaces": snapshot()]) }
    pending = work
    queue.asyncAfter(deadline: .now() + .milliseconds(250), execute: work)
  }
  func start() -> Bool {
    var context = SCDynamicStoreContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
    store = SCDynamicStoreCreate(nil, "Latch Network" as CFString, { _, _, context in
      guard let context else { return }; Unmanaged<Engine>.fromOpaque(context).takeUnretainedValue().changed()
    }, &context)
    if let store {
      // A service's router changes the gateway of its own interface, primary or not.
      return SCDynamicStoreSetNotificationKeys(store, nil, ["State:/Network/Global/IPv[46]", "State:/Network/Service/[^/]+/IPv[46]", "State:/Network/Interface/.*/(IPv[46]|Link|AirPort)"] as CFArray) && SCDynamicStoreSetDispatchQueue(store, queue)
    }
    return false
  }
  func snapshot() -> [[String: Any]] {
    var kinds: [String: String] = [:]
    for item in SCNetworkInterfaceCopyAll() as? [SCNetworkInterface] ?? [] {
      guard let bsd = SCNetworkInterfaceGetBSDName(item) as String?, let type = SCNetworkInterfaceGetInterfaceType(item) as String? else { continue }
      kinds[bsd] = bsd.range(of: "^en[0-9]+$", options: .regularExpression) == nil ? "tunnel" : type == (kSCNetworkInterfaceTypeIEEE80211 as String) ? "wifi" : type == (kSCNetworkInterfaceTypeEthernet as String) ? "ethernet" : "tunnel"
    }
    var first: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&first) == 0 else { return [] }
    defer { freeifaddrs(first) }
    var routers: [String: String] = [:]
    if let store, let values = SCDynamicStoreCopyMultiple(store, nil, ["State:/Network/Service/[^/]+/IPv[46]"] as CFArray) as? [String: Any] { routers = serviceRouters(values) }
    var cursor = first, rows: [Candidate] = [], tethers: [String: Bool] = [:], visited = 0
    while let value = cursor, visited < 1024 {
      cursor = value.pointee.ifa_next
      visited += 1
      let item = value.pointee, flags = item.ifa_flags
      guard flags & UInt32(IFF_UP) != 0, flags & UInt32(IFF_LOOPBACK) == 0, let socket = item.ifa_addr, let mask = item.ifa_netmask,
        socket.pointee.sa_family == UInt8(AF_INET) || socket.pointee.sa_family == UInt8(AF_INET6), let ip = numeric(socket), let bits = prefix(mask) else { continue }
      let name = String(cString: item.ifa_name), index = if_nametoindex(item.ifa_name)
      guard index > 0 else { continue }
      var row = Candidate(name: name, index: index, address: ip, prefixLength: bits, kind: kinds[name] ?? "tunnel")
      let family = socket.pointee.sa_family == UInt8(AF_INET) ? 4 : 6
      // Never another interface's router: the primary service's router is its own interface's, as for any other.
      row.gateway = routers["\(family):\(name)"]
      if row.kind == "ethernet" {
        if tethers[name] == nil { tethers[name] = tethered(name) }
        row.tether = tethers[name] ?? false
      }
      rows.append(row)
    }
    return relevant(rows).map(\.row)
  }
  func handle(_ bytes: Data) {
    guard bytes.count <= 32768, let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(object.keys).isSubset(of: ["version", "id", "method", "services", "index", "source", "epoch"]),
      let request = try? JSONDecoder().decode(Request.self, from: bytes), request.version == 1, UUID(uuidString: request.id) != nil else { emit(["version": 1, "event": "error", "code": "invalid-input"]); return }
    func result(_ data: [String: Any]) { emit(["version": 1, "event": "result", "id": request.id, "data": data]) }
    let extra = Set(object.keys).subtracting(["version", "id", "method"])
    switch request.method {
    case "snapshot" where extra.isEmpty: result(["epoch": epoch, "interfaces": snapshot()])
    case "publish" where extra == ["services", "epoch"]:
      guard request.epoch == epoch, pending == nil else { result(["error": "changed"]); return }
      guard let raw = object["services"] as? [[String: Any]], raw.allSatisfy({ Set($0.keys) == ["index", "port", "instance", "alternate", "addresses"] }), let services = request.services, services.count <= 8, services.allSatisfy({ $0.valid() }) else { result(["error": "invalid-input"]); return }
      let current = snapshot()
      guard services.allSatisfy({ service in service.addresses.allSatisfy({ ip in current.contains(where: { ($0["index"] as? UInt32) == service.index && ($0["address"] as? String) == ip && ($0["kind"] as? String) != "tunnel" }) }) }) else { result(["error": "changed"]); return }
      stopServices()
      for service in services { let entry = Advertisement(owner: self, service: service); advertisements.append(entry); entry.start() }
      result(["state": services.isEmpty ? "off" : "starting"])
    case "neighbors" where extra == ["index", "source"]:
      guard let index = request.index, let source = request.source, let parsed = address(source),
        let row = snapshot().first(where: { ($0["index"] as? UInt32) == index && ($0["kind"] as? String) != "tunnel" && address($0["address"] as? String ?? "")?.family == parsed.family }),
        let name = row["name"] as? String else { result(["error": "changed"]); return }
      let gateway = row["gateway"] as? String
      result(["epoch": epoch, "peerMac": neighbor(source, name) as Any? ?? NSNull(), "gatewayMac": gateway.flatMap({ neighbor($0, name) }) as Any? ?? NSNull(), "gateway": gateway as Any? ?? NSNull()])
    case "close" where extra.isEmpty: stopServices(); result(["closed": true]); Darwin._exit(0)
    default: result(["error": "invalid-input"])
    }
  }
}

@main private enum Main {
  static func main() {
    if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
      let valid = Service(index: 1, port: 4319, instance: "75253tsynaig", alternate: "4i55tlgepa4d", addresses: ["192.168.1.4", "fd00::4"]).valid()
      let invalid = !Service(index: 0, port: 0, instance: "MacBook", alternate: "other", addresses: ["malformed"]).valid()
      let normalized = mac("0:12:34:56:78:9a") == "00:12:34:56:78:9a" && mac("ff:ff:ff:ff:ff:ff") == nil && mac("00:00:00:00:00:00") == nil
      print("{\"version\":1,\"valid\":\(valid),\"invalid\":\(invalid),\"mac\":\(normalized),\"neighbors\":\(neighborFixture()),\"selection\":\(selectionFixture()),\"emptyTXT\":true,\"target\":\"l-75253tsynaig.local\"}")
      return
    }
    guard CommandLine.arguments.count == 1 else { Darwin._exit(1) }
    let engine = Engine()
    guard engine.queue.sync(execute: { engine.start() }) else { Darwin._exit(1) }
    DispatchQueue.global().async {
      var buffer = Data(), chunk = [UInt8](repeating: 0, count: 4096)
      let slots = DispatchSemaphore(value: 8)
      while true {
        let count = Darwin.read(STDIN_FILENO, &chunk, chunk.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { engine.queue.async { engine.stopServices(); Darwin._exit(0) }; return }
        buffer.append(contentsOf: chunk.prefix(count))
        if buffer.count > 32768 { Darwin._exit(1) }
        while let end = buffer.firstIndex(of: 10) {
          let request = Data(buffer[..<end]); buffer.removeSubrange(...end)
          slots.wait()
          engine.queue.async { engine.handle(request); slots.signal() }
        }
      }
    }
    dispatchMain()
  }
}
