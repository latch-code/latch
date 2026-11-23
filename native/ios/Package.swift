// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "LatchNative",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "LatchNativeCore", targets: ["LatchNativeCore"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.104.0"),
        .package(url: "https://github.com/apple/swift-nio-http2.git", exact: "1.46.0"),
        .package(url: "https://github.com/apple/swift-nio-transport-services.git", exact: "1.28.0"),
        // Pin transitive packages too; the newest Collections release has not passed the seven-day window.
        .package(url: "https://github.com/apple/swift-atomics.git", exact: "1.3.1"),
        .package(url: "https://github.com/apple/swift-collections.git", exact: "1.7.3"),
        .package(url: "https://github.com/apple/swift-system.git", exact: "1.8.1"),
    ],
    targets: [
        .target(name: "LatchNativeCore", dependencies: [
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOHTTP1", package: "swift-nio"),
            .product(name: "NIOHTTP2", package: "swift-nio-http2"),
            .product(name: "NIOTransportServices", package: "swift-nio-transport-services"),
        ]),
        .executableTarget(name: "LatchNativeFixture", dependencies: [
            "LatchNativeCore",
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOEmbedded", package: "swift-nio"),
            .product(name: "NIOHTTP2", package: "swift-nio-http2"),
            .product(name: "NIOTransportServices", package: "swift-nio-transport-services"),
        ], path: "Testkit"),
    ],
    swiftLanguageModes: [.v6]
)
