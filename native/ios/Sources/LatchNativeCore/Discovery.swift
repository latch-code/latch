import Darwin
import Foundation
import Network

/** A current QR or a signed address book can supply a dial hint. It never replaces the paired keys. */
public struct NativeDirectEndpoint: Hashable, Sendable {
    public let host: String
    public let port: UInt16
    public init(host: String, port: UInt16) {
        if let value = try? NativeDiscoveryWire.ip(host), let canonical = NativeDiscoveryWire.text(value.bytes, family: value.family) {
            self.host = canonical
        } else { self.host = host }
        self.port = port
    }

    public static func signed(_ book: NativeAddressBook?) -> [Self] {
        (book?.lan ?? []).compactMap { row in
            guard row.kind == "wifi" || row.kind == "ethernet", NativeDiscoveryWire.isRoutedPrivatePeer(row.address) else { return nil }
            return Self(host: row.address, port: row.port)
        }
    }
}

/** A foreground-network hint. Only a successfully installed path can carry an address into a later round. */
public struct NativeDirectHints: Sendable {
    public let addresses: [NativeDirectEndpoint]
    public let network: UUID
    public let expiresAt: Date
    public let request: UUID
    public let justPaired: Bool
    public let requiresSignedEndpoint: Bool
    private let fromQR: Bool
    public init(addresses: [NativeDirectEndpoint], network: UUID, expiresAt: Date, justPaired: Bool = false, fromQR: Bool = false) {
        self.addresses = addresses; self.network = network; self.expiresAt = expiresAt
        self.justPaired = justPaired; self.fromQR = fromQR; requiresSignedEndpoint = !fromQR; request = UUID()
    }
    private init(confirmed: NativeDirectEndpoint, from attempt: Self, until: Date, bookMatched: Bool) {
        addresses = [confirmed]; network = attempt.network; expiresAt = until
        justPaired = attempt.justPaired; fromQR = false; requiresSignedEndpoint = bookMatched; request = attempt.request
    }
    public func installed(_ address: NativeDirectEndpoint, network current: UUID, signedUntil: Date?, now: Date = Date()) -> Self? {
        guard network == current, expiresAt > now, addresses.contains(address), !requiresSignedEndpoint || signedUntil != nil else { return nil }
        let authority = fromQR ? signedUntil ?? expiresAt : min(expiresAt, signedUntil ?? expiresAt)
        guard authority > now else { return nil }
        return Self(confirmed: address, from: self, until: min(authority, now.addingTimeInterval(600)), bookMatched: signedUntil != nil)
    }
}

extension PreparedNativeDevice {
    public func currentAddressBook() -> NativeAddressBook? {
        try? AddressBookCodec.verify(signedAddressBook, rootSpki: rootSpki, deviceId: deviceId,
            nowMs: UInt64(max(0, Date().timeIntervalSince1970 * 1_000)), priorGeneration: bookGeneration, priorHash: bookHash)
    }
}

