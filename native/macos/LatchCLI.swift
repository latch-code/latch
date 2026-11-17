import Darwin
import Foundation

private let installMessage = "Latch 需要与应用架构一致的 Node.js 24.22.1 或更新的安全版本。请从 https://nodejs.org/ 安装，或更新 Homebrew、fnm、nvm 中的 Node 后重试；Latch 不会下载或安装 Node。\n"

private func acceptedVersion(_ text: String) -> Bool {
    let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".")
    guard parts.count == 3, let major = Int(parts[0]), let minor = Int(parts[1]), let patch = Int(parts[2]) else { return false }
    switch major {
    case 22: return minor > 23 || minor == 23 && patch >= 4
    case 24: return minor > 22 || minor == 22 && patch >= 1
    case 26: return minor > 12 || minor == 12 && patch >= 1
    default: return major > 26
    }
}

private func homeDirectory() -> String? {
    guard let user = getpwuid(getuid()), let home = user.pointee.pw_dir else { return nil }
    return String(cString: home)
}

private func trustedFile(_ path: String, root: String) -> String? {
    let fm = FileManager.default
    let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    let base = root
    guard real.hasPrefix(base + "/"), fm.isExecutableFile(atPath: real) else { return nil }
    var cursor = real
    while cursor != "/" {
        var info = stat()
        guard lstat(cursor, &info) == 0, info.st_uid == getuid() || info.st_uid == 0,
              info.st_mode & 0o022 == 0,
              cursor == real ? info.st_mode & S_IFMT == S_IFREG : info.st_mode & S_IFMT == S_IFDIR else { return nil }
        cursor = (cursor as NSString).deletingLastPathComponent
    }
    // A project script or version-manager shim is never probed as Node.
    guard let file = FileHandle(forReadingAtPath: real) else { return nil }
    defer { try? file.close() }
    guard let bytes = try? file.read(upToCount: 4), bytes.count == 4 else { return nil }
    let magic = Array(bytes)
    guard [[0xcf, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xca, 0xfe, 0xba, 0xbe], [0xca, 0xfe, 0xba, 0xbf]].contains(magic.map(Int.init)) else { return nil }
    return real
}

private func candidates(home: String) -> [(String, String)] {
    var found: [(String, String)] = [
        ("/opt/homebrew/bin/node", "/opt/homebrew/Cellar"),
        ("/usr/local/bin/node", "/usr/local/Cellar"),
        ("/usr/local/bin/node", "/usr/local/bin"),
    ]
    let versions = [
        (home + "/.nvm/versions/node", "bin/node"),
        (home + "/.local/share/fnm/node-versions", "installation/bin/node"),
        (home + "/Library/Application Support/fnm/node-versions", "installation/bin/node"),
    ]
    for (root, leaf) in versions {
        guard URL(fileURLWithPath: root).resolvingSymlinksInPath().path == root else { continue }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
        for name in names.filter({ $0.range(of: "^v[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil })
            .sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }).prefix(64) {
            found.append((root + "/" + name + "/" + leaf, root))
        }
    }
    return found
}

private func environment(home: String) -> [String: String] {
    let keep: Set<String> = ["USER", "LOGNAME", "TMPDIR", "LANG", "SHELL", "TERM", "COLORTERM", "TERM_PROGRAM", "SSH_AUTH_SOCK", "TMUX", "STY", "ZELLIJ", "__CF_USER_TEXT_ENCODING", "LATCH_DATA_DIR"]
    var env = ProcessInfo.processInfo.environment.filter { keep.contains($0.key) || $0.key.hasPrefix("LC_") }
    env["HOME"] = home
    // Never run a command from the working directory via an empty or relative PATH entry.
    let path = ProcessInfo.processInfo.environment["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env["PATH"] = path.split(separator: ":").filter { $0.hasPrefix("/") }.joined(separator: ":")
    return env
}

private func version(of path: String, env: [String: String]) -> String? {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: path)
    child.arguments = ["--disable-sigusr1", "--input-type=commonjs", "--eval", "process.stdout.write(process.versions.node+' '+process.arch)"]
    child.environment = env
    child.currentDirectoryURL = URL(fileURLWithPath: "/")
    child.standardInput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    let output = Pipe()
    child.standardOutput = output
    do { try child.run() } catch { return nil }
    let deadline = Date().addingTimeInterval(3)
    while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    if child.isRunning {
        child.terminate()
        let stop = Date().addingTimeInterval(0.5)
        while child.isRunning && Date() < stop { Thread.sleep(forTimeInterval: 0.02) }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        child.waitUntilExit()
        return nil
    }
    guard child.terminationStatus == 0,
          let data = try? output.fileHandleForReading.read(upToCount: 64),
          let text = String(data: data, encoding: .utf8) else { return nil }
    let parts = text.split(separator: " ")
    #if arch(arm64)
    let architecture = "arm64"
    #else
    let architecture = "x64"
    #endif
    guard parts.count == 2, parts[1] == architecture, acceptedVersion(String(parts[0])) else { return nil }
    return String(parts[0])
}

@main
private struct LatchCLI {
    static func main() {
        guard let home = homeDirectory() else { FileHandle.standardError.write(Data(installMessage.utf8)); exit(1) }
        let env = environment(home: home)
        var selected: (String, String)?
        for (path, root) in candidates(home: home) {
            if let real = trustedFile(path, root: root), let version = version(of: real, env: env) {
                selected = (real, version)
                break
            }
        }
        guard let (node, version) = selected else { FileHandle.standardError.write(Data(installMessage.utf8)); exit(1) }
        var args = Array(CommandLine.arguments.dropFirst())
        if args == ["--runtime-check"] {
            print("Node.js \(version)")
            return
        }
        if args == ["--runtime-path"] {
            let data = try! JSONSerialization.data(withJSONObject: ["path": node, "version": version])
            FileHandle.standardOutput.write(data)
            return
        }
        let executable = Bundle.main.executableURL!.resolvingSymlinksInPath()
        let root = executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("app")
        let bootstrap = args.first == "--internal-desktop-bootstrap"
        if bootstrap { args.removeFirst() }
        let script = root.appendingPathComponent(bootstrap ? "dist/desktop-launch.js" : "dist/latch.js").path
        guard FileManager.default.fileExists(atPath: script) else { FileHandle.standardError.write(Data("Latch 应用不完整，请重新安装。\n".utf8)); exit(1) }
        let argv = [node, "--disable-sigusr1", script] + args
        let strings = argv.map { strdup($0) }
        let variables = env.map { strdup("\($0.key)=\($0.value)") }
        defer { strings.forEach { free($0) }; variables.forEach { free($0) } }
        (strings + [nil]).withUnsafeBufferPointer { av in
            (variables + [nil]).withUnsafeBufferPointer { ev in _ = execve(node, av.baseAddress!, ev.baseAddress!) }
        }
        FileHandle.standardError.write(Data("无法启动 Node.js，请重新安装 Node 后重试。\n".utf8))
        exit(1)
    }
}
