const assert = require("node:assert/strict");
const test = require("node:test");
const {AnalyticsValidationError, normalizeAnalyticsRequest} = require("../admin_analytics");

test("all-time analytics works when both dates are omitted", () => {
    const now = new Date("2026-11-03T12:00:00.000Z");
    const request = normalizeAnalyticsRequest({action: "overview"}, now);
    assert.equal(request.from, "1970-01-01T00:00:00.000Z");
    assert.equal(request.to, now.toISOString());
});

test("ISO period and numeric pagination strings are normalized", () => {
    const request = normalizeAnalyticsRequest({
        action: "users",
        from: "2026-11-01T00:00:00+00:00",
        to: "2026-11-04T00:00:00+00:00",
        limit: "10",
        offset: "0",
    });
    assert.equal(request.limit, 10);
    assert.equal(request.offset, 0);
    assert.equal(request.from, "2026-11-01T00:00:00.000Z");
});

test("only one missing date identifies the invalid parameter", () => {
    assert.throws(
        () => normalizeAnalyticsRequest({action: "overview", from: "2026-11-01T00:00:00Z"}),
        error => error instanceof AnalyticsValidationError && error.parameter === "to"
    );
});

test("reversed and malformed periods are rejected", () => {
    assert.throws(
        () => normalizeAnalyticsRequest({action: "overview", from: "bad", to: "2026-11-02T00:00:00Z"}),
        error => error.parameter === "from"
    );
    assert.throws(
        () => normalizeAnalyticsRequest({action: "report", from: "2026-11-03T00:00:00Z", to: "2026-11-02T00:00:00Z"}),
        error => error.parameter === "period"
    );
});
