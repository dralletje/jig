/// A registry image resolved for this machine: what the commit records and what runs.
public struct ResolvedImage: Equatable, Sendable {
  /// The digest the tag points to (an index for multi-platform images): what the commit records.
  public var pinned: Digest
  /// The `linux/<host arch>` manifest: what runs, and what the image folder and the Docker load are keyed by.
  public var manifest: Digest
  /// The manifest's config descriptor (the config blob is in the store).
  public var configDescriptor: Descriptor
  public var config: ImageConfigFile
  /// The manifest's layers, in order (each blob is in the store).
  public var layers: [Descriptor]
  /// Set when a tag could not be checked with its registry and the copy downloaded earlier was used.
  public var note: String?

  public init(
    pinned: Digest, manifest: Digest, configDescriptor: Descriptor, config: ImageConfigFile, layers: [Descriptor],
    note: String? = nil
  ) {
    self.pinned = pinned
    self.manifest = manifest
    self.configDescriptor = configDescriptor
    self.config = config
    self.layers = layers
    self.note = note
  }
}
