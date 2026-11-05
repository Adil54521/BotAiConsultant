require("dotenv").config({ path: "config.env" });
require("dotenv").config({
    path: ".env"
});

const route = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 8004;
const Busboy = require("busboy");
const fs = require("fs");
const WebSocket = require("ws");
const path = require("path");
const pool = require("./db");
const {resolveInternalToken, isInternalAuthorized: verifyInternalRequest} = require("./internal_auth");
const {logSafeError} = require("./backend_diagnostics");
const {AnalyticsValidationError, normalizeAnalyticsRequest} = require("./admin_analytics");
const { PDFParse } = require("pdf-parse");
const { createEmbedding } = require("./gemini");
const {
    getBotUser,
    registerBotUser,
    touchBotUser,
    claimAiRequest,
    recordAiUsage,
    openSupportRequest,
    updateSupportRequest,
    getOverview,
    getUserStats,
    getUsageRows,
    getSupportRows
} = require("./analytics");

const internalAuth = resolveInternalToken(process.env.INTERNAL_API_TOKEN, process.env.JWT_SECRET);
const INTERNAL_API_TOKEN = internalAuth.token;
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || "").trim();
const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();
console.log(`INTERNAL_AUTH_CONFIG scheme=${internalAuth.scheme} secret_present=${Boolean(INTERNAL_API_TOKEN)}`);
console.log(`SESSION_AUTH_CONFIG secret_present=${Boolean(JWT_SECRET)}`);

function envNumber(name, fallback, minimum, maximum) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
}

const AI_LIMITS = Object.freeze({
    timezone: process.env.APP_TIMEZONE || "Asia/Qyzylorda",
    perUserPerMinute: envNumber("AI_PER_USER_REQUESTS_PER_MINUTE", 4, 1, 60),
    globalPerMinute: envNumber("AI_GLOBAL_REQUESTS_PER_MINUTE", 20, 1, 1000),
    maxConcurrent: envNumber("AI_MAX_CONCURRENT_REQUESTS", 3, 1, 100),
    dailyRequestLimit: envNumber("AI_DAILY_REQUEST_LIMIT", 100, 1, 1000000),
    dailyCostLimitUsd: envNumber("AI_DAILY_COST_LIMIT_USD", 5, 0.01, 1000000),
    pendingReserveUsd: envNumber("AI_PENDING_RESERVE_USD", 0.02, 0.0001, 1000),
    pendingTimeoutSeconds: envNumber("AI_PENDING_TIMEOUT_SECONDS", 180, 30, 3600),
    inputRate: envNumber("GEMINI_INPUT_USD_PER_MILLION", 0.30, 0, 1000),
    cachedRate: envNumber("GEMINI_CACHED_INPUT_USD_PER_MILLION", 0.03, 0, 1000),
    outputRate: envNumber("GEMINI_OUTPUT_USD_PER_MILLION", 2.50, 0, 1000),
    searchRate: envNumber("GEMINI_SEARCH_USD_PER_QUERY", 0.014, 0, 100),
});
console.log(`AI_COST_GUARD daily_limit_usd=${AI_LIMITS.dailyCostLimitUsd} daily_requests=${AI_LIMITS.dailyRequestLimit} global_rpm=${AI_LIMITS.globalPerMinute} user_rpm=${AI_LIMITS.perUserPerMinute} max_concurrent=${AI_LIMITS.maxConcurrent}`);

function isInternalAuthorized(req) {
    return verifyInternalRequest(req, INTERNAL_API_TOKEN);
}

function sessionPayload(req) {
    if (!JWT_SECRET) return null;
    const cookies = String(req.headers.cookie || "");
    const token = cookies.split("; ").find(value => value.startsWith("accessToken="))?.slice("accessToken=".length);
    if (!token) return null;
    try { return jwt.verify(token, JWT_SECRET); }
    catch { return null; }
}

function isAdminSession(req) {
    return sessionPayload(req)?.role === "admin";
}

const BOT_LEASE_LOCK = 914230118;
const BOT_LEASE_TTL_MS = envNumber("BOT_INSTANCE_LEASE_TTL_SECONDS", 90, 30, 600) * 1000;
let botLease = null;

async function releaseBotLease() {
    if (!botLease) return;
    const lease = botLease;
    botLease = null;
    try { await lease.client.query("SELECT pg_advisory_unlock($1)", [BOT_LEASE_LOCK]); }
    finally { lease.client.release(); }
}

