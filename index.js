require("dotenv").config({ path: "config.env" });
require("dotenv").config({
    path: ".env"
});

const route = require('http');
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 8004;
const Busboy = require("busboy");
const fs = require("fs");
const WebSocket = require("ws");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const { createEmbedding } = require("./gemini");
const {
    getBotUser,
    registerBotUser,
    touchBotUser,
    recordAiUsage,
    openSupportRequest,
    updateSupportRequest,
    getOverview,
    getUserStats,
    getUsageRows,
    getSupportRows
} = require("./analytics");

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

function isInternalAuthorized(req) {
    return Boolean(INTERNAL_API_TOKEN) && req.headers["x-internal-token"] === INTERNAL_API_TOKEN;
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

    const parser = new PDFParse({
        data: fs.readFileSync(filePath)
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


const MAX_SIZE = 100 * 1024 * 1024;
const server = route.createServer(async (req, res) => {
    console.log(req.method, req.url);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', 'https://undercook-habitable-disposal.ngrok-free.dev');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
    );

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url.startsWith("/internal/") && !isInternalAuthorized(req)) {
        res.writeHead(403, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: "Forbidden"}));
        return;
    }

    if (req.method === "GET" && req.url.startsWith("/internal/bot-user?")) {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            const user = await getBotUser(url.searchParams.get("telegramId"));
            res.end(JSON.stringify({registered: Boolean(user && user.phone_verified), user}));
        } catch (error) {
            console.error(`BOT_USER_LOOKUP_ERROR type=${error.constructor.name}`);
            res.writeHead(500);
            res.end(JSON.stringify({error: "Server error"}));
        }
        return;
    }

    if (req.method === "POST" && req.url === "/internal/bot-user/register") {
        try {
            const user = await registerBotUser(await readJsonBody(req));
            res.end(JSON.stringify({success: true, user}));
        } catch (error) {
            const invalid = error.message === "INVALID_PHONE";
            console.error(`BOT_USER_REGISTER_ERROR type=${error.constructor.name}`);
            res.writeHead(invalid ? 400 : 500);
            res.end(JSON.stringify({success: false, error: invalid ? "Invalid phone" : "Server error"}));
        }
        return;
    }

    if (req.method === "POST" && req.url === "/internal/ai/usage") {
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

    if (req.method === "POST" && req.url === "/internal/support/request") {
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

    if (req.method === "POST" && req.url === "/internal/admin/analytics") {
        try {
            const data = await readJsonBody(req);
            let result;
            if (data.action === "overview") result = await getOverview(data.from, data.to);
            else if (data.action === "users") result = await getUserStats(data.from, data.to, data.search, data.limit, data.offset);
            else if (data.action === "report") result = {
                overview: await getOverview(data.from, data.to),
                users: await getUserStats(data.from, data.to, null, 200000, 0),
                usage: await getUsageRows(data.from, data.to),
                support: await getSupportRows(data.from, data.to)
            };
            else throw new Error("INVALID_ACTION");
            res.end(JSON.stringify({success: true, data: result}));
        } catch (error) {
            console.error(`ADMIN_ANALYTICS_ERROR type=${error.constructor.name}`);
            res.writeHead(400);
            res.end(JSON.stringify({success: false, error: "Invalid request"}));
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

                const payload = jwt.verify(token, "secret_key");

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
                    "secret_key",
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

            const payload = jwt.verify(token, "secret_key");

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
                "secret_key"
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
                    'secret_key'
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
        const busboy = Busboy({
            headers: req.headers,
            limits: {
                fileSize: MAX_SIZE
            }
        });

        busboy.on("file", (fieldname, file, info) => {
            const { filename } = info;

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

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", async () => {
            try {

                const { question, limit = 3 } = JSON.parse(body);

                if (!question) {
                    res.writeHead(400, {
                        "Content-Type": "application/json"
                    });

                    return res.end(JSON.stringify({
                        message: "Question is required"
                    }));
                }

                const safeLimit = Math.min(Math.max(Number(limit) || 3, 1), 5);
                const chunks = await searchChunks(question, safeLimit);

                const context = chunks
                    .map(chunk => chunk.text)
                    .join("\n\n");
                res.writeHead(200, {
                    "Content-Type": "application/json"
                });

                res.end(JSON.stringify({
                    context,
                    chunks
                }));

            } catch (err) {

                const errorType = err && err.constructor ? err.constructor.name : "Error";
                const errorCode = err && err.code ? String(err.code).slice(0, 40) : "unknown";
                console.error(`SEARCH_ERROR type=${errorType} code=${errorCode}`);

                res.writeHead(500, {
                    "Content-Type": "application/json"
                });

                res.end(JSON.stringify({
                    message: "Search error"
                }));
            }
        });

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

        const embedding = await createEmbedding(chunk);

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

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
