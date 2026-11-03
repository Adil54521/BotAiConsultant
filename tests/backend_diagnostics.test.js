const assert = require("node:assert/strict");
const test = require("node:test");
const {safeErrorMetadata} = require("../backend_diagnostics");

test("PostgreSQL primary-key failures keep diagnostics but redact identifiers", () => {
    const error = new Error("duplicate key value 7421578363 violates unique constraint");
    error.code = "23505";
    error.table = "chats";
    error.constraint = "chats_pkey";
    error.routine = "_bt_check_unique";
    const result = safeErrorMetadata("bot_user_register", error, "request_123", "register_bot_user");
    assert.equal(result.code, "23505");
    assert.equal(result.constraint, "chats_pkey");
    assert.equal(result.request_id, "request_123");
    assert.doesNotMatch(result.message, /7421578363/);
});
