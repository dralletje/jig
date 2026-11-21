// swift-tools-version:6.0
import PackageDescription

// What the sandboxes that use the Docker CLI share: telling a missing image from an unreachable daemon,
// and removing a container also when the daemon creates it after its client was killed.
let package = Package(
  name: "docker",
  products: [
    .library(name: "Docker", targets: ["Docker"])
  ],
  dependencies: [
    .package(path: "../report"),
    .package(path: "../process"),
  ],
  targets: [
    .target(
      name: "Docker",
      dependencies: [
        .product(name: "Report", package: "report"),
        .product(name: "ChildProcess", package: "process"),
      ]),
    .testTarget(
      name: "DockerTests",
      dependencies: ["Docker", .product(name: "Report", package: "report"), .product(name: "ChildProcess", package: "process")]),
  ]
)
