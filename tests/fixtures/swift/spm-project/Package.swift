// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "spm-project",
    targets: [
        .target(name: "spm-project"),
        .testTarget(name: "spm-projectTests", dependencies: ["spm-project"]),
    ]
)
