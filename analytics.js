const pool = require("./db");

const PRICING = Object.freeze({
    input: finiteNumber(process.env.GEMINI_INPUT_USD_PER_MILLION, 0.30),
    cached: finiteNumber(process.env.GEMINI_CACHED_INPUT_USD_PER_MILLION, 0.03),
    output: finiteNumber(process.env.GEMINI_OUTPUT_USD_PER_MILLION, 2.50),
    search: finiteNumber(process.env.GEMINI_SEARCH_USD_PER_QUERY, 0.014),
});

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

let messageCapabilitiesPromise;
async function getMessageCapabilities() {
    if (!messageCapabilitiesPromise) {
        messageCapabilitiesPromise = pool.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name='messages'`
        ).then(result => new Set(result.rows.map(row => row.column_name)));
    }
    return messageCapabilitiesPromise;
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

async function claimAiRequest(data, limits) {
    const user = await getBotUser(data.telegramId);
    if (!user || !user.phone_verified) throw new Error("USER_NOT_REGISTERED");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(data.requestId || ""))) {
        throw new Error("INVALID_REQUEST_ID");
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(914230117)");
        await client.query(
            `UPDATE messages SET status='error', error_type='CLAIM_TIMEOUT'
             WHERE message_type='ai_usage' AND status='pending'
               AND created_at < now() - ($1::int * interval '1 second')`,
            [limits.pendingTimeoutSeconds]
        );
        const duplicate = await client.query(
            "SELECT status FROM messages WHERE request_id=$1 LIMIT 1", [data.requestId]
        );
        if (duplicate.rows[0]) {
            await client.query("COMMIT");
            return {claimed: false, reason: "duplicate", existingStatus: duplicate.rows[0].status};
        }

        const usage = await client.query(
            `SELECT
                count(*) FILTER (WHERE created_at >= now() - interval '1 minute') AS global_minute,
                count(*) FILTER (WHERE chat_id=$1 AND created_at >= now() - interval '1 minute') AS user_minute,
                count(*) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)) AS daily_requests,
                count(*) FILTER (WHERE status='pending' AND created_at >= now() - ($3::int * interval '1 second')) AS pending_count,
                COALESCE(sum(
                    CASE WHEN created_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)
                              AND status<>'pending'
                         THEN COALESCE(
                            NULLIF(to_jsonb(messages)->>'estimated_cost_usd','')::numeric,
                            (
                              GREATEST(COALESCE(prompt_tokens,0)-COALESCE(cached_tokens,0),0) * $4::numeric
                              + COALESCE(cached_tokens,0) * $5::numeric
                              + (COALESCE(candidate_tokens,0)+COALESCE(thoughts_tokens,0)) * $6::numeric
                            ) / 1000000.0
                            + CASE WHEN route='search' THEN $7::numeric ELSE 0 END
                         ) ELSE 0 END
                ),0) AS daily_cost
             FROM messages WHERE message_type='ai_usage'`,
            [user.id, limits.timezone, limits.pendingTimeoutSeconds,
             limits.inputRate, limits.cachedRate, limits.outputRate, limits.searchRate]
        );
        const counters = usage.rows[0];
        const dailyCost = finiteNumber(counters.daily_cost);
        const reservedCost = finiteNumber(counters.pending_count) * limits.pendingReserveUsd;
        let reason = null;
        if (finiteNumber(counters.user_minute) >= limits.perUserPerMinute) reason = "user_rate_limit";
        else if (finiteNumber(counters.global_minute) >= limits.globalPerMinute) reason = "global_rate_limit";
        else if (finiteNumber(counters.pending_count) >= limits.maxConcurrent) reason = "concurrency_limit";
        else if (finiteNumber(counters.daily_requests) >= limits.dailyRequestLimit) reason = "daily_request_limit";
        else if (dailyCost + reservedCost + limits.pendingReserveUsd > limits.dailyCostLimitUsd) reason = "daily_cost_limit";
        if (reason) {
            await client.query("COMMIT");
            return {
                claimed: false,
                reason,
                dailyCostUsd: dailyCost,
                dailyCostLimitUsd: limits.dailyCostLimitUsd,
            };
        }

        const capabilities = await getMessageCapabilities();
        const columns = ["chat_id", "sender", "text", "created_at", "message_type", "request_id", "model", "route", "status"];
        const values = [user.id, "system", "", data.requestedAt || new Date().toISOString(), "ai_usage", data.requestId,
            String(data.model || "").slice(0, 100), String(data.route || "chat").slice(0, 30), "pending"];
        for (const [column, value] of [
            ["source", String(data.source || "telegram").slice(0, 40)],
            ["telegram_message_id", data.telegramMessageId == null ? null : String(data.telegramMessageId)],
            ["retry_count", 0],
        ]) {
            if (capabilities.has(column)) {
                columns.push(column);
                values.push(value);
            }
        }
        const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
        const inserted = await client.query(
            `INSERT INTO messages (${columns.join(",")}) VALUES (${placeholders})
             ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING RETURNING id`,
            values
        );
        await client.query("COMMIT");
        return {claimed: inserted.rowCount === 1, reason: inserted.rowCount === 1 ? null : "duplicate",
            dailyCostUsd: dailyCost, dailyCostLimitUsd: limits.dailyCostLimitUsd};
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function recordAiUsage(data) {
    const user = await getBotUser(data.telegramId);
    if (!user || !user.phone_verified) throw new Error("USER_NOT_REGISTERED");
    const capabilities = await getMessageCapabilities();
    const optionalColumns = [
        ["source", data.source || "telegram"],
        ["telegram_message_id", data.telegramMessageId ?? null],
        ["retry_count", data.retryCount ?? 0],
        ["estimated_cost_usd", data.estimatedCostUsd ?? null],
        ["pricing_effective_date", data.pricingEffectiveDate || null],
        ["search_query_count", data.searchQueryCount ?? 0],
    ].filter(([column]) => capabilities.has(column));
    const columns = ["chat_id", "sender", "text", "created_at", "message_type", "request_id", "model",
        "route", "status", "prompt_tokens", "candidate_tokens", "thoughts_tokens", "total_tokens",
        "cached_tokens", "duration_ms", "error_type", ...optionalColumns.map(([column]) => column)];
    const values = [user.id, "system", "", data.requestedAt || new Date().toISOString(), "ai_usage",
        data.requestId, data.model, data.route || null, data.status, data.promptTokens ?? null,
        data.candidateTokens ?? null, data.thoughtsTokens ?? null, data.totalTokens ?? null,
        data.cachedTokens ?? null, data.durationMs, data.errorType || null,
        ...optionalColumns.map(([, value]) => value)];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
    const updates = columns.slice(6).map(column => `${column}=EXCLUDED.${column}`).join(",");
    const result = await pool.query(
        `INSERT INTO messages (${columns.join(",")}) VALUES (${placeholders})
         ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO UPDATE SET ${updates}
         RETURNING id`, values
    );
    await touchBotUser(data.telegramId);
    return {saved: result.rowCount === 1};
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
    const params = [...periodParams(from, to), PRICING.input, PRICING.cached, PRICING.output, PRICING.search];
    const result = await pool.query(
        `SELECT
           (SELECT count(*) FROM chats WHERE phone_verified=true) AS registered_users,
           (SELECT count(*) FROM chats WHERE phone_verified=true AND created_at >= $1 AND created_at < $2) AS new_users,
           (SELECT count(DISTINCT chat_id) FROM messages WHERE created_at >= $1 AND created_at < $2 AND (message_type='support_open' OR (message_type='ai_usage' AND status<>'pending'))) AS active_users,
           (SELECT count(DISTINCT chat_id) FROM messages WHERE message_type='ai_usage' AND status<>'pending' AND created_at >= $1 AND created_at < $2) AS ai_users,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage' AND status<>'pending' AND created_at >= $1 AND created_at < $2) AS ai_requests,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage' AND status='success' AND created_at >= $1 AND created_at < $2) AS successful_requests,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage' AND status NOT IN ('success','pending') AND created_at >= $1 AND created_at < $2) AS failed_requests,
           COALESCE((SELECT sum(prompt_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS prompt_tokens,
           COALESCE((SELECT sum(candidate_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS candidate_tokens,
           COALESCE((SELECT sum(thoughts_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS thoughts_tokens,
           COALESCE((SELECT sum(cached_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS cached_tokens,
           COALESCE((SELECT sum(total_tokens) FROM messages WHERE message_type='ai_usage' AND created_at >= $1 AND created_at < $2),0) AS total_tokens,
           COALESCE((SELECT sum(COALESCE(
                NULLIF(to_jsonb(messages)->>'estimated_cost_usd','')::numeric,
                (GREATEST(COALESCE(prompt_tokens,0)-COALESCE(cached_tokens,0),0)*$3::numeric
                 + COALESCE(cached_tokens,0)*$4::numeric
                 + (COALESCE(candidate_tokens,0)+COALESCE(thoughts_tokens,0))*$5::numeric)/1000000.0
                 + CASE WHEN route='search' THEN $6::numeric ELSE 0 END
              )) FROM messages WHERE message_type='ai_usage' AND status<>'pending'
                   AND created_at >= $1 AND created_at < $2),0) AS estimated_cost_usd,
           (SELECT avg(COALESCE(
                NULLIF(to_jsonb(messages)->>'estimated_cost_usd','')::numeric,
                (GREATEST(COALESCE(prompt_tokens,0)-COALESCE(cached_tokens,0),0)*$3::numeric
                 + COALESCE(cached_tokens,0)*$4::numeric
                 + (COALESCE(candidate_tokens,0)+COALESCE(thoughts_tokens,0))*$5::numeric)/1000000.0
                 + CASE WHEN route='search' THEN $6::numeric ELSE 0 END
              )) FROM messages WHERE message_type='ai_usage' AND status<>'pending'
                   AND created_at >= $1 AND created_at < $2) AS avg_estimated_cost_usd,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage'
                AND COALESCE(to_jsonb(messages)->>'source','unknown') NOT IN ('telegram','unknown')
                AND created_at >= $1 AND created_at < $2) AS non_user_requests,
           (SELECT count(*) FROM messages WHERE message_type='ai_usage'
                AND COALESCE(to_jsonb(messages)->>'source','unknown')='unknown'
                AND created_at >= $1 AND created_at < $2) AS unknown_source_requests,
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
                count(m.id) FILTER (WHERE m.message_type='ai_usage' AND m.status<>'pending') AS ai_requests,
                count(m.id) FILTER (WHERE m.message_type='ai_usage' AND m.status='success') AS successful_requests,
                count(m.id) FILTER (WHERE m.message_type='ai_usage' AND m.status NOT IN ('success','pending')) AS failed_requests,
                COALESCE(sum(m.prompt_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS prompt_tokens,
                COALESCE(sum(m.candidate_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS candidate_tokens,
                COALESCE(sum(m.thoughts_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS thoughts_tokens,
                COALESCE(sum(m.total_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS total_tokens,
                COALESCE(sum(m.cached_tokens) FILTER (WHERE m.message_type='ai_usage'),0) AS cached_tokens,
                COALESCE(sum(COALESCE(
                    NULLIF(to_jsonb(m)->>'estimated_cost_usd','')::numeric,
                    (GREATEST(COALESCE(m.prompt_tokens,0)-COALESCE(m.cached_tokens,0),0)*$6::numeric
                     + COALESCE(m.cached_tokens,0)*$7::numeric
                     + (COALESCE(m.candidate_tokens,0)+COALESCE(m.thoughts_tokens,0))*$8::numeric)/1000000.0
                     + CASE WHEN m.route='search' THEN $9::numeric ELSE 0 END
                )) FILTER (WHERE m.message_type='ai_usage' AND m.status<>'pending'),0) AS estimated_cost_usd,
                avg(m.duration_ms) FILTER (WHERE m.message_type='ai_usage') AS avg_duration_ms,
                min(m.created_at) FILTER (WHERE m.message_type='ai_usage') AS first_ai_at,
                max(m.created_at) FILTER (WHERE m.message_type='ai_usage') AS last_ai_at,
                count(m.id) FILTER (WHERE m.message_type='support_open') AS support_requests
         FROM chats c LEFT JOIN messages m ON m.chat_id=c.id AND m.created_at >= $1 AND m.created_at < $2
         WHERE c.phone_verified=true AND ($3::text IS NULL OR CAST(c.student_id AS text) ILIKE $3
               OR lower(COALESCE(c.username,'')) ILIKE $3 OR c.phone ILIKE $3)
         GROUP BY c.id ORDER BY estimated_cost_usd DESC, c.last_activity_at DESC NULLS LAST
         LIMIT $4 OFFSET $5`, [from, to, value, Math.min(limit, 1000000), offset,
            PRICING.input, PRICING.cached, PRICING.output, PRICING.search]
    );
    return result.rows;
}

async function getUsageRows(from, to, limit=1000000) {
    const result = await pool.query(
        `SELECT m.request_id, c.student_id AS telegram_id, m.created_at AS requested_at,
                m.model,m.status,m.prompt_tokens,m.candidate_tokens,m.thoughts_tokens,
                m.total_tokens,m.cached_tokens,m.duration_ms,
                to_jsonb(m)->>'source' AS source,
                to_jsonb(m)->>'telegram_message_id' AS telegram_message_id,
                COALESCE(NULLIF(to_jsonb(m)->>'retry_count','')::integer,0) AS retry_count,
                NULLIF(to_jsonb(m)->>'estimated_cost_usd','')::numeric AS estimated_cost_usd,
                NULLIF(to_jsonb(m)->>'search_query_count','')::integer AS search_query_count,
                to_jsonb(m)->>'pricing_effective_date' AS pricing_effective_date
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

module.exports = {normalizePhone,getBotUser,registerBotUser,touchBotUser,claimAiRequest,recordAiUsage,
    openSupportRequest,updateSupportRequest,getOverview,getUserStats,getUsageRows,getSupportRows};
