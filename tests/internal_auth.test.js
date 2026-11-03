const assert = require("node:assert/strict");
const test = require("node:test");
const {resolveInternalToken, isInternalAuthorized} = require("../internal_auth");

function requestWith(token) {
    return {headers: token === undefined ? {} : {"x-internal-token": token}};
}

test("correct configured internal token is authorized", () => {
    const auth = resolveInternalToken(" shared-secret ", "unused");
    assert.equal(auth.scheme, "configured_internal_token");
    assert.equal(isInternalAuthorized(requestWith("shared-secret"), auth.token), true);
});

test("missing internal token is rejected", () => {
    const auth = resolveInternalToken("", "");
    assert.equal(auth.scheme, "missing");
    assert.equal(isInternalAuthorized(requestWith(), auth.token), false);
});

test("wrong internal token is rejected", () => {
    const auth = resolveInternalToken("shared-secret", "unused");
    assert.equal(isInternalAuthorized(requestWith("wrong-secret"), auth.token), false);
});

test("both processes can derive the same compatibility token without logging it", () => {
    const first = resolveInternalToken("", "existing-jwt-secret");
    const second = resolveInternalToken(null, "existing-jwt-secret");
    assert.equal(first.scheme, "derived_from_jwt_secret");
    assert.equal(first.token, second.token);
    assert.notEqual(first.token, "existing-jwt-secret");
});
