// swift-tools-version:6.0
import PackageDescription

// Container images from OCI registries, without Docker: image references, SHA-256, manifests, the
// registry client (public images, anonymous tokens), jig's OCI-layout image store, resolving and
// downloading images, unpacking their layers into a folder, and archives `docker load` reads.
let package = Package(
  name: "oci",
  products: [
    .library(name: "OCI", targets: ["OCI"])
  ],
  dependencies: [
    .package(path: "../report")
  ],
  targets: [
    // zlib, from the system (host tests) or the Static Linux SDK (the binary).
    .systemLibrary(name: "CZlib", path: "Sources/CZlib"),
    .target(
      name: "OCI",
      dependencies: [
        "CZlib",
        .product(name: "Report", package: "report"),
      ]),
    .testTarget(
      name: "OCITests",
      dependencies: ["OCI", .product(name: "Report", package: "report")]),
  ]
)
