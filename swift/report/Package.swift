// swift-tools-version:6.0
import PackageDescription

// Error codes, the image report v1, canonical JSON, the commit message, the output JSON and
// the verify JSON. No dependencies.
let package = Package(
  name: "report",
  products: [
    .library(name: "Report", targets: ["Report"])
  ],
  targets: [
    .target(name: "Report"),
    .testTarget(name: "ReportTests", dependencies: ["Report"]),
  ]
)
