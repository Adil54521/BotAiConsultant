const assert = require("node:assert/strict");
const test = require("node:test");

const dbPath = require.resolve("../db");
const existing = new Map();
let counters = {
    global_minute: "0", user_minute: "0", daily_requests: "0",
    pending_count: "0", daily_cost: "0",
};

const client = {
    async query(sql, params = []) {
        if (/SELECT status FROM messages/.test(sql)) {
            const status = existing.get(params[0]);
            return {rows: status ? [{status}] : [], rowCount: status ? 1 : 0};
        }
        if (/AS global_minute/.test(sql)) return {rows: [counters], rowCount: 1};
        if (/INSERT INTO messages/.test(sql)) {
            const requestIndex = sql.split("(")[1].split(")")[0].split(",").indexOf("request_id");
            existing.set(params[requestIndex], "pending");
            return {rows: [{id: 1}], rowCount: 1};
        }
        return {rows: [], rowCount: 0};
    },
    release() {},
};

require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        async query(sql) {
            if (/FROM public\.chats/.test(sql)) {
                return {rows: [{id: 7, telegram_id: "100", phone_verified: true}], rowCount: 1};
            }
            if (/information_schema\.columns/.test(sql)) {
                return {rows: ["source", "telegram_message_id", "retry_count"].map(column_name => ({column_name}))};
            }
            return {rows: [], rowCount: 0};
        },
        async connect() { return client; },
    },
};

const {claimAiRequest} = require("../analytics");
const limits = {
    timezone: "Asia/Qyzylorda",
    perUserPerMinute: 6,
    globalPerMinute: 60,
    maxConcurrent: 4,
    dailyRequestLimit: 500,
    dailyCostLimitUsd: 10,
    pendingReserveUsd: 0.02,
    pendingTimeoutSeconds: 180,
    inputRate: 0.30,
    cachedRate: 0.03,
    outputRate: 2.50,
    searchRate: 0.014,
};

function request(requestId) {
    return {
        telegramId: 100,
        telegramMessageId: 55,
        requestId,
        requestedAt: "2026-11-05T00:00:00Z",
        model: "gemini-3.5-flash-lite",
        route: "chat",
        source: "telegram",
    };
}

test("first Telegram request is claimed and repeated delivery is rejected", async () => {
    existing.clear();
    counters = {...counters, daily_cost: "0"};
    const id = "8ae1eb52-5e21-45fd-9da8-11475058f0a1";
    const first = await claimAiRequest(request(id), limits);
    const duplicate = await claimAiRequest(request(id), limits);
    assert.equal(first.claimed, true);
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.reason, "duplicate");
});

test("daily estimated cost limit fails closed before a Gemini call", async () => {
    existing.clear();
    counters = {...counters, daily_cost: "10.00"};
    const blocked = await claimAiRequest(
        request("6a3e0c2f-c3ca-46d4-98fb-4b123a922d0c"), limits
    );
    assert.equal(blocked.claimed, false);
    assert.equal(blocked.reason, "daily_cost_limit");
    assert.equal(existing.size, 0);
});

test("per-user rate limit blocks a burst", async () => {
    existing.clear();
    counters = {...counters, daily_cost: "0", user_minute: "6"};
    const blocked = await claimAiRequest(
        request("2e8aec08-4b09-4d87-84d7-2985a8ec4531"), limits
    );
    assert.equal(blocked.reason, "user_rate_limit");
});