async function updateBotLease(instanceId, action) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(instanceId)) throw new Error("INVALID_INSTANCE_ID");
    if (action === "release") {
        if (botLease?.instanceId === instanceId) await releaseBotLease();
        return {acquired: true, released: true};
    }
    if (botLease && Date.now() - botLease.lastSeen > BOT_LEASE_TTL_MS) await releaseBotLease();
    if (botLease) {
        if (botLease.instanceId === instanceId) {
            botLease.lastSeen = Date.now();
            return {acquired: true};
        }
        return {acquired: false, reason: "another_instance_active"};
    }
    const client = await pool.connect();
    try {
        const result = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [BOT_LEASE_LOCK]);
        if (!result.rows[0]?.acquired) {
            client.release();
            return {acquired: false, reason: "another_instance_active"};
        }
        botLease = {instanceId, client, lastSeen: Date.now()};
        return {acquired: true};
    } catch (error) {
        client.release();
        throw error;
    }
}

function requestIdFor(req) {
    const supplied = String(req.headers["x-request-id"] || "");
    return /^[A-Za-z0-9_-]{8,64}$/.test(supplied) ? supplied : crypto.randomUUID();
}

async function logDatabaseIdentity() {
    try {
        const identity = await pool.query(`
            SELECT current_database() AS database,
                   current_schema() AS schema,
                   current_user AS db_user,
                   COALESCE(inet_server_addr()::text, 'local') AS server_address,
                   inet_server_port() AS server_port,
                   current_setting('search_path') AS search_path,
                   current_setting('server_version') AS server_version
        `);
        const sequence = await pool.query(`
            SELECT to_regclass('public.chats_id_seq')::text AS sequence_name,
                   COALESCE((SELECT max(id) FROM public.chats), 0) AS max_chat_id,
                   CASE WHEN to_regclass('public.chats_id_seq') IS NOT NULL
                        THEN (SELECT last_value FROM public.chats_id_seq)
                   END AS sequence_last_value,
                   CASE WHEN to_regclass('public.chats_id_seq') IS NOT NULL
                        THEN (SELECT is_called FROM public.chats_id_seq)
                   END AS sequence_is_called
        `);
        console.log("DATABASE_IDENTITY", JSON.stringify(identity.rows[0]));
        console.log("DATABASE_SEQUENCE_STATE", JSON.stringify(sequence.rows[0]));
    } catch (error) {
        logSafeError("database_identity", error, "startup", "database_diagnostics");
    }
}

function readJsonBody(req, maxBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > maxBytes) reject(new Error("BODY_TOO_LARGE"));
        });
        req.on("end", () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (error) { reject(new Error("INVALID_JSON")); }
        });
        req.on("error", reject);
    });
}

async function extractPdfText(filePath) {
    const data = await fs.promises.readFile(filePath);
    const parser = new PDFParse({
        data
    });

    const result = await parser.getText();

    return result.text;
}

function splitText(text, chunkSize = 1000, overlap = 200) {
    const chunks = [];

    let start = 0;

    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);

        chunks.push(text.slice(start, end));

        start += chunkSize - overlap;
    }

    return chunks;
}

const {
    register,
    login,
    getUserById,
    updateUser,
    checkRegistration,
    getUncheckedUsers
} = require('./auth/auth');

const {
    getOrCreateChat,
    saveMessage,
    getChats,
    getMessages,
    deleteChat,
    setConsultantMode,
    isConsultantMode,
    getUnsentEmployeeMessages,
    markMessagesAsSentToBot,
    saveDocument,
    saveChunk,
    updateEmbedding,
    searchChunks,
    getDocuments,
    deleteDocument,
    getAIConversations,
    getAIConversationMessages,
    getAIConversationByTelegramId,
    createAIConversation,
    saveAIMessage,
    updateAIConversation

} = require("./chat");


