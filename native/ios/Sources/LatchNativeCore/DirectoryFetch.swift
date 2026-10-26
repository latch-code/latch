import Darwin
import Foundation
import Network
import Security

/** HTTP parsing is bounded before any signature work. Redirects and content transforms are never interpreted. */
public struct NativeDirectoryHTTPParser: Sendable {
    private var bytes = Data()
    private var headerEnd: Int?
    private var length: Int?
    private var chunked = false
    public init() {}
    public mutating func append(_ input: Data, complete: Bool = false) throws -> Data? {
        guard bytes.count + input.count <= 65_536 else { throw NativeFailure.invalidRecord }
        bytes.append(input)
        if headerEnd == nil {
            guard let end = bytes.range(of: Data("\r\n\r\n".utf8)) else {
                guard bytes.count <= 8192, !complete else { throw NativeFailure.invalidRecord }; return nil
            }
            guard end.upperBound <= 8192, let text = String(data: bytes[..<end.lowerBound], encoding: .ascii) else { throw NativeFailure.invalidRecord }
            let lines = text.components(separatedBy: "\r\n")
            guard let status = lines.first, LinkBytes.matches(status, "HTTP/1\\.[01] 200( [\\x20-\\x7e]*)?") else { throw NativeFailure.unavailable }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":"), line.first != " ", line.first != "\t" else { throw NativeFailure.invalidRecord }
                let key = line[..<colon].lowercased(), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                guard LinkBytes.matches(key, "[a-z0-9!#$%&'*+.^_`|~-]+"), headers[key] == nil,
                      value.utf8.allSatisfy({ $0 == 9 || ($0 >= 32 && $0 < 127) }) else { throw NativeFailure.invalidRecord }
                headers[key] = value
            }
            if let encoding = headers["content-encoding"], encoding.lowercased() != "identity" { throw NativeFailure.invalidRecord }
            if let raw = headers["content-length"] {
                guard LinkBytes.matches(raw, "[0-9]{1,5}"), let value = Int(raw), value <= 32_768 else { throw NativeFailure.invalidRecord }; length = value
            }
            if let encoding = headers["transfer-encoding"] {
                guard encoding.lowercased() == "chunked", length == nil else { throw NativeFailure.invalidRecord }; chunked = true
            }
            headerEnd = end.upperBound
        }
        guard let start = headerEnd else { return nil }
        let body = Data(bytes.dropFirst(start))
        if chunked { return try Self.chunks(body, complete: complete) }
        guard body.count <= 32_768 else { throw NativeFailure.invalidRecord }
        if let length {
            guard body.count <= length, !complete || body.count == length else { throw NativeFailure.invalidRecord }
            return body.count == length ? body : nil
        }
        return complete ? body : nil
    }
    private static func chunks(_ bytes: Data, complete: Bool) throws -> Data? {
        var offset = 0, result = Data(), chunks = 0
        while offset < bytes.count {
            guard let end = bytes.range(of: Data("\r\n".utf8), in: offset..<bytes.count) else {
                guard bytes.count - offset <= 128, !complete else { throw NativeFailure.invalidRecord }; return nil
            }
            let line = bytes[offset..<end.lowerBound]
            guard line.count <= 128, let text = String(data: line, encoding: .ascii), LinkBytes.matches(text, "[a-fA-F0-9]{1,8}(;[\\x20-\\x7e]*)?"),
                  let raw = text.split(separator: ";", maxSplits: 1).first, let count = Int(raw, radix: 16), count <= 32_768 else { throw NativeFailure.invalidRecord }
            offset = end.upperBound
            if count == 0 {
                if bytes.count == offset + 2, bytes.suffix(2) == Data("\r\n".utf8) { return result }
                guard bytes.count - offset <= 8192 else { throw NativeFailure.invalidRecord }
                if let end = bytes.range(of: Data("\r\n\r\n".utf8), in: offset..<bytes.count) {
                    guard end.upperBound == bytes.count else { throw NativeFailure.invalidRecord }; return result
                }
                guard !complete else { throw NativeFailure.invalidRecord }; return nil
            }
            chunks += 1
            guard chunks <= 1024, result.count + count <= 32_768 else { throw NativeFailure.invalidRecord }
            guard bytes.count - offset >= count + 2 else { if complete { throw NativeFailure.invalidRecord }; return nil }
            result.append(bytes[offset..<(offset + count)]); offset += count
            guard bytes[offset..<(offset + 2)] == Data("\r\n".utf8) else { throw NativeFailure.invalidRecord }; offset += 2
        }
        if complete { throw NativeFailure.invalidRecord }; return nil
    }
}

