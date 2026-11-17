import Darwin
import Foundation
import Security

struct SuspendedPresenceChild {
    let pid: pid_t

    static func start(path: String) -> Self? {
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { return nil }
        defer { posix_spawnattr_destroy(&attributes) }

        // The launcher catches these through dispatch; the helper still receives their normal actions.
        var defaults = sigset_t()
        sigemptyset(&defaults)
        sigaddset(&defaults, SIGINT)
        sigaddset(&defaults, SIGTERM)
        guard posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETSIGDEF)) == 0,
              let argument = strdup(path) else { return nil }
        defer { free(argument) }
        let arguments: [UnsafeMutablePointer<CChar>?] = [argument, nil]
        let environment: [UnsafeMutablePointer<CChar>?] = [nil]
        var pid: pid_t = 0
        let result = arguments.withUnsafeBufferPointer { argv in
            environment.withUnsafeBufferPointer { envp in
                posix_spawn(&pid, path, nil, &attributes, argv.baseAddress!, envp.baseAddress!)
            }
        }
        return result == 0 && pid > 0 ? Self(pid: pid) : nil
    }

    private func matches(_ requirement: SecRequirement) -> Bool {
        var running: SecCode?
        let guest = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        return SecCodeCopyGuestWithAttributes(nil, guest, [], &running) == errSecSuccess
            && running.map { SecCodeCheckValidity($0, [], requirement) == errSecSuccess } == true
    }

    private func terminateAndReap() {
        kill(pid, SIGKILL)
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    }

    // The child remains suspended until the actual running image passes the requirement. This thread alone signals
    // and reaps it, so cancellation never addresses a PID after it can have been reused.
    func run(requirement: SecRequirement, cancelled: () -> Bool) -> Int32? {
        guard !cancelled(), matches(requirement), !cancelled(), kill(pid, SIGCONT) == 0 else {
            terminateAndReap()
            return nil
        }
        while !cancelled() {
            var status: Int32 = 0
            let waited = waitpid(pid, &status, WNOHANG)
            if waited == pid { return status }
            if waited < 0 && errno != EINTR { return nil }
            usleep(50_000)
        }
        terminateAndReap()
        return nil
    }
}