const MAX_SIZE = envNumber("AI_DOCUMENT_MAX_BYTES", 20 * 1024 * 1024, 1024, 50 * 1024 * 1024);
const server = route.createServer(async (req, res) => {
    const requestId = requestIdFor(req);
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    console.log(`HTTP_REQUEST method=${req.method} path=${requestUrl.pathname} request_id=${requestId}`);
    const normalizedPath = requestUrl.pathname.replace(/\/+$/, "") || "/";
    const internalPath = normalizedPath.startsWith("/api/internal/")
        ? normalizedPath.slice(4)
        : normalizedPath;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', 'https://undercook-habitable-disposal.ngrok-free.dev');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Internal-Token, X-Request-ID'
    );
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Request-ID", requestId);
    res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
    );

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (internalPath.startsWith("/internal/") && !isInternalAuthorized(req)) {
        res.writeHead(403, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: "Forbidden"}));
        return;
    }

    if (req.method === "GET" && internalPath === "/internal/health") {
        res.end(JSON.stringify({
            service: "bot-backend",
            apiVersion: 2,
            schemaTarget: "chats-messages-v1"
        }));
        return;
    }

    if (req.method === "POST" && internalPath === "/internal/bot-instance/lease") {
        try {
            const data = await readJsonBody(req, 10_000);
            const lease = await updateBotLease(String(data.instanceId || ""), data.action === "release" ? "release" : "acquire");
            res.writeHead(lease.acquired ? 200 : 409);
            res.end(JSON.stringify({success: lease.acquired, ...lease}));
        } catch (error) {
            logSafeError("bot_instance_lease", error, requestId, "lease");
            res.writeHead(error.message === "INVALID_INSTANCE_ID" ? 400 : 500);
            res.end(JSON.stringify({success: false}));
        }
        return;
    }

    if (req.method === "GET" && internalPath === "/internal/bot-user") {
        try {
            const user = await getBotUser(requestUrl.searchParams.get("telegramId"));
            res.end(JSON.stringify({registered: Boolean(user && user.phone_verified), user}));
        } catch (error) {
            console.error(`BOT_USER_LOOKUP_ERROR type=${error.constructor.name}`);
            res.writeHead(500);
            res.end(JSON.stringify({error: "Server error"}));
        }
        return;
    }

    if (req.method === "POST" && internalPath === "/internal/bot-user/register") {
        let stage = "read_json";
        try {
            const data = await readJsonBody(req);
            stage = "register_bot_user";
            const user = await registerBotUser(data);
            res.end(JSON.stringify({success: true, user}));
        } catch (error) {
            const invalid = ["INVALID_PHONE", "INVALID_TELEGRAM_ID"].includes(error.message);
            logSafeError("bot_user_register", error, requestId, stage);
            res.writeHead(invalid ? 400 : 500);
            res.end(JSON.stringify({success: false, error: invalid ? "Invalid registration data" : "Server error"}));
        }
        return;
    }

    if (req.method === "POST" && internalPath === "/internal/ai/usage") {
        try {
            const result = await recordAiUsage(await readJsonBody(req));
            res.end(JSON.stringify({success: true, ...result}));
        } catch (error) {
            console.error(`AI_USAGE_SAVE_ERROR type=${error.constructor.name}`);
            res.writeHead(error.message === "USER_NOT_REGISTERED" ? 403 : 500);
            res.end(JSON.stringify({success: false}));
        }
        return;
    }

    if (req.method === "POST" && internalPath === "/internal/ai/claim") {
        try {
            const result = await claimAiRequest(await readJsonBody(req, 20_000), AI_LIMITS);
            res.writeHead(result.claimed ? 200 : (result.reason === "duplicate" ? 409 : 429));
            res.end(JSON.stringify({success: result.claimed, ...result}));
        } catch (error) {
            logSafeError("ai_request_claim", error, requestId, "claim");
            const status = error.message === "USER_NOT_REGISTERED" ? 403
                : error.message === "INVALID_REQUEST_ID" ? 400 : 500;
            res.writeHead(status);
            res.end(JSON.stringify({success: false}));
        }
        return;
    }

    if (req.method === "POST" && internalPath === "/internal/support/request") {
        try {
            const data = await readJsonBody(req);
            const result = data.action === "open"
                ? await openSupportRequest(data.telegramId)
                : await updateSupportRequest(data.telegramId, data.status);
            res.end(JSON.stringify({success: true, request: result}));
        } catch (error) {
            console.error(`SUPPORT_USAGE_ERROR type=${error.constructor.name}`);
            res.writeHead(error.message === "USER_NOT_REGISTERED" ? 403 : 500);
            res.end(JSON.stringify({success: false}));
        }
        return;
    }

    if (req.method === "POST" && internalPath === "/internal/admin/analytics") {
        let stage = "read_json";
        try {
            const data = await readJsonBody(req);
            stage = "authorize_admin";
            if (!/^[1-9]\d*$/.test(ADMIN_TELEGRAM_ID)
                || String(data.adminTelegramId || "") !== ADMIN_TELEGRAM_ID) {
                const error = new Error("ADMIN_ACCESS_DENIED");
                error.code = "ADMIN_ACCESS_DENIED";
                error.parameter = "adminTelegramId";
                throw error;
            }
            stage = "validate_request";
            const request = normalizeAnalyticsRequest(data);
            stage = `query_${request.action}`;
            let result;
            if (request.action === "overview") result = await getOverview(request.from, request.to);
            else if (request.action === "users") result = await getUserStats(
                request.from, request.to, request.search, request.limit, request.offset
            );
            else if (request.action === "report") result = {
                overview: await getOverview(request.from, request.to),
                users: await getUserStats(request.from, request.to, null, 200000, 0),
                usage: await getUsageRows(request.from, request.to),
                support: await getSupportRows(request.from, request.to)
            };
            res.end(JSON.stringify({success: true, data: result}));
        } catch (error) {
            logSafeError("admin_analytics", error, requestId, stage);
            if (error.code === "ADMIN_ACCESS_DENIED") {
                res.writeHead(403);
                res.end(JSON.stringify({success: false, error: "Forbidden"}));
            } else if (error instanceof AnalyticsValidationError
                       || ["INVALID_JSON", "BODY_TOO_LARGE"].includes(error.message)) {
                res.writeHead(400);
                res.end(JSON.stringify({success: false, error: "Invalid request"}));
            } else {
                res.writeHead(500);
                res.end(JSON.stringify({success: false, error: "Server error"}));
            }
        }
        return;
    }

    if (req.url === '/register') {
        let parse = '';
        res.statusCode = 200;
        req.on('data', chunk => {
            parse = chunk.toString();
        });
        req.on('end', async () => {
            try {
                const body = parse ? JSON.parse (parse): {};
                if (!body.name || !body.mail || !body.password) {
                    res.statusCode = 400;
                    return res.end(JSON.stringify({
                        message: "Заполните все поля!"
                    }));
                }
                await register(
                    body.name,
                    body.mail,
                    body.password,
                );

                res.end(JSON.stringify({message: "Вы зарегистрированы !"}));
            } catch (err) {
                console.error(51, err);

                res.statusCode = 500;
                res.end(JSON.stringify({
                    message: "Пользователь с таким именем уже существует"
                }));
            }
        });
        return;
    }

    if (req.url === "/checkRegistration" && req.method === "POST") {
        let parse = "";

        req.on("data", chunk => {
            parse += chunk;
        });

        req.on("end", async () => {
            try {
                const cookies = req.headers.cookie || "";

                const token = cookies
                    .split("; ")
                    .find(c => c.startsWith("accessToken="))
                    ?.split("=")[1];

                if (!token) {
                    res.statusCode = 401;
                    return res.end(JSON.stringify({
                        message: "Нет токена"
                    }));
                }

                const payload = jwt.verify(token, JWT_SECRET);

                if (payload.role !== "admin") {
                    res.statusCode = 403;
                    return res.end(JSON.stringify({
                        message: "Доступ запрещен"
                    }));
                }

                const body = parse ? JSON.parse(parse) : {};

                await checkRegistration(body.id);

                res.end(JSON.stringify({
                    message: "Пользователь подтвержден."
                }));

            } catch (error) {
                console.error(error);

                res.statusCode = 500;
                res.end(JSON.stringify({
                    message: "Ошибка сервера"
                }));
            }
        });

        return;
    }

    if (req.url === "/login" && req.method === "POST") {
        let parse = "";

        req.on("data", chunk => {
            parse += chunk;
        });

        req.on("end", async () => {
            try {
                const body = JSON.parse(parse);

                const user = await login(
                    body.login,
                    body.passwordd
                );

                if (!user) {
                    res.statusCode = 401;

                    return res.end(JSON.stringify({
                        message: "Неверный логин или пароль"
                    }));
                }

                if (!user.checked) {
                    res.statusCode = 403;

                    return res.end(JSON.stringify({
                        message: "Ваш аккаунт еще не подтвержден администратором."
                    }));
                }

                const token = jwt.sign(
                    {
                        userId: user.id,
                        role: user.role
                    },
                    JWT_SECRET,
                    {
                        expiresIn: "7d"
                    }
                );

                res.setHeader(
                    "Set-Cookie",
                    `accessToken=${token}; HttpOnly; Path=/`
                );

                res.end(JSON.stringify({
                    message: "Вход выполнен"
                }));

            } catch (err) {
                console.error(err);

                res.statusCode = 500;

                res.end(JSON.stringify({
                    message: "Ошибка сервера"
                }));
            }
        });

        return;
    }

    if (req.url === "/getUncheckedUsers" && req.method === "GET") {
        try {
            const cookies = req.headers.cookie || "";

            const token = cookies
                .split("; ")
                .find(c => c.startsWith("accessToken="))
                ?.split("=")[1];

            if (!token) {
                res.statusCode = 401;
                return res.end(JSON.stringify({
                    message: "Нет токена"
                }));
            }

            const payload = jwt.verify(token, JWT_SECRET);

            if (payload.role !== "admin") {
                res.statusCode = 403;
                return res.end(JSON.stringify({
                    message: "Доступ запрещен"
                }));
            }

            const users = await getUncheckedUsers();

            res.end(JSON.stringify(users));

        } catch (err) {
            console.error(err);
            res.statusCode = 500;
            res.end();
        }

        return;
    }

    if (req.url === "/profile" && req.method === "GET") {
        try {
            const cookies = req.headers.cookie || "";

            const token = cookies
                .split("; ")
                .find(c => c.startsWith("accessToken="))
                ?.split("=")[1];

            if (!token) {
                res.statusCode = 401;

                return res.end(JSON.stringify({
                    message: "Нет токена"
                }));
            }

            const payload = jwt.verify(
                token,
                JWT_SECRET
            );

            const user = await getUserById(
                payload.userId
            );

            if (!user) {
                res.statusCode = 404;

                return res.end(JSON.stringify({
                    message: "Пользователь не найден"
                }));
            }

            res.setHeader(
                "Content-Type",
                "application/json"
            );

            res.end(JSON.stringify({
                id: user.id,
                login: user.login,
                email: user.email,
                role: user.role,
                created_at: user.created_at
            }));

        } catch (err) {
            console.error(err);

            res.statusCode = 401;

            res.end(JSON.stringify({
                message: "Недействительный токен"
            }));
        }

        return;
    }

    if (req.url === '/profile' && req.method === 'PUT') {
        let parse = '';

        req.on('data', chunk => {
            parse += chunk;
        });

        req.on('end', async () => {
            try {
                const cookies = req.headers.cookie || '';

                const token = cookies
                    .split('; ')
                    .find(c => c.startsWith('accessToken='))
                    ?.split('=')[1];

                if (!token) {
                    res.statusCode = 401;

                    return res.end(JSON.stringify({
                        message: 'Нет токена'
                    }));
                }

                const payload = jwt.verify(
                    token,
                    JWT_SECRET
                );

                const body = JSON.parse(parse);

                if (!body.login || !body.email) {
                    res.statusCode = 400;

                    return res.end(JSON.stringify({
                        message: 'Заполните все поля'
                    }));
                }

                const emailRegex =
                    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (!emailRegex.test(body.email)) {
                    res.statusCode = 400;

                    return res.end(JSON.stringify({
                        message: 'Некорректный email'
                    }));
                }

                await updateUser(
                    payload.userId,
                    body.login,
                    body.email
                );

                res.end(JSON.stringify({
                    message: 'Данные успешно обновлены'
                }));

            } catch (err) {
                console.error(err);

                res.statusCode = 500;

                res.end(JSON.stringify({
                    message: 'Ошибка сервера'
                }));
            }
        });

        return;
    }

    if (req.url === "/message" && req.method === "POST") {

        if (!isInternalAuthorized(req)) {
            res.writeHead(403, {"Content-Type": "application/json"});
            res.end(JSON.stringify({error: "Forbidden"}));
            return;
        }

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", async () => {

            const message = JSON.parse(body);

            const registeredUser = await getBotUser(message.studentId);
            if (!registeredUser || !registeredUser.phone_verified) {
                res.writeHead(403, {"Content-Type": "application/json"});
                res.end(JSON.stringify({message: "Registration required"}));
                return;
            }

            // Получаем существующий чат или создаем новый
            const chatId = await getOrCreateChat(
                message.studentId,
                message.studentName,
                message.phone
            );

            // Сохраняем сообщение
            await saveMessage(
                chatId,
                "student",
                message.text
            );

            // Отправляем сообщение сотрудникам
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: "new_message",
                        chatId: chatId,
                        studentId: message.studentId,
                        phone: message.phone,
                        studentName: message.studentName,
                        text: message.text
                    }));
                }
            });

            res.writeHead(202, {
                "Content-Type": "application/json; charset=utf-8"
            });
            res.end(JSON.stringify({
                accepted: true,
                chatId
            }));

        });

        return;
    }

    if (req.url.startsWith("/message?") && req.method === "GET") {

        try {

            const url = new URL(req.url, "http://127.0.0.1:8004");

            const chatId = url.searchParams.get("chatId");

            const messages = await getMessages(chatId);

            res.setHeader(
                "Content-Type",
                "application/json"
            );

            res.end(JSON.stringify(messages));

        } catch (err) {

            console.error(err);

            res.statusCode = 500;

            res.end(JSON.stringify({
                message: "Ошибка сервера"
            }));

        }

        return;
    }

    if (req.url === "/chat" && req.method === "GET") {

        try {

            const chats = await getChats();

            res.setHeader(
                "Content-Type",
                "application/json"
            );

            res.end(JSON.stringify(chats));

        } catch (err) {

            console.error(err);

            res.statusCode = 500;

            res.end(JSON.stringify({
                message: "Ошибка сервера"
            }));

        }

        return;
    }

    if (req.url.startsWith("/chat/") && req.method === "DELETE") {
        try {
            const chatId = req.url.split("/")[2];

            await deleteChat(chatId);

            res.end(JSON.stringify({
                message: "Чат удален"
            }));

        } catch (err) {

            console.error(err);

            res.statusCode = 500;

            res.end(JSON.stringify({
                message: "Ошибка сервера"
            }));

        }

        return;
    }

    if (req.url === "/send-message" && req.method === "POST") {

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", async () => {

            const data = JSON.parse(body);

            // Получаем информацию о чате
            const chats = await getChats();

            const chat = chats.find(c => c.id == data.chatId);

            // Сохраняем сообщение сотрудника
            const savedMessage = await saveMessage(
                data.chatId,
                "employee",
                data.text
            );

            const active = await isConsultantMode(chat.student_id);
            console.log("ACTIVE:", active);

            if (active) {
                if (botClients.size === 0) {
                    console.log("Bot not connected");
                } else {
                    botClients.forEach(bot => {
                        if (bot.readyState === WebSocket.OPEN) {
                            bot.send(JSON.stringify({
                                type: "employee_message",
                                telegramId: chat.student_id,
                                chatId: data.chatId,
                                text: data.text
                            }));
                        }
                    });

                    await markMessagesAsSentToBot([savedMessage.id]);
                }
            }

            // Обновляем страницу сотрудника
            wss.clients.forEach(client => {
                if (
                    !botClients.has(client) &&
                    client.readyState === WebSocket.OPEN
                ) {
                    client.send(JSON.stringify({
                        type: "employee_message",
                        chatId: data.chatId,
                        text: data.text
                    }));
                }
            });

            res.end("ok");

        });

        return;
    }

    if (req.url === "/consultant-mode" && req.method === "POST") {

        if (!isInternalAuthorized(req)) {
            res.writeHead(403, {"Content-Type": "application/json"});
            res.end(JSON.stringify({error: "Forbidden"}));
            return;
        }

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", async () => {
            try {
                const data = JSON.parse(body);

                const registeredUser = await getBotUser(data.studentId);
                if (!registeredUser || !registeredUser.phone_verified) {
                    res.writeHead(403, {"Content-Type": "application/json"});
                    res.end(JSON.stringify({message: "Registration required"}));
                    return;
                }

                const enabled = data.enabled === true;

                await setConsultantMode(
                    data.studentId,
                    enabled
                );

                if (enabled === true) {
                    const chats = await getChats();

                    const chat = chats.find(c => String(c.student_id) === String(data.studentId));

                    if (chat) {
                        const unsentMessages = await getUnsentEmployeeMessages(chat.id);

                        if (unsentMessages.length > 0) {
                            botClients.forEach(bot => {
                                if (bot.readyState === WebSocket.OPEN) {
                                    unsentMessages.forEach(message => {
                                        bot.send(JSON.stringify({
                                            type: "employee_message",
                                            telegramId: chat.student_id,
                                            chatId: chat.id,
                                            text: message.text
                                        }));
                                    });
                                }
                            });

                            await markMessagesAsSentToBot(
                                unsentMessages.map(message => message.id)
                            );
                        }
                    }
                }

                wss.clients.forEach(client => {
                    if (
                        !botClients.has(client) &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify({
                            type: "consultant_mode_changed",
                            studentId: data.studentId,
                            enabled: enabled
                        }));
                    }
                });

                res.setHeader("Content-Type", "application/json");

                res.end(JSON.stringify({
                    message: "Статус обновлён",
                    studentId: data.studentId,
                    enabled: enabled
                }));

            } catch (err) {
                console.error(err);

                res.statusCode = 500;

                res.end(JSON.stringify({
                    message: "Ошибка сервера"
                }));
            }
        });

        return;
    }

    if (req.url.startsWith("/consultant-mode?") && req.method === "GET") {
        try {
            const url = new URL(req.url, "http://127.0.0.1:8004");
            const studentId = url.searchParams.get("studentId");

            const enabled = await isConsultantMode(studentId);

            res.setHeader("Content-Type", "application/json");

            res.end(JSON.stringify({
                studentId,
                enabled
            }));
        } catch (err) {
            console.error(err);

            res.statusCode = 500;

            res.end(JSON.stringify({
                message: "Ошибка сервера"
            }));
        }

        return;
    }

    if (req.url === "/ai" && req.method === "POST") {
        if (!isAdminSession(req)) {
            res.writeHead(403, {"Content-Type": "application/json"});
            res.end(JSON.stringify({message: "Forbidden"}));
            return;
        }
        const busboy = Busboy({
            headers: req.headers,
            limits: {
                fileSize: MAX_SIZE,
                files: 1,
                fields: 5,
                parts: 6,
            }
        });

        busboy.on("file", (fieldname, file, info) => {
            const filename = path.basename(info.filename || "document.pdf");

            const saveTo = path.join(__dirname, "storage", filename);

            const writeStream = fs.createWriteStream(saveTo);

            file.pipe(writeStream);

            writeStream.on("finish", async () => {
                try {
                    await processDocument(filename, saveTo);
                } catch (err) {
                    console.error(err);
                }
            });
        });

        busboy.on("finish", async () => {
            res.writeHead(200, {
                "Content-Type": "application/json"
            });

            res.end(JSON.stringify({
                message: "Файлы успешно загружены"
            }));
        });

        busboy.on("error", err => {
            console.error(err);

            res.writeHead(500);
            res.end("Upload error");
        });

        busboy.on("filesLimit", () => {
            res.writeHead(413);
            res.end("Too many files");
        });

        busboy.on("partsLimit", () => {
            res.writeHead(413);
            res.end("Too many parts");
        });

        req.pipe(busboy);

        return;
    }

    if (req.url === "/search" && req.method === "POST") {
        if (!isInternalAuthorized(req)) {
            res.writeHead(403, {"Content-Type": "application/json"});
            res.end(JSON.stringify({message: "Forbidden"}));
            return;
        }
        try {
            const {question, limit = 3} = await readJsonBody(req, 20_000);
            if (typeof question !== "string" || !question.trim() || question.length > 4096) {
                res.writeHead(400, {"Content-Type": "application/json"});
                res.end(JSON.stringify({message: "Invalid question"}));
                return;
            }
            const safeLimit = Math.min(Math.max(Number(limit) || 3, 1), 5);
            const chunks = await searchChunks(question.trim(), safeLimit);
            const context = chunks.map(chunk => chunk.text).join("\n\n");
            res.end(JSON.stringify({context, chunks}));
        } catch (err) {
            const errorType = err && err.constructor ? err.constructor.name : "Error";
            const errorCode = err && err.code ? String(err.code).slice(0, 40) : "unknown";
            console.error(`SEARCH_ERROR request_id=${requestId} type=${errorType} code=${errorCode}`);
            const invalid = ["INVALID_JSON", "BODY_TOO_LARGE", "INVALID_EMBEDDING_INPUT"].includes(err.message);
            res.writeHead(invalid ? 400 : (String(err.code || "").includes("LIMIT") ? 429 : 500), {
                "Content-Type": "application/json"
            });
            res.end(JSON.stringify({message: invalid ? "Invalid request" : "Search unavailable"}));
        }
        return;
    }

    if (req.url === "/documents" && req.method === "GET") {

        const documents = await getDocuments();

        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify(documents));

        return;
    }

    if (req.method === "DELETE" && req.url.startsWith("/documents/")) {

        const id = Number(req.url.split("/").pop());

        await deleteDocument(id);

        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            success: true
        }));

        return;
    }

    if (req.method === "GET" && req.url === "/ai/conversations") {

        try {

            const chats = await getAIConversations();

            res.writeHead(200, {
                "Content-Type":"application/json"
            });

            res.end(JSON.stringify(chats));

        }

        catch(err){

            console.error(err);

            res.writeHead(500);

            res.end(JSON.stringify({
                message:"Server error"
            }));

        }

        return;
    }

    if (req.method === "GET" && req.url.startsWith("/ai/conversations/")) {

        const parts = req.url.split("/");

        const id = parts[3];
        console.log(15, id);
        console.log(16, parts);
        if (!id) {

            res.writeHead(400);

            res.end();

            return;
        }

        try{

            const messages = await getAIConversationMessages(id);

            res.writeHead(200,{
                "Content-Type":"application/json"
            });

            res.end(JSON.stringify(messages));

        }

        catch(err){

            console.error(err);

            res.writeHead(500);

            res.end(JSON.stringify({
                message:"Server error"
            }));

        }

        return;
    }

    if (req.method === "POST" && req.url === "/ai/message") {

        if (!isInternalAuthorized(req)) {
            res.writeHead(403, {"Content-Type": "application/json"});
            res.end(JSON.stringify({error: "Forbidden"}));
            return;
        }

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", async () => {

            try {

                const {
                    telegramId,
                    username,
                    fullName,
                    phone,
                    userMessage,
                    assistantMessage
                } = JSON.parse(body);

                const registeredUser = await getBotUser(telegramId);
                if (!registeredUser || !registeredUser.phone_verified) {
                    res.writeHead(403, {"Content-Type": "application/json"});
                    res.end(JSON.stringify({success: false, message: "Registration required"}));
                    return;
                }

                let conversation = await getAIConversationByTelegramId(telegramId);

                if (!conversation) {

                    conversation = await createAIConversation(
                        telegramId,
                        username,
                        fullName,
                        phone
                    );

                }

                await saveAIMessage(
                    conversation.id,
                    "user",
                    userMessage
                );

                await saveAIMessage(
                    conversation.id,
                    "assistant",
                    assistantMessage
                );

                await updateAIConversation(conversation.id);

                res.writeHead(200, {
                    "Content-Type": "application/json"
                });

                res.end(JSON.stringify({
                    success: true
                }));

            } catch (err) {

                console.error(err);

                res.writeHead(500, {
                    "Content-Type": "application/json"
                });

                res.end(JSON.stringify({
                    success: false,
                    message: "Server error"
                }));

            }

        });

        return;
    }

    if (req.method === "POST" && req.url === "/logout") {

        res.writeHead(200, {
            "Set-Cookie": "accessToken=; HttpOnly; Path=/; Max-Age=0",
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            success: true,
            message: "Вы успешно вышли из аккаунта"
        }));

        return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({
       message: "Not found"
    }));
})

