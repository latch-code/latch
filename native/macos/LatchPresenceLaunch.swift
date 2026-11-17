import Darwin
import Foundation
import Security

private func refuse() -> Never {
    FileHandle.standardOutput.write(Data("{\"result\":\"error\",\"error\":\"helper-identity\"}\n".utf8))
    exit(1)
}

@main
private struct PresenceLaunch {
    static func main() {
        // ReleaseTeam is generated from the same compile-time Team ID as the Host.
        guard CommandLine.arguments.count == 1,
              ReleaseTeam.id.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { refuse() }
        let parent = getppid()
        guard parent > 1 else { refuse() }
        let interrupted = DispatchSemaphore(value: 0)
        let signals = [SIGINT, SIGTERM].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { interrupted.signal() }
            source.resume()
            return source
        }
        defer { for source in signals { source.cancel() } }
        func cancelled() -> Bool {
            return getppid() != parent || interrupted.wait(timeout: .now()) == .success
        }
        let helper = Bundle.main.executableURL!.resolvingSymlinksInPath()
            .deletingLastPathComponent().appendingPathComponent("latch-presence")
        let text = "anchor apple generic and identifier \"dev.latch.presence\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(ReleaseTeam.id)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              let requirement else { refuse() }
        var disk: SecStaticCode?
        guard SecStaticCodeCreateWithPath(helper as CFURL, [], &disk) == errSecSuccess, let disk,
              SecStaticCodeCheckValidity(disk, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { refuse() }

        guard !cancelled(), let child = SuspendedPresenceChild.start(path: helper.path),
              let status = child.run(requirement: requirement, cancelled: cancelled) else { refuse() }
        exit(status == 0 ? 0 : 1)
    }
}
