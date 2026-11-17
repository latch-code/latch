import Darwin
import Foundation
import Security

// ReleaseTeam is generated from the same build-time Team ID as the Host. It is never read from the environment.
private nonisolated(unsafe) var childPID: pid_t = 0
private nonisolated(unsafe) var interrupted = false

private func refuse() -> Never {
    if childPID > 0 {
        kill(childPID, SIGKILL)
        var status: Int32 = 0
        while waitpid(childPID, &status, 0) < 0 && errno == EINTR {}
    }
    FileHandle.standardOutput.write(Data("{\"result\":\"error\",\"error\":\"helper-identity\"}\n".utf8))
    exit(1)
}

@main
private struct PresenceLaunch {
    static func main() {
        guard CommandLine.arguments.count == 1,
              ReleaseTeam.id.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { refuse() }
        let parent = getppid()
        guard parent > 1 else { refuse() }
        let monitor = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .global())
        monitor.setEventHandler {
            if childPID > 0 { kill(childPID, SIGKILL) }
            _exit(1)
        }
        monitor.resume()
        defer { monitor.cancel() }
        guard getppid() == parent else { refuse() }
        let helper = Bundle.main.executableURL!.resolvingSymlinksInPath()
            .deletingLastPathComponent().appendingPathComponent("latch-presence")
        let text = "anchor apple generic and identifier \"dev.latch.presence\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(ReleaseTeam.id)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              let requirement else { refuse() }
        var disk: SecStaticCode?
        guard SecStaticCodeCreateWithPath(helper as CFURL, [], &disk) == errSecSuccess, let disk,
              SecStaticCodeCheckValidity(disk, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { refuse() }

        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { refuse() }
        defer { posix_spawnattr_destroy(&attributes) }
        // The image is loaded but cannot execute, read the preview, or write approval bytes before its identity is checked.
        guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_START_SUSPENDED)) == 0 else { refuse() }
        let argument = strdup(helper.path)
        defer { free(argument) }
        let arguments = [argument, nil]
        let environment: [UnsafeMutablePointer<CChar>?] = [nil]
        signal(SIGTERM) { _ in interrupted = true; if childPID > 0 { kill(childPID, SIGTERM) } }
        signal(SIGINT) { _ in interrupted = true; if childPID > 0 { kill(childPID, SIGTERM) } }
        guard !interrupted else { refuse() }
        let result = arguments.withUnsafeBufferPointer { argv in
            environment.withUnsafeBufferPointer { envp in
                posix_spawn(&childPID, helper.path, nil, &attributes, argv.baseAddress!, envp.baseAddress!)
            }
        }
        guard result == 0, childPID > 0, !interrupted else { refuse() }
        // An unreaped child keeps its PID. Any exit or unknown signing state fails closed.
        var running: SecCode?
        let guest = [kSecGuestAttributePid: NSNumber(value: childPID)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, guest, [], &running) == errSecSuccess, let running,
              SecCodeCheckValidity(running, [], requirement) == errSecSuccess else { refuse() }
        guard !interrupted, getppid() == parent, kill(childPID, SIGCONT) == 0 else { refuse() }
        var status: Int32 = 0
        var waited: pid_t
        repeat { waited = waitpid(childPID, &status, 0) } while waited < 0 && errno == EINTR
        guard waited == childPID else { refuse() }
        childPID = 0
        exit(status == 0 ? 0 : 1)
    }
}