const wss = new WebSocket.Server({server});

const botClients = new Set();
async function processDocument(filename, saveTo) {
    const text = await extractPdfText(saveTo);

    const chunks = splitText(text);

    const maxChunks = envNumber("AI_DOCUMENT_MAX_CHUNKS", 500, 1, 5000);
    if (chunks.length > maxChunks) {
        const error = new Error("DOCUMENT_CHUNK_LIMIT");
        error.code = "DOCUMENT_CHUNK_LIMIT";
        throw error;
    }

    console.log(`Получено ${chunks.length} чанков`);

    const documentId = await saveDocument(
        filename,
        saveTo
    );

    for(let i = 0; i < chunks.length; i++){

        const chunk = chunks[i];

        const chunkId = await saveChunk(
            documentId,
            chunk
        );

        const embedding = await createEmbedding(chunk, {source: "document_index"});

        await updateEmbedding(
            chunkId,
            embedding
        );

        const percent = Math.round(
            ((i + 1) / chunks.length) * 100
        );

        wss.clients.forEach(client=>{

            if(client.readyState === WebSocket.OPEN){

                client.send(JSON.stringify({

                    type:"training_progress",

                    current:i+1,

                    total:chunks.length,

                    percent

                }));

            }

        });

    }

    wss.clients.forEach(client=>{

        if(client.readyState===WebSocket.OPEN){

            client.send(JSON.stringify({

                type:"training_finish"

            }));

        }

    });

    console.log(`Обработано ${filename}`);
}
wss.on("connection", (ws) => {
    console.log("WebSocket клиент подключился");
    ws.on("message", message => {

        try {

            const data = JSON.parse(message);

            if (data.type === "bot") {
               botClients.add(ws);
               console.log("Bot connected");
            }

        } catch {}

    });

    ws.on("close", () => {
        botClients.delete(ws);
    });
});

server.listen(port, async () => {
    console.log(`Server is running on port ${port}`);
    await logDatabaseIdentity();
});
