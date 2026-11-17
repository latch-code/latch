import Darwin
import Foundation
import Security

@main
struct PresenceChildFixture {
    static func requirement(_ identifier: String) -> SecRequirement {
        var result: SecRequirement?
        let text = "identifier \"\(identifier)\""
        guard SecRequirementCreateWithString(text as CFString, [], &result) == errSecSuccess, let result else { exit(2) }
        return result
    }

    static func reaped(_ child: SuspendedPresenceChild) -> Bool {
        var status: Int32 = 0
        let waited = waitpid(child.pid, &status, WNOHANG)
        if waited == 0 {
            kill(child.pid, SIGKILL)
            while waitpid(child.pid, &status, 0) < 0 && errno == EINTR {}
        }
        return waited == -1 && errno == ECHILD
    }

    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count == 3, let rejected = SuspendedPresenceChild.start(path: arguments[1]) else { exit(3) }
        let denied = rejected.run(requirement: requirement("dev.latch.presence.different-fixture"), cancelled: { false })
        guard reaped(rejected), denied == nil else { exit(4) }
        FileHandle.standardOutput.write(Data("rejected and reaped\n".utf8))

        guard let accepted = SuspendedPresenceChild.start(path: arguments[1]) else { exit(5) }
        let result = accepted.run(requirement: requirement(arguments[2]), cancelled: { false })
        guard reaped(accepted), result == 0 else { exit(6) }
        FileHandle.standardOutput.write(Data("accepted and reaped\n".utf8))
    }
}