public enum NativeDiscoveryWire {
    public static func epoch(key: Data) throws -> String {
        LinkBytes.hex(LinkBytes.hash(Data("latch-discovery-epoch-v1\0".utf8) + (try LinkBytes.fixed(key, 32))))
    }
    public static func names(key: Data, day: UInt64) throws -> (primary: String, alternate: String) {
        _ = try LinkBytes.fixed(key, 32)
        let date = try LinkBytes.integer(day, size: 4)
        func name(_ domain: String) -> String { String(LinkBytes.base32(LinkBytes.hmac(key, Data(domain.utf8) + date)).prefix(12)) }
        return (name("latch-mdns-v1"), name("latch-mdns-alt-v1"))
    }
    public static func expectedNames(key: Data, nowMs: UInt64) throws -> Set<String> {
        guard nowMs <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        let seconds = nowMs / 1000, day = seconds / 86_400
        let neighbor = day == 0 || seconds % 86_400 >= 43_200 ? day + 1 : day - 1
        var result = Set<String>()
        for date in [day, neighbor] { let value = try names(key: key, day: date); result.insert(value.primary); result.insert(value.alternate) }
        return result
    }
    static func ip(_ text: String) throws -> (family: UInt8, bytes: Data) {
        guard !text.contains("%"), text.count <= 45 else { throw NativeFailure.invalidRecord }
        var v4 = in_addr(), v6 = in6_addr()
        if text.withCString({ inet_pton(AF_INET, $0, &v4) }) == 1 { return (4, withUnsafeBytes(of: &v4) { Data($0) }) }
        if text.withCString({ inet_pton(AF_INET6, $0, &v6) }) == 1 {
            let bytes = withUnsafeBytes(of: &v6) { Data($0) }
            if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255 { return (4, Data(bytes.suffix(4))) }
            return (6, bytes)
        }
        throw NativeFailure.invalidRecord
    }
    static func network(_ bytes: Data, prefix: Int) throws -> Data {
        guard (0...(bytes.count * 8)).contains(prefix) else { throw NativeFailure.invalidRecord }
        return Data(bytes.enumerated().map { index, byte in
            let bits = min(8, max(0, prefix - index * 8))
            return byte & (bits == 0 ? 0 : UInt8(truncatingIfNeeded: 256 - (1 << (8 - bits))))
        })
    }
    public static func gatewayHash(address: String, prefix: Int, gateway: String) throws -> Data {
        let local = try ip(address), router = try ip(gateway)
        guard local.family == router.family else { throw NativeFailure.invalidRecord }
        let masked = try network(local.bytes, prefix: prefix)
        return LinkBytes.hash(Data("latch-network-gateway-v1\0".utf8) + Data([local.family, UInt8(prefix)]) + masked + router.bytes)
    }
    public static func gatewayHash(address: String, mask: Data, gateway: String) throws -> Data {
        let local = try ip(address)
        guard mask.count == local.bytes.count else { throw NativeFailure.invalidRecord }
        var prefix = 0, zero = false
        for byte in mask {
            for bit in (0..<8).reversed() {
                if byte & (1 << bit) == 0 { zero = true }
                else { guard !zero else { throw NativeFailure.invalidRecord }; prefix += 1 }
            }
        }
        guard prefix > 0 else { throw NativeFailure.invalidRecord }
        return try gatewayHash(address: address, prefix: prefix, gateway: gateway)
    }
    /** Public NWPath routing hints only. Unknown or tunnel paths provide no proximity claim. */
    public static func currentGatewayHashes(_ path: NWPath) -> [Data] {
        guard path.status == .satisfied, !path.usesInterfaceType(.other), !path.usesInterfaceType(.cellular) else { return [] }
        let interfaces = path.availableInterfaces.filter {
            $0.type == .wifi && path.usesInterfaceType(.wifi) || $0.type == .wiredEthernet && path.usesInterfaceType(.wiredEthernet)
        }
        guard !interfaces.isEmpty, interfaces.count <= 2, path.gateways.count <= 8 else { return [] }
        func text(_ bytes: Data, family: UInt8) -> String? {
            guard bytes.count == (family == 4 ? 4 : 16) else { return nil }
            var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            let count = socklen_t(buffer.count)
            guard bytes.withUnsafeBytes({ inet_ntop(family == 4 ? AF_INET : AF_INET6, $0.baseAddress, &buffer, count) }) != nil else { return nil }
            return buffer.withUnsafeBufferPointer { $0.baseAddress.flatMap { String(validatingCString: $0) } }
        }
        var routers: [(address: String, family: UInt8, interface: String?)] = []
        for endpoint in path.gateways {
            guard case let .hostPort(host, _) = endpoint else { continue }
            let raw: Data, family: UInt8
            switch host {
            case let .ipv4(value): raw = value.rawValue; family = 4
            case let .ipv6(value): raw = value.rawValue; family = 6
            default: continue
            }
            guard privatePeer(raw, family: family), let value = text(raw, family: family) else { continue }
            if host.interface == nil && interfaces.count != 1 { continue }
            routers.append((value, family, host.interface?.name))
        }
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return [] }
        defer { freeifaddrs(first) }
        var cursor = first, visited = 0, hashes: [UInt8: Data] = [:]
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            visited += 1; if visited > 256 { return [] }
            let row = current.pointee
            guard row.ifa_flags & UInt32(IFF_UP) != 0, let address = row.ifa_addr, let mask = row.ifa_netmask,
                  address.pointee.sa_family == mask.pointee.sa_family,
                  interfaces.contains(where: { $0.name == String(cString: row.ifa_name) }) else { continue }
            let family: UInt8
            switch Int32(address.pointee.sa_family) { case AF_INET: family = 4; case AF_INET6: family = 6; default: continue }
            func bytes(_ pointer: UnsafeMutablePointer<sockaddr>) -> Data {
                if family == 4 { return pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                    var value = $0.pointee.sin_addr; return withUnsafeBytes(of: &value) { Data($0) }
                } }
                return pointer.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                    var value = $0.pointee.sin6_addr; return withUnsafeBytes(of: &value) { Data($0) }
                }
            }
            let local = bytes(address), netmask = bytes(mask), name = String(cString: row.ifa_name)
            guard privatePeer(local, family: family), let addressText = text(local, family: family) else { continue }
            if family == 4 && local[0] == 169 && local[1] == 254 || family == 6 && local[0] == 254 && local[1] & 192 == 128 { continue }
            for router in routers where router.family == family && (router.interface == nil || router.interface == name) && router.address != addressText {
                guard let value = try? gatewayHash(address: addressText, mask: netmask, gateway: router.address) else { continue }
                if hashes[family] == nil { hashes[family] = value }
            }
        }
        return [UInt8(4), UInt8(6)].compactMap { hashes[$0] }
    }
    static func privatePeer(_ bytes: Data, family: UInt8) -> Bool {
        let b = [UInt8](bytes)
        if family == 4 {
            guard b.count == 4, b != [169, 254, 169, 254] else { return false }
            return b[0] == 10 || b[0] == 172 && (16...31).contains(b[1]) || b[0] == 192 && b[1] == 168
                || b[0] == 100 && (64...127).contains(b[1]) || b[0] == 169 && b[1] == 254
        }
        guard b.count == 16, bytes != Data([253, 0, 14, 194, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 84]) else { return false }
        return b[0] & 254 == 252 || b[0] == 254 && b[1] & 192 == 128
    }
    public static func isRoutedPrivatePeer(_ peer: String) -> Bool {
        guard let value = try? ip(peer) else { return false }
        return routedPeer(value.bytes, family: value.family)
    }
    private static func routedPeer(_ bytes: Data, family: UInt8) -> Bool {
        guard privatePeer(bytes, family: family) else { return false }
        if family == 6 { return bytes[0] & 254 == 252 }
        return bytes[0] == 10 || bytes[0] == 172 || bytes[0] == 192
    }
    /** The current default path must actually use this physical interface for explicitly routed hints. */
    public static func directInterface(to peer: String, path: NWPath?, allowRouted: Bool = true) -> NWInterface? {
        guard let path, path.status == .satisfied, !path.usesInterfaceType(.other), !path.usesInterfaceType(.cellular) else { return nil }
        return path.availableInterfaces.first { item in
            (item.type == .wifi || item.type == .wiredEthernet) && path.usesInterfaceType(item.type)
                && isCurrentPeer(peer, interface: item.name, allowRouted: allowRouted)
        }
    }
    /** Personal Hotspot's downstream bridge may be absent from the system default NWPath. */
    public static func isHotspotPeer(_ peer: String) -> Bool {
        guard let interfaces = if_nameindex() else { return false }
        defer { if_freenameindex(interfaces) }
        for index in 0..<256 {
            let row = interfaces[index]
            guard row.if_index != 0, let name = row.if_name else { break }
            let value = String(cString: name)
            if value.hasPrefix("bridge"), isCurrentPeer(peer, interface: value) { return true }
        }
        return false
    }
    public static func isCurrentPeer(_ peer: String, interface: String, allowRouted: Bool = false) -> Bool {
        let scoped = peer.split(separator: "%", omittingEmptySubsequences: false)
        guard scoped.count <= 2, scoped.count == 1 || scoped[1] == Substring(interface),
              let ip = try? ip(String(scoped[0])), privatePeer(ip.bytes, family: ip.family) else { return false }
        var start: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&start) == 0 else { return false }
        defer { freeifaddrs(start) }
        var rows: [(Data, Data)] = [], own: [Data] = []
        var cursor = start
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let value = current.pointee
            guard let address = value.ifa_addr, let mask = value.ifa_netmask, value.ifa_flags & UInt32(IFF_UP) != 0,
                  address.pointee.sa_family == (ip.family == 4 ? AF_INET : AF_INET6) else { continue }
            func raw(_ value: UnsafeMutablePointer<sockaddr>) -> Data {
                if ip.family == 4 { return value.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { pointer in
                    var bytes = pointer.pointee.sin_addr; return withUnsafeBytes(of: &bytes) { Data($0) }
                } }
                return value.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { pointer in
                    var bytes = pointer.pointee.sin6_addr; return withUnsafeBytes(of: &bytes) { Data($0) }
                }
            }
            let local = raw(address); own.append(local)
            if String(cString: value.ifa_name) == interface { rows.append((local, raw(mask))) }
        }
        return permitsPeer(ip.bytes, rows: rows, own: own, allowRouted: allowRouted && scoped.count == 1)
    }
    package static func permitsPeer(_ target: Data, rows: [(Data, Data)], own: [Data], allowRouted: Bool) -> Bool {
        let family: UInt8 = target.count == 4 ? 4 : 6
        guard privatePeer(target, family: family), !own.contains(target) else { return false }
        for (local, mask) in rows {
            let a = [UInt8](target), b = [UInt8](local), m = [UInt8](mask)
            guard a.count == b.count, m.count == a.count,
                  zip(a, m).map({ $0 & $1 }) == zip(b, m).map({ $0 & $1 }) else { continue }
            if family == 4, m != [255, 255, 255, 254], m != [255, 255, 255, 255] {
                let network = zip(b, m).map { $0 & $1 }, broadcast = zip(network, m).map { $0 | ~$1 }
                if a == network || a == broadcast { return false }
            }
            return true
        }
        return allowRouted && routedPeer(target, family: family) && rows.contains { privatePeer($0.0, family: family) }
    }
}