private final class DirectoryDNSWait: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: Result<[String], Error>?
    private var continuation: CheckedContinuation<[String], Error>?
    func install(_ next: CheckedContinuation<[String], Error>) {
        let result = lock.withLock { () -> Result<[String], Error>? in
            if let outcome { return outcome }; continuation = next; return nil
        }
        if let result { next.resume(with: result) }
    }
    func finish(_ result: Result<[String], Error>) {
        let pending = lock.withLock { () -> CheckedContinuation<[String], Error>? in
            guard outcome == nil else { return nil }; outcome = result
            let previous = continuation; continuation = nil; return previous
        }
        pending?.resume(with: result)
    }
}
private final class DirectoryDNS: @unchecked Sendable {
    static let shared = DirectoryDNS()
    private let lock = NSLock()
    private var jobs = 0
    private static func text(_ bytes: [CChar]) -> String { String(decoding: bytes.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self) }
    private static func canonical(_ value: String) -> String? {
        var v4 = in_addr(), v6 = in6_addr(), text = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        if value.withCString({ inet_pton(AF_INET, $0, &v4) }) == 1 {
            guard inet_ntop(AF_INET, &v4, &text, socklen_t(text.count)) != nil else { return nil }; return Self.text(text)
        }
        if value.withCString({ inet_pton(AF_INET6, $0, &v6) }) == 1 {
            guard inet_ntop(AF_INET6, &v6, &text, socklen_t(text.count)) != nil else { return nil }; return Self.text(text)
        }
        return nil
    }
    func addresses(_ host: String, timeout: TimeInterval) async throws -> [String] {
        if AddressBookCodec.isIP(host) { return try Self.checked([host]) }
        let admitted = lock.withLock { if jobs >= 2 { return false }; jobs += 1; return true }
        guard admitted else { throw NativeFailure.unavailable }
        let wait = DirectoryDNSWait()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                wait.install(continuation)
                DispatchQueue.global(qos: .utility).async { [self] in
                    var hints = addrinfo(); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP
                    var list: UnsafeMutablePointer<addrinfo>?
                    let status = getaddrinfo(host, nil, &hints, &list)
                    var values: [String] = [], cursor = list, total = 0
                    while let item = cursor, total < 64 {
                        total += 1
                        if let address = item.pointee.ai_addr {
                            var text = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                            if getnameinfo(address, item.pointee.ai_addrlen, &text, socklen_t(text.count), nil, 0, NI_NUMERICHOST) == 0 { values.append(Self.text(text)) }
                        }
                        cursor = item.pointee.ai_next
                    }
                    if let list { freeaddrinfo(list) }
                    // A cancelled caller does not release this process-wide DNS slot before libc really returns.
                    lock.withLock { jobs -= 1 }
                    guard status == 0 else { wait.finish(.failure(NativeFailure.unavailable)); return }
                    do { wait.finish(.success(try Self.checked(values))) } catch { wait.finish(.failure(NativeFailure.unavailable)) }
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + max(0, timeout)) { wait.finish(.failure(NativeFailure.unavailable)) }
            }
        } onCancel: { wait.finish(.failure(NativeFailure.unavailable)) }
    }
    static func checked(_ candidates: [String]) throws -> [String] {
        var own = Set<String>(), interfaces: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&interfaces) == 0 {
            var cursor = interfaces
            while let item = cursor {
                if let address = item.pointee.ifa_addr, [AF_INET, AF_INET6].contains(Int32(address.pointee.sa_family)) {
                    var text = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(address, socklen_t(address.pointee.sa_len), &text, socklen_t(text.count), nil, 0, NI_NUMERICHOST) == 0, let value = canonical(Self.text(text)) { own.insert(value) }
                }
                cursor = item.pointee.ifa_next
            }
            if let interfaces { freeifaddrs(interfaces) }
        } else { throw NativeFailure.unavailable }
        let result = Array(Set(candidates.compactMap(canonical).filter { NativeRelayDirectory.publicAddress($0) && !own.contains($0) })).sorted().prefix(8)
        guard !result.isEmpty else { throw NativeFailure.unavailable }; return Array(result)
    }
}

