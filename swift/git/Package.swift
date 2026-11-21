// swift-tools-version:6.0
import PackageDescription

// Git with a cleaned environment and exact (byte) paths: the export of HEAD, the capture, the checks on
// what an image left, and the commit's fast-forward.
let package = Package(
  name: "git",
  products: [
    .library(name: "Git", targets: ["Git"])
  ],
  dependencies: [
    .package(path: "../report"),
    .package(path: "../process"),
  ],
  targets: [
    .target(
      name: "Git",
      dependencies: [
        .product(name: "Report", package: "report"),
        .product(name: "ChildProcess", package: "process"),
      ]),
    .testTarget(name: "GitTests", dependencies: ["Git", .product(name: "Report", package: "report")]),
  ]
)
