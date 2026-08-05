// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "RociKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "RociModel", targets: ["RociModel"]),
        .library(name: "RociMail", targets: ["RociMail"]),
        .library(name: "RociStore", targets: ["RociStore"]),
        .library(name: "RociSync", targets: ["RociSync"]),
        .library(name: "RociSearch", targets: ["RociSearch"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "6.29.0"),
    ],
    targets: [
        .target(name: "RociModel"),
        .target(name: "RociMail", dependencies: ["RociModel"]),
        .target(
            name: "RociStore",
            dependencies: [
                "RociModel",
                .product(name: "GRDB", package: "GRDB.swift"),
            ]
        ),
        .target(name: "RociSync", dependencies: ["RociModel", "RociMail", "RociStore"]),
        .target(name: "RociSearch", dependencies: ["RociModel"]),
        .testTarget(name: "RociMailTests", dependencies: ["RociMail"]),
        .testTarget(name: "RociStoreTests", dependencies: ["RociStore"]),
        .testTarget(name: "RociSyncTests", dependencies: ["RociSync"]),
        .testTarget(name: "RociSearchTests", dependencies: ["RociSearch"]),
    ]
)
