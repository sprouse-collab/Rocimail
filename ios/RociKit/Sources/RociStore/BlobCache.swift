import Foundation

/// Content-addressed on-disk cache for attachments and other blobs, with a
/// byte budget and LRU eviction (by file access order, approximated with
/// modification dates refreshed on read).
public final class BlobCache {
    private let directory: URL
    private let budgetBytes: Int
    private let fileManager = FileManager.default

    public init(directory: URL, budgetBytes: Int = 256 * 1024 * 1024) throws {
        self.directory = directory
        self.budgetBytes = budgetBytes
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func fileURL(for key: String) -> URL {
        let safe = key.unicodeScalars.map { scalar -> String in
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_" {
                return String(scalar)
            }
            return String(format: "%%%02X", scalar.value)
        }.joined()
        return directory.appendingPathComponent(safe)
    }

    public func contains(key: String) -> Bool {
        fileManager.fileExists(atPath: fileURL(for: key).path)
    }

    public func data(for key: String) -> Data? {
        let url = fileURL(for: key)
        guard let data = try? Data(contentsOf: url) else { return nil }
        // Touch so eviction treats it as recently used.
        try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    public func store(_ data: Data, for key: String) throws {
        try data.write(to: fileURL(for: key), options: .atomic)
        try evictIfNeeded()
    }

    public func remove(key: String) {
        try? fileManager.removeItem(at: fileURL(for: key))
    }

    public func removeAll() {
        guard let items = try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        ) else { return }
        for item in items {
            try? fileManager.removeItem(at: item)
        }
    }

    public func totalBytes() -> Int {
        entries().reduce(0) { $0 + $1.size }
    }

    private struct Entry {
        var url: URL
        var size: Int
        var modified: Date
    }

    private func entries() -> [Entry] {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let items = try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: keys
        ) else { return [] }
        return items.compactMap { url in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return Entry(
                url: url,
                size: values.fileSize ?? 0,
                modified: values.contentModificationDate ?? .distantPast
            )
        }
    }

    private func evictIfNeeded() throws {
        var all = entries()
        var total = all.reduce(0) { $0 + $1.size }
        guard total > budgetBytes else { return }
        // Oldest first.
        all.sort { $0.modified < $1.modified }
        for entry in all {
            guard total > budgetBytes else { break }
            try? fileManager.removeItem(at: entry.url)
            total -= entry.size
        }
    }
}
