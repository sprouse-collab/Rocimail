import XCTest
@testable import RociSearch

final class FTSQueryBuilderTests: XCTestCase {
    func testSimpleTerms() {
        XCTAssertEqual(
            FTSQueryBuilder.matchExpression(for: "quarterly report"),
            "\"quarterly\" \"report\"*"
        )
    }

    func testSingleTermGetsPrefixMatch() {
        XCTAssertEqual(FTSQueryBuilder.matchExpression(for: "quart"), "\"quart\"*")
    }

    func testEmptyAndWhitespaceReturnNil() {
        XCTAssertNil(FTSQueryBuilder.matchExpression(for: ""))
        XCTAssertNil(FTSQueryBuilder.matchExpression(for: "   \n\t "))
    }

    func testFTSOperatorsAreNeutralized() {
        // Raw AND/OR/NEAR and column filters must not act as FTS5 syntax.
        XCTAssertEqual(
            FTSQueryBuilder.matchExpression(for: "alice AND bob"),
            "\"alice\" \"AND\" \"bob\"*"
        )
        XCTAssertEqual(
            FTSQueryBuilder.matchExpression(for: "subject:secret"),
            "\"subject:secret\"*"
        )
    }

    func testQuotesAreEscaped() {
        XCTAssertEqual(
            FTSQueryBuilder.matchExpression(for: "say \"hello\""),
            "\"say\" \"\"\"hello\"\"\"*"
        )
    }
}
