const pool = require("./db");

function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

async function getBotUser(telegramId) {
    const result = await pool.query(
        `SELECT id, student_id AS telegram_id, student_name AS full_name, username,
                first_name, last_name, phone, phone_verified,
                created_at AS registered_at, last_activity_at
         FROM public.chats WHERE student_id=$1 LIMIT 1`, [telegramId]
    );
    return result.rows[0] || null;
}

async function registerBotUser(data) {
    const telegramId = String(data.telegramId || "");
    let telegramIdNumber;
    try {
        telegramIdNumber = BigInt(telegramId);
    } catch {
        throw new Error("INVALID_TELEGRAM_ID");
    }
    if (!/^\d{1,19}$/.test(telegramId)
        || telegramIdNumber <= 0n
        || telegramIdNumber > 9223372036854775807n) {
        throw new Error("INVALID_TELEGRAM_ID");
    }
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("INVALID_PHONE");
    const result = await pool.query(
        `INSERT INTO public.chats
            (student_id, student_name, phone, consultant_mode, username,
             first_name, last_name, phone_verified, last_activity_at)
         VALUES ($1,$2,$3,false,$4,$5,$6,true,now())
         ON CONFLICT (student_id) DO UPDATE SET
            student_name=EXCLUDED.student_name,
            phone=EXCLUDED.phone,
            username=EXCLUDED.username,
            first_name=EXCLUDED.first_name,
            last_name=EXCLUDED.last_name,
            phone_verified=true,
            last_activity_at=now()
         RETURNING id, student_id AS telegram_id, phone, phone_verified,
                   created_at AS registered_at`,
        [telegramId, data.fullName || data.username || "Telegram user", phone,
         data.username || null, data.firstName || null, data.lastName || null]
    );
    return result.rows[0];
}

async function touchBotUser(telegramId) {
    await pool.query("UPDATE chats SET last_activity_at=now() WHERE student_id=$1", [telegramId]);
}

