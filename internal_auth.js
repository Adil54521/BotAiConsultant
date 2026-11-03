const crypto = require("crypto");

const DERIVATION_CONTEXT = "bot-internal-api-v1:";

function resolveInternalToken(configuredToken, fallbackSeed) {
    const configured = String(configuredToken || "").trim();
    if (configured) return {token: configured, scheme: "configured_internal_token"};

    const seed = String(fallbackSeed || "").trim();
    if (!seed) return {token: null, scheme: "missing"};
    return {
        token: crypto.createHash("sha256").update(DERIVATION_CONTEXT + seed).digest("hex"),
        scheme: "derived_from_jwt_secret",
    };
}

function isInternalAuthorized(req, expectedToken) {
    if (!expectedToken) return false;
    const supplied = String(req.headers["x-internal-token"] || "").trim();
    const actual = Buffer.from(supplied, "utf8");
    const expected = Buffer.from(expectedToken, "utf8");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = {resolveInternalToken, isInternalAuthorized};
