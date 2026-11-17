// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "FreiraumKit",
    defaultLocalization: "de",
    platforms: [.iOS("26.0"), .macOS("26.0")],
    products: [
        .library(name: "FreiraumKit", targets: ["FreiraumKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.6.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.0.0"),
    ],
    targets: [
        // Aus openapi/openapi.yaml generierter Client (Build-Plugin, nichts davon ist eingecheckt).
        .target(
            name: "FreiraumAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
        // Alles ohne Oberfläche: Geldbeträge, Monate, Darstellung, Dienst, Widget-Schnappschuss.
        .target(
            name: "FreiraumKit",
            dependencies: [
                "FreiraumAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ]
        ),
        .testTarget(
            name: "FreiraumKitTests",
            dependencies: [
                "FreiraumKit",
                "FreiraumAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ]
        ),
    ]
)