private final class DirectoryHTTPExchange: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.latch.directory.http")
    private let connection: NWConnection
    private let request: Data
    private let timeout: TimeInterval
    private var parser = NativeDirectoryHTTPParser()
    private var continuation: CheckedContinuation<Data, Error>?
    private var outcome: Result<Data, Error>?
    private var cancelled = false
    private var started = false
    init(url: URL, address: String, timeout: TimeInterval) throws {
        guard let hostname = url.host, let port = NWEndpoint.Port(rawValue: UInt16(url.port ?? 443)) else { throw NativeFailure.invalidRecord }
        let host = hostname.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), tls = NWProtocolTLS.Options(), security = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13); sec_protocol_options_set_max_tls_protocol_version(security, .TLSv13)
        sec_protocol_options_set_tls_server_name(security, host); sec_protocol_options_add_tls_application_protocol(security, "http/1.1")
        sec_protocol_options_set_tls_tickets_enabled(security, false); sec_protocol_options_set_tls_resumption_enabled(security, false)
        sec_protocol_options_set_tls_false_start_enabled(security, false)
        sec_protocol_options_set_verify_block(security, { metadata, trust, complete in
            let actual = sec_trust_copy_ref(trust).takeRetainedValue()
            guard SecTrustSetPolicies(actual, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
                  SecTrustSetNetworkFetchAllowed(actual, false) == errSecSuccess, SecTrustEvaluateWithError(actual, nil),
                  sec_protocol_metadata_get_negotiated_tls_protocol_version(metadata) == .TLSv13,
                  let selected = sec_protocol_metadata_get_negotiated_protocol(metadata), String(cString: selected) == "http/1.1" else { complete(false); return }
            complete(true)
        }, queue)
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true; tcp.connectionTimeout = 5
        let parameters = NWParameters(tls: tls, tcp: tcp); parameters.includePeerToPeer = false
        connection = NWConnection(host: .init(address), port: port, using: parameters)
        let authority = host.contains(":") ? "[\(host)]" : host
        request = Data("GET \(url.path.isEmpty ? "/" : url.path) HTTP/1.1\r\nHost: \(authority)\(url.port.map { ":\($0)" } ?? "")\r\nAccept: application/octet-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
        self.timeout = timeout
    }
    func run() async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { next in queue.async {
                self.continuation = next
                if self.cancelled { self.resolve(); return }
                self.connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready: self.connection.send(content: self.request, completion: .contentProcessed { error in
                        if error != nil { self.stop(.failure(NativeFailure.unavailable)) } else { self.receive() }
                    })
                    case .failed: self.stop(.failure(NativeFailure.unavailable))
                    case .cancelled: self.cancelled = true; self.resolve()
                    default: break
                    }
                }
                self.started = true; self.connection.start(queue: self.queue)
                self.queue.asyncAfter(deadline: .now() + max(0, self.timeout)) { self.stop(.failure(NativeFailure.unavailable)) }
            } }
        } onCancel: { self.queue.async { self.stop(.failure(NativeFailure.unavailable)) } }
    }
    private func receive() {
        guard outcome == nil else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
            guard self.outcome == nil else { return }
            do {
                if let body = try self.parser.append(data ?? Data(), complete: complete) { self.stop(.success(body)); return }
                if error != nil { throw NativeFailure.unavailable }; self.receive()
            } catch { self.stop(.failure(NativeFailure.unavailable)) }
        }
    }
    private func stop(_ result: Result<Data, Error>) {
        if outcome == nil { outcome = result }
        if !started { cancelled = true; connection.cancel(); resolve(); return }
        connection.cancel()
        if cancelled { resolve() }
    }
    private func resolve() {
        guard let continuation, let outcome else { return }; self.continuation = nil
        connection.stateUpdateHandler = nil; continuation.resume(with: outcome)
    }
}

public enum NativeDirectoryFetch {
    static func checkedAddress(_ address: String) throws -> String {
        guard let result = try DirectoryDNS.checked([address]).first else { throw NativeFailure.unavailable }; return result
    }
    /** Public-only checked DNS is pinned to the actual dial; the system PKI still verifies the mirror hostname. */
    public static func fetch(_ url: URL) async throws -> Data {
        try NativeDirectorySource.mirror(url.absoluteString)
        guard let hostname = url.host else { throw NativeFailure.invalidRecord }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        let addresses = try await DirectoryDNS.shared.addresses(hostname.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), timeout: 5)
        for address in addresses {
            try Task.checkCancellation()
            let remaining = ContinuousClock.now.duration(to: deadline), components = remaining.components
            let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
            guard seconds > 0 else { throw NativeFailure.unavailable }
            do { return try await DirectoryHTTPExchange(url: url, address: address, timeout: seconds).run() } catch { if Task.isCancelled { throw NativeFailure.unavailable } }
        }
        throw NativeFailure.unavailable
    }
}
