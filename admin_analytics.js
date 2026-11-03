class AnalyticsValidationError extends Error {
    constructor(parameter, message) {
        super(message);
        this.name = "AnalyticsValidationError";
        this.code = "INVALID_ANALYTICS_REQUEST";
        this.parameter = parameter;
    }
}

function parseDate(value, parameter) {
    if (typeof value !== "string" || !value.trim()) {
        throw new AnalyticsValidationError(parameter, `${parameter} is required`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new AnalyticsValidationError(parameter, `${parameter} must be an ISO date`);
    }
    return parsed;
}

function boundedInteger(value, parameter, fallback, maximum) {
    if (value === undefined || value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
        throw new AnalyticsValidationError(parameter, `${parameter} is outside the allowed range`);
    }
    return parsed;
}

function normalizeAnalyticsRequest(data, now = new Date()) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new AnalyticsValidationError("body", "JSON object is required");
    }
    if (!new Set(["overview", "users", "report"]).has(data.action)) {
        throw new AnalyticsValidationError("action", "Unsupported analytics action");
    }

    let from;
    let to;
    if ((data.from === undefined || data.from === null || data.from === "")
        && (data.to === undefined || data.to === null || data.to === "")) {
        from = new Date(0);
        to = now;
    } else {
        from = parseDate(data.from, "from");
        to = parseDate(data.to, "to");
    }
    if (from >= to) {
        throw new AnalyticsValidationError("period", "from must be earlier than to");
    }

    const search = data.search === undefined || data.search === null
        ? null
        : String(data.search).trim().slice(0, 100);
    return {
        action: data.action,
        from: from.toISOString(),
        to: to.toISOString(),
        search: search || null,
        limit: boundedInteger(data.limit, "limit", 50, 1000),
        offset: boundedInteger(data.offset, "offset", 0, 10_000_000),
    };
}

module.exports = {AnalyticsValidationError, normalizeAnalyticsRequest};