@MainActor private final class ServiceResolution: NSObject, @preconcurrency NetServiceDelegate {
    private let service: NetService
    private var continuation: CheckedContinuation<(String, UInt16), Error>?
    private let label: String
    private let interface: String
    private let routed: Set<NativeDirectEndpoint>
    init(label: String, interface: String, routed: Set<NativeDirectEndpoint>) {
        self.label = label; self.interface = interface; self.routed = routed
        service = NetService(domain: "local.", type: "_latch._tcp.", name: label)
        super.init(); service.includesPeerToPeer = false; service.delegate = self
    }
    func resolve() async throws -> (String, UInt16) {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                if Task.isCancelled { finish(.failure(CancellationError())) }
                else { service.schedule(in: .main, forMode: .common); service.resolve(withTimeout: 3) }
            }
        } onCancel: { Task { @MainActor in self.finish(.failure(CancellationError())) } }
    }
    func netServiceDidResolveAddress(_ sender: NetService) {
        let txt = sender.txtRecordData() ?? Data()
        guard sender.hostName?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == "l-\(label).local",
              txt.isEmpty || txt == Data([0]), (1...65_535).contains(sender.port), let addresses = sender.addresses, addresses.count <= 32 else {
            finish(.failure(NativeFailure.invalidRecord)); return
        }
        var routedMatch: (String, UInt16)?
        for address in addresses {
            let text: String? = address.withUnsafeBytes { bytes in
                guard let base = bytes.baseAddress, bytes.count >= MemoryLayout<sockaddr>.size else { return nil }
                let pointer = base.assumingMemoryBound(to: sockaddr.self), family = pointer.pointee.sa_family
                let required = family == AF_INET ? MemoryLayout<sockaddr_in>.size : family == AF_INET6 ? MemoryLayout<sockaddr_in6>.size : 0
                guard required > 0, bytes.count >= required else { return nil }
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                guard getnameinfo(pointer, socklen_t(required), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
                return buffer.withUnsafeBufferPointer { String(validatingCString: $0.baseAddress!) }
            }
            guard let text else { continue }
            let port = UInt16(sender.port)
            if NativeDiscoveryWire.isCurrentPeer(text, interface: interface) { finish(.success((text, port))); return }
            if routed.contains(NativeDirectEndpoint(host: text, port: port)), NativeDiscoveryWire.isCurrentPeer(text, interface: interface, allowRouted: true) {
                routedMatch = (text, port)
            }
        }
        if let routedMatch { finish(.success(routedMatch)) } else { finish(.failure(NativeFailure.unavailable)) }
    }
    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) { finish(.failure(NativeFailure.unavailable)) }
    private func finish(_ result: Result<(String, UInt16), Error>) {
        guard let continuation else { return }; self.continuation = nil
        service.stop(); service.remove(from: .main, forMode: .common)
        continuation.resume(with: result)
    }
}

