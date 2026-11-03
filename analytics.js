const pool = require("./db");

function normalizePhone(phone) {
    const raw = String(phone || "").trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return `+${digits}`;
}

async function getBotUser(telegramId) {
    const result = await pool.query(
        `SELECT id, telegram_id, username, full_name, phone, phone_verified,
                first_name, last_name, registered_at, last_activity_at
         FROM ai_conversations WHERE telegram_id = $1 LIMIT 1`,
        [telegramId]
    );
    return result.rows[0] || null;
}

async function registerBotUser(data) {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("INVALID_PHONE");
    const result = await pool.query(
        `INSERT INTO ai_conversations
            (telegram_id, username, full_name, phone, phone_verified,
             first_name, last_name, registered_at, last_activity_at)
         VALUES ($1,$2,$3,$4,true,$5,$6,now(),now())
         ON CONFLICT (telegram_id) DO UPDATE SET
            username = EXCLUDED.username,
            full_name = EXCLUDED.full_name,
            phone = EXCLUDED.phone,
            phone_verified = true,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            registered_at = COALESCE(ai_conversations.registered_at, now()),
            last_activity_at = now()
         RETURNING id, telegram_id, phone, phone_verified, registered_at`,
        [data.telegramId, data.username || null, data.fullName || null, phone,
         data.firstName || null, data.lastName || null]
    );
    return result.rows[0];
}

async function touchBotUser(telegramId) {
    await pool.query(
        `UPDATE ai_conversations SET last_activity_at = now() WHERE telegram_id = $1`,
        [telegramId]
    );
}

async function recordAiUsage(data) {
    const user = await getBotUser(data.telegramId);
    if (!user || !user.phone_verified) throw new Error("USER_NOT_REGISTERED");
    const result = await pool.query(
        `INSERT INTO ai_usage_events
            (request_id, conversation_id, requested_at, model, route, status,
             prompt_tokens, candidate_tokens, thoughts_tokens, total_tokens,
             cached_tokens, duration_ms, error_type)
         VALUES ($1,$2,COALESCE($3::timestamptz,now()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING request_id`,
        [data.requestId, user.id, data.requestedAt || null, data.model, data.route || null,
         data.status, data.promptTokens ?? null, data.candidateTokens ?? null,
         data.thoughtsTokens ?? null, data.totalTokens ?? null,
         data.cachedTokens ?? null, data.durationMs, data.errorType || null]
    );
    await touchBotUser(data.telegramId);
    return { inserted: result.rowCount === 1 };
}

async function openSupportRequest(telegramId) {
    const user = await getBotUser(telegramId);
    if (!user || !user.phone_verified) throw new Error("USER_NOT_REGISTERED");
    const existing = await pool.query(
        `SELECT id FROM support_requests
         WHERE conversation_id=$1 AND status IN ('waiting','active')
         ORDER BY opened_at DESC LIMIT 1`, [user.id]
    );
    if (existing.rows[0]) return existing.rows[0];
    const result = await pool.query(
        `INSERT INTO support_requests(conversation_id) VALUES($1) RETURNING id`, [user.id]
    );
    return result.rows[0];
}

async function updateSupportRequest(telegramId, status) {
    const user = await getBotUser(telegramId);
    if (!user) return null;
    const result = await pool.query(
        `UPDATE support_requests SET
            status=$2,
            operator_connected_at=CASE WHEN $2='active' THEN COALESCE(operator_connected_at,now()) ELSE operator_connected_at END,
            closed_at=CASE WHEN $2 IN ('closed','failed') THEN now() ELSE closed_at END
         WHERE id=(SELECT id FROM support_requests WHERE conversation_id=$1 AND status IN ('waiting','active') ORDER BY opened_at DESC LIMIT 1)
         RETURNING id`, [user.id, status]
    );
    return result.rows[0] || null;
}

function periodParams(from, to) {
    if (!from || !to) throw new Error("INVALID_PERIOD");
    return [from, to];
}

