import Foundation

/// Turns raw user input into a safe FTS5 MATCH expression.
///
/// M0 scope: terms are quoted (so FTS5 operators in user input can't inject
/// syntax), joined with implicit AND, and the final term is a prefix match so
/// search-as-you-type feels instant. The full query language (`from:`,
/// `has:pdf`, date ranges) lands in M3.
public enum FTSQueryBuilder {
    /// Returns nil when the input contains nothing searchable.
    public static func matchExpression(for userQuery: String) -> String? {
        let terms = userQuery
            .split(whereSeparator: { $0.isWhitespace })
            .map { term -> String in
                // FTS5 escapes a double quote inside a quoted string by doubling it.
                let cleaned = term.replacingOccurrences(of: "\"", with: "\"\"")
                return cleaned
            }
            .filter { !$0.isEmpty }

        guard !terms.isEmpty else { return nil }

        var quoted = terms.map { "\"\($0)\"" }
        // Prefix-match the final term for incremental search.
        if let last = quoted.last {
            quoted[quoted.count - 1] = last + "*"
        }
        return quoted.joined(separator: " ")
    }
}