/** Bonjour supplies a current address hint. A routed answer must also occur in the paired Mac's live, signed book. */
@MainActor public final class NativeDiscovery {
    private var browser: NWBrowser?
    private var generation = UUID()
    private var key: Data?
    private var found: [(label: String, interface: NWInterface)] = []
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    /** Called on the main actor whenever this browser's results change. */
    public var onChange: (@MainActor () -> Void)?
    public init() {}
    public var browsing: Bool { browser != nil }
    /** Starts browsing for this key; a running browser for the same key keeps its results. A network change stops it first. */
    public func start(key: Data) throws {
        _ = try LinkBytes.fixed(key, 32)
        if browser != nil, let current = self.key, LinkBytes.equal(current, key) { return }
        stop(); self.key = key
        let current = generation, parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        let next = NWBrowser(for: .bonjour(type: "_latch._tcp", domain: "local."), using: parameters)
        browser = next
        next.browseResultsChangedHandler = { [weak self] results, _ in Task { @MainActor in
            guard let self, self.generation == current else { return }
            let now = Date().timeIntervalSince1970 * 1000
            guard now >= 0, now <= Double(LinkBytes.maximumInteger),
                  let names = try? NativeDiscoveryWire.expectedNames(key: key, nowMs: UInt64(now)) else { return }
            var found: [(String, NWInterface)] = []
            for result in results.prefix(64) {
                guard case let .service(name, type, domain, _) = result.endpoint, names.contains(name),
                      type == "_latch._tcp." || type == "_latch._tcp", domain == "local." || domain == "local" else { continue }
                for interface in result.interfaces where interface.type == .wifi || interface.type == .wiredEthernet {
                    if found.count < 8 { found.append((name, interface)) }
                }
            }
            self.found = found
            if !found.isEmpty { self.wake() }
            self.onChange?()
        } }
        // A failed browser is dropped, so the next dial round starts a fresh one.
        next.stateUpdateHandler = { [weak self] state in
            guard case .failed = state else { return }
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                self.stop()
            }
        }
        next.start(queue: DispatchQueue(label: "app.latch.bonjour"))
    }
    public func stop() { generation = UUID(); browser?.cancel(); browser = nil; key = nil; found = []; wake() }
    /** Returns once browsing has a result for this key, or after `limit`, or at once when not browsing. */
    public func waitForResults(within limit: Duration) async {
        guard browser != nil, found.isEmpty, waiters.count < 8 else { return }
        let id = UUID()
        let timer = Task { [weak self] in
            try? await Task.sleep(for: limit)
            self?.wake(id)
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled { continuation.resume() } else { waiters[id] = continuation }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.wake(id) } }
        timer.cancel()
    }
    private func wake(_ id: UUID? = nil) {
        if let id { waiters.removeValue(forKey: id)?.resume(); return }
        let all = waiters.values; waiters = [:]
        for continuation in all { continuation.resume() }
    }
    /** A direct candidate that waits for this browser's first result, bounded by `NativeReconnectPolicy.browseDeadline`. */
    public func lateCandidates(device: PreparedNativeDevice, keys: any NativeIdentityProvider) -> NativeLateDirects {
        NativeLateDirects { [weak self] in
            guard let self else { return [] }
            await self.waitForResults(within: NativeReconnectPolicy.browseDeadline)
            return (try? await self.candidates(device: device, keys: keys)) ?? []
        }
    }
    public func candidates(device: PreparedNativeDevice, keys: any NativeIdentityProvider) async throws -> [NativePathCandidate] {
        let current = generation
        guard let key else { return [] }
        let now = Date().timeIntervalSince1970 * 1000
        guard now >= 0, now <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }
        let names = try NativeDiscoveryWire.expectedNames(key: key, nowMs: UInt64(now))
        var result: [NativePathCandidate] = []
        for item in found.filter({ names.contains($0.label) }).prefix(2) {
            let id = "lan-" + item.label + "-\(item.interface.index)"
            result.append(try NativePathCandidate(id: id, kind: .direct) { [weak self] in
                let book = device.currentAddressBook()
                let routed = Set(NativeDirectEndpoint.signed(book))
                let resolution = await ServiceResolution(label: item.label, interface: item.interface.name, routed: routed)
                let (address, port) = try await resolution.resolve()
                let allowRouted = Double(book?.expiresAt ?? 0) > Date().timeIntervalSince1970 * 1_000
                    && routed.contains(NativeDirectEndpoint(host: address, port: port))
                guard let self, await self.permits(address, label: item.label, interface: item.interface.name, generation: current, allowRouted: allowRouted) else { throw NativeFailure.unavailable }
                return try await NativeHTTPConnection.open(host: address, port: port, rootSpki: device.rootSpki,
                    knockKey: device.knockKey, identity: keys.identity(), interface: item.interface)
            })
        }
        return result
    }
    private func permits(_ address: String, label: String, interface: String, generation current: UUID, allowRouted: Bool) -> Bool {
        let now = Date().timeIntervalSince1970 * 1000
        guard now >= 0, now <= Double(LinkBytes.maximumInteger), let key,
              let names = try? NativeDiscoveryWire.expectedNames(key: key, nowMs: UInt64(now)) else { return false }
        return current == generation && browser != nil && names.contains(label) && found.contains { $0.label == label && $0.interface.name == interface }
            && NativeDiscoveryWire.isCurrentPeer(address, interface: interface, allowRouted: allowRouted)
    }
}