async function getOverview(from, to) {
    const params = periodParams(from, to);
    const result = await pool.query(
        `SELECT
           (SELECT count(*) FROM ai_conversations WHERE phone_verified=true) AS registered_users,
           (SELECT count(*) FROM ai_conversations WHERE phone_verified=true AND registered_at >= $1 AND registered_at < $2) AS new_users,
           (SELECT count(DISTINCT conversation_id) FROM (
                SELECT conversation_id FROM ai_usage_events WHERE requested_at >= $1 AND requested_at < $2
                UNION ALL
                SELECT conversation_id FROM support_requests WHERE opened_at >= $1 AND opened_at < $2
            ) active) AS active_users,
           (SELECT count(DISTINCT conversation_id) FROM ai_usage_events WHERE requested_at >= $1 AND requested_at < $2) AS ai_users,
           (SELECT count(*) FROM ai_usage_events WHERE requested_at >= $1 AND requested_at < $2) AS ai_requests,
           (SELECT count(*) FROM ai_usage_events WHERE status='success' AND requested_at >= $1 AND requested_at < $2) AS successful_requests,
           (SELECT count(*) FROM ai_usage_events WHERE status<>'success' AND requested_at >= $1 AND requested_at < $2) AS failed_requests,
           (SELECT sum(total_tokens) FROM ai_usage_events WHERE requested_at >= $1 AND requested_at < $2) AS total_tokens,
           (SELECT avg(total_tokens) FROM ai_usage_events WHERE requested_at >= $1 AND requested_at < $2) AS avg_tokens,
           (SELECT sum(duration_ms) FROM ai_usage_events WHERE requested_at >= $1 AND requested_at < $2) AS total_duration_ms,
           (SELECT avg(duration_ms) FROM ai_usage_events WHERE requested_at >= $1 AND requested_at < $2) AS avg_duration_ms,
           (SELECT count(*) FROM support_requests WHERE opened_at >= $1 AND opened_at < $2) AS support_requests,
           (SELECT count(DISTINCT conversation_id) FROM support_requests WHERE opened_at >= $1 AND opened_at < $2) AS support_users,
           (SELECT min(created_at) FROM ai_usage_events) AS tracking_started_at`, params
    );
    return result.rows[0];
}

async function getUserStats(from, to, search = null, limit = 50, offset = 0) {
    const value = search ? `%${String(search).toLowerCase()}%` : null;
    const result = await pool.query(
        `SELECT c.telegram_id, c.full_name, c.username, c.phone, c.registered_at, c.last_activity_at,
                count(u.request_id) AS ai_requests,
                count(u.request_id) FILTER (WHERE u.status='success') AS successful_requests,
                count(u.request_id) FILTER (WHERE u.status<>'success') AS failed_requests,
                sum(u.prompt_tokens) AS prompt_tokens, sum(u.candidate_tokens) AS candidate_tokens,
                sum(u.thoughts_tokens) AS thoughts_tokens, sum(u.total_tokens) AS total_tokens,
                sum(u.cached_tokens) AS cached_tokens, avg(u.duration_ms) AS avg_duration_ms,
                max(u.requested_at) AS last_ai_at,
                (SELECT count(*) FROM support_requests s WHERE s.conversation_id=c.id AND s.opened_at >= $1 AND s.opened_at < $2) AS support_requests
         FROM ai_conversations c
         LEFT JOIN ai_usage_events u ON u.conversation_id=c.id AND u.requested_at >= $1 AND u.requested_at < $2
         WHERE c.phone_verified=true AND ($3::text IS NULL OR CAST(c.telegram_id AS text) ILIKE $3 OR lower(COALESCE(c.username,'')) ILIKE $3 OR c.phone ILIKE $3)
         GROUP BY c.id ORDER BY c.last_activity_at DESC NULLS LAST
         LIMIT $4 OFFSET $5`, [from, to, value, Math.min(limit, 1000000), offset]
    );
    return result.rows;
}

async function getUsageRows(from, to, limit = 1000000) {
    const result = await pool.query(
        `SELECT u.request_id, c.telegram_id, u.requested_at, u.model, u.status,
                u.prompt_tokens, u.candidate_tokens, u.thoughts_tokens, u.total_tokens,
                u.cached_tokens, u.duration_ms
         FROM ai_usage_events u JOIN ai_conversations c ON c.id=u.conversation_id
         WHERE u.requested_at >= $1 AND u.requested_at < $2
         ORDER BY u.requested_at LIMIT $3`, [from, to, Math.min(limit, 1000000)]
    );
    return result.rows;
}

async function getSupportRows(from, to, limit = 1000000) {
    const result = await pool.query(
        `SELECT s.id, c.telegram_id, s.opened_at, s.operator_connected_at, s.closed_at, s.status,
                CASE WHEN s.operator_connected_at IS NOT NULL THEN EXTRACT(EPOCH FROM (s.operator_connected_at-s.opened_at)) END AS wait_seconds,
                CASE WHEN s.closed_at IS NOT NULL THEN EXTRACT(EPOCH FROM (s.closed_at-s.opened_at)) END AS duration_seconds
         FROM support_requests s JOIN ai_conversations c ON c.id=s.conversation_id
         WHERE s.opened_at >= $1 AND s.opened_at < $2
         ORDER BY s.opened_at LIMIT $3`, [from, to, Math.min(limit, 1000000)]
    );
    return result.rows;
}

module.exports = { normalizePhone, getBotUser, registerBotUser, touchBotUser, recordAiUsage,
    openSupportRequest, updateSupportRequest, getOverview, getUserStats,
    getUsageRows, getSupportRows };