async function recordAiUsage(data) {
    const user = await getBotUser(data.telegramId);
    if (!user || !user.phone_verified) throw new Error("USER_NOT_REGISTERED");
    const result = await pool.query(
        `INSERT INTO messages
            (chat_id, sender, text, created_at, message_type, request_id, model,
             route, status, prompt_tokens, candidate_tokens, thoughts_tokens,
             total_tokens, cached_tokens, duration_ms, error_type)
         VALUES ($1,'system','',COALESCE($2::timestamptz,now()),'ai_usage',$3,$4,$5,$6,
                 $7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [user.id, data.requestedAt || null, data.requestId, data.model, data.route || null,
         data.status, data.promptTokens ?? null, data.candidateTokens ?? null,
         data.thoughtsTokens ?? null, data.totalTokens ?? null,
         data.cachedTokens ?? null, data.durationMs, data.errorType || null]
    );
    await touchBotUser(data.telegramId);
    return {inserted: result.rowCount === 1};
}

async function addSupportEvent(telegramId, messageType, status) {
    const user = await getBotUser(telegramId);
    if (!user || !user.phone_verified) throw new Error("USER_NOT_REGISTERED");
    const result = await pool.query(
        `INSERT INTO messages(chat_id,sender,text,message_type,status)
         VALUES($1,'system','',$2,$3) RETURNING id`, [user.id, messageType, status]
    );
    await touchBotUser(telegramId);
    return result.rows[0];
}

async function openSupportRequest(telegramId) {
    const user = await getBotUser(telegramId);
    if (!user || !user.phone_verified) throw new Error("USER_NOT_REGISTERED");
    const existing = await pool.query(
        `SELECT opened.id
         FROM messages opened
         WHERE opened.chat_id=$1 AND opened.message_type='support_open'
           AND NOT EXISTS (
             SELECT 1 FROM messages closed
             WHERE closed.chat_id=opened.chat_id
               AND closed.message_type='support_closed'
               AND closed.created_at>=opened.created_at
           )
         ORDER BY opened.created_at DESC LIMIT 1`, [user.id]
    );
    if (existing.rows[0]) return existing.rows[0];
    return addSupportEvent(telegramId, "support_open", "waiting");
}

async function updateSupportRequest(telegramId, status) {
    const type = status === "active" ? "support_active" : "support_closed";
    return addSupportEvent(telegramId, type, status);
}

function periodParams(from, to) {
    if (!from || !to) throw new Error("INVALID_PERIOD");
    return [from, to];
}

async function getOverview(from, to) {
    const params = periodParams(from, to);
    const result = await pool.query(
        `SELECT
           (SELECT count(*) FROM chats WHERE phone_verified=true) AS registered_users,
           (SELECT count(*) FROM chats WHERE phone_verified=true AND created_at >= $1 AND created_at < $2) AS new_users,
           (SELECT count(DISTINCT chat_id) FROM messages WHERE created_at >= $1 AND created_at < $2 AND message_type IN ('ai_usage','support_open')) AS active_users,
           (SELECT count(DISTINCT chat_id) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2) AS ai_users,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2) AS ai_requests,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage' AND status='success' AND created_at >= $1 AND created_at < $2) AS successful_requests,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage' AND status<>'success' AND created_at >= $1 AND created_at < $2) AS failed_requests,
           COALESCE((SELECT sum(prompt_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS prompt_tokens,
           COALESCE((SELECT sum(candidate_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS candidate_tokens,
           COALESCE((SELECT sum(thoughts_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS thoughts_tokens,
           COALESCE((SELECT sum(cached_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS cached_tokens,
           COALESCE((SELECT sum(total_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS total_tokens,
           (SELECT avg(total_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2) AS avg_tokens,
           COALESCE((SELECT sum(duration_ms) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS total_duration_ms,
           (SELECT avg(duration_ms) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2) AS avg_duration_ms,
           (SELECT count(*) FROM messages WHERE message_type='support_open' AND created_at >= $1 AND created_at < $2) AS support_requests,
           (SELECT count(DISTINCT chat_id) FROM messages WHERE message_type='support_open' AND created_at >= $1 AND created_at < $2) AS support_users,
           (SELECT min(created_at) FROM messages WHERE message_type='ai_usage') AS tracking_started_at`, params
    );
    return result.rows[0];
}

async function getUserStats(from, to, search=null, limit=50, offset=0) {
    const value = search ? `%${String(search).toLowerCase()}%` : null;
    const result = await pool.query(
        `SELECT c.student_id AS telegram_id, c.student_name AS full_name, c.username,
                c.phone, c.created_at AS registered_at, c.last_activity_at,
                count(m.id) FILTER (WHERE m.message_type='ai_usage') AS ai_requests,
                count(m.id) FILTER (WHERE m.message_type='ai_usage' AND m.status='success') AS successful_requests,
                count(m.id) FILTER (WHERE m.message_type='ai_usage' AND m.status<>'success') AS failed_requests,
                COALESCE(sum(m.prompt_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS prompt_tokens,
                COALESCE(sum(m.candidate_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS candidate_tokens,
                COALESCE(sum(m.thoughts_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS thoughts_tokens,
                COALESCE(sum(m.total_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS total_tokens,
                COALESCE(sum(m.cached_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS cached_tokens,
                avg(m.duration_ms) FILTER (WHERE m.message_type='ai_usage') AS avg_duration_ms,
                min(m.created_at) FILTER (WHERE m.message_type='ai_usage') AS first_ai_at,
                max(m.created_at) FILTER (WHERE m.message_type='ai_usage') AS last_ai_at,
                count(m.id) FILTER (WHERE m.message_type='support_open') AS support_requests
         FROM chats c LEFT JOIN messages m ON m.chat_id=c.id AND m.created_at >= $1 AND m.created_at < $2
         WHERE c.phone_verified=true AND ($3::text IS NULL OR CAST(c.student_id AS text) ILIKE $3
               OR lower(COALESCE(c.username,'')) ILIKE $3 OR c.phone ILIKE $3)
         GROUP BY c.id ORDER BY c.last_activity_at DESC NULLS LAST
         LIMIT $4 OFFSET $5`, [from, to, value, Math.min(limit, 1000000), offset]
    );
    return result.rows;
}

async function getUsageRows(from, to, limit=1000000) {
    const result = await pool.query(
        `SELECT m.request_id, c.student_id AS telegram_id, m.created_at AS requested_at,
                m.model,m.status,m.prompt_tokens,m.candidate_tokens,m.thoughts_tokens,
                m.total_tokens,m.cached_tokens,m.duration_ms
         FROM messages m JOIN chats c ON c.id=m.chat_id
         WHERE m.message_type='ai_usage' AND m.created_at >= $1 AND m.created_at < $2
         ORDER BY m.created_at LIMIT $3`, [from, to, Math.min(limit, 1000000)]
    );
    return result.rows;
}

async function getSupportRows(from, to, limit=1000000) {
    const result = await pool.query(
        `SELECT open.id, c.student_id AS telegram_id, open.created_at AS opened_at,
                active.created_at AS operator_connected_at, closed.created_at AS closed_at,
                COALESCE(closed.status,active.status,open.status) AS status,
                CASE WHEN active.created_at IS NOT NULL THEN EXTRACT(EPOCH FROM (active.created_at-open.created_at)) END AS wait_seconds,
                CASE WHEN closed.created_at IS NOT NULL THEN EXTRACT(EPOCH FROM (closed.created_at-open.created_at)) END AS duration_seconds
         FROM messages open JOIN chats c ON c.id=open.chat_id
         LEFT JOIN LATERAL (SELECT created_at,status FROM messages WHERE chat_id=open.chat_id AND message_type='support_active' AND created_at>=open.created_at ORDER BY created_at LIMIT 1) active ON true
         LEFT JOIN LATERAL (SELECT created_at,status FROM messages WHERE chat_id=open.chat_id AND message_type='support_closed' AND created_at>=open.created_at ORDER BY created_at LIMIT 1) closed ON true
         WHERE open.message_type='support_open' AND open.created_at >= $1 AND open.created_at < $2
         ORDER BY open.created_at LIMIT $3`, [from, to, Math.min(limit, 1000000)]
    );
    return result.rows;
}

module.exports = {normalizePhone,getBotUser,registerBotUser,touchBotUser,recordAiUsage,
    openSupportRequest,updateSupportRequest,getOverview,getUserStats,getUsageRows,getSupportRows};
