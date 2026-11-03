const assert = require("node:assert/strict");
const test = require("node:test");

const calls = [];
const dbPath = require.resolve("../db");
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        query: async (sql, params) => {
            calls.push({sql, params});
            if (sql.includes("INSERT INTO chats")) {
                return {rowCount: 1, rows: [{id: 7, telegram_id: params[0], phone: params[2], phone_verified: true}]};
            }
            return {rowCount: 0, rows: []};
        },
    },
};

const {normalizePhone, registerBotUser} = require("../analytics");

test("phone normalization keeps only a canonical international value", () => {
    assert.equal(normalizePhone("+7 (701) 123-45-67"), "+77011234567");
    assert.equal(normalizePhone("123"), null);
});

test("registration upserts the existing chats row by Telegram ID", async () => {
    calls.length = 0;
    const user = await registerBotUser({
        telegramId: 123456,
        phone: "+77011234567",
        fullName: "Test User",
    });
    assert.equal(user.telegram_id, "123456");
    assert.match(calls[0].sql, /INSERT INTO chats/);
    assert.match(calls[0].sql, /ON CONFLICT \(student_id\) DO UPDATE/);
    assert.doesNotMatch(calls[0].sql, /ai_conversations|ai_usage_events/);
});

test("registration rejects an invalid Telegram ID before querying the database", async () => {
    calls.length = 0;
    await assert.rejects(
        registerBotUser({telegramId: "bad", phone: "+77011234567"}),
        /INVALID_TELEGRAM_ID/
    );
    assert.equal(calls.length, 0);
});
