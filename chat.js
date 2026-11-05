const pool = require("./db");
const { createEmbedding } = require("./gemini");
const fs = require("fs");
async function getOrCreateChat(studentId, studentName, phone) {
    let result = await pool.query(
        `SELECT id
         FROM chats
         WHERE student_id = $1`,
        [studentId]
    );

    if (result.rows.length > 0) {
        return result.rows[0].id;
    }

    result = await pool.query(
        `INSERT INTO chats(student_id, student_name, phone)
         VALUES($1, $2, $3)
         RETURNING id`,
        [studentId, studentName, phone]
    );

    return result.rows[0].id;
}

async function saveMessage(chatId, sender, text) {
    const result = await pool.query(
        `
        INSERT INTO messages(chat_id, sender, text)
        VALUES($1, $2, $3)
        RETURNING *
        `,
        [chatId, sender, text]
    );

    return result.rows[0];
}

async function getChats() {
    const result = await pool.query(`
        SELECT *
        FROM chats
        ORDER BY created_at DESC
    `);

    return result.rows;
}

async function getMessages(chatId) {
    const result = await pool.query(
        `SELECT *
         FROM messages
         WHERE chat_id = $1
         ORDER BY created_at`,
        [chatId]
    );

    return result.rows;
}

async function deleteChat(chatId) {
    await pool.query(
        `DELETE FROM chats
         WHERE id = $1`,
        [chatId]
    );
}

async function setConsultantMode(studentId, enabled) {
    await pool.query(
        `
        UPDATE chats
        SET consultant_mode = $1
        WHERE student_id = $2
        `,
        [enabled, studentId]
    );
}

async function searchChunks(question, limit = 5) {
    // Получаем embedding вопроса
    const embedding = await createEmbedding(question, {source: "retrieval"});

    // Преобразуем массив в формат pgvector
    const vector = `[${embedding.join(",")}]`;

    // Ищем наиболее похожие чанки
    const result = await pool.query(
        `
        SELECT
            c.id,
            c.document_id,
            d.title,
            c.text,
            c.embedding <=> $1::vector AS distance
        FROM chunks c
        JOIN documents d
            ON d.id = c.document_id
        ORDER BY c.embedding <=> $1::vector
        LIMIT $2
        `,
        [vector, limit]
    );

    // Distant matches add noise and waste prompt tokens.
    return result.rows.filter(row => Number(row.distance) <= 0.65);
}

async function saveDocument(filename, path) {

    const stats = fs.statSync(path);

    const result = await pool.query(
        `INSERT INTO documents (title, path, file_size)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [filename, path, stats.size]
    );

    return result.rows[0].id;
}

async function saveChunk(documentId, text) {

    const result = await pool.query(
        `
        INSERT INTO chunks(document_id, text)
        VALUES($1, $2)
        RETURNING id
        `,
        [documentId, text]
    );

    return result.rows[0].id;
}

async function updateEmbedding(chunkId, embedding) {

    const vector = `[${embedding.join(",")}]`;

    await pool.query(
        `
        UPDATE chunks
        SET embedding = $1::vector
        WHERE id = $2
        `,
        [vector, chunkId]
    );
}

async function isConsultantMode(studentId) {

    const result = await pool.query(
        `
        SELECT consultant_mode
        FROM chats
        WHERE student_id = $1
        `,
        [studentId]
    );

    if (result.rows.length === 0) {
        return false;
    }

    return result.rows[0].consultant_mode;
}

async function getUnsentEmployeeMessages(chatId) {
    const result = await pool.query(
        `
        SELECT *
        FROM messages
        WHERE chat_id = $1
          AND sender = 'employee'
          AND sent_to_bot = false
        ORDER BY created_at
        `,
        [chatId]
    );

    return result.rows;
}

async function markMessagesAsSentToBot(messageIds) {
    if (messageIds.length === 0) {
        return;
    }

    await pool.query(
        `
        UPDATE messages
        SET sent_to_bot = true
        WHERE id = ANY($1::int[])
        `,
        [messageIds]
    );
}

async function getDocuments() {
    const result = await pool.query(`
        SELECT
            id,
            title,
            path,
            uploaded_at,
            file_size
        FROM documents
        ORDER BY uploaded_at DESC
    `);

    return result.rows;
}

async function deleteDocument(id) {
    await pool.query(
        "DELETE FROM documents WHERE id = $1",
        [id]
    );
}

async function hasLegacyAIStorage() {
    const result = await pool.query(`
        SELECT to_regclass('public.ai_conversations') IS NOT NULL
           AND to_regclass('public.ai_messages') IS NOT NULL AS available
    `);
    return Boolean(result.rows[0] && result.rows[0].available);
}

async function getAIConversations() {

    if (await hasLegacyAIStorage()) {
        const legacy = await pool.query(`
            SELECT id, telegram_id, username, full_name, updated_at, phone
            FROM ai_conversations
            ORDER BY updated_at DESC
        `);
        return legacy.rows;
    }

    const result = await pool.query(`
        SELECT c.id, c.student_id AS telegram_id, c.username,
               c.student_name AS full_name, c.last_activity_at AS updated_at, c.phone
        FROM chats c
        WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.id AND m.message_type IN ('ai_user','ai_assistant'))
        ORDER BY c.last_activity_at DESC NULLS LAST
    `);

    return result.rows;
}

async function getAIConversationMessages(id) {

    if (await hasLegacyAIStorage()) {
        const legacy = await pool.query(`
            SELECT role, message, created_at
            FROM ai_messages
            WHERE conversation_id = $1
            ORDER BY created_at ASC
        `, [id]);
        return legacy.rows;
    }

    const result = await pool.query(`
        SELECT
            role,
            message,
            created_at
        FROM (
            SELECT CASE WHEN sender='student' THEN 'user' ELSE 'assistant' END AS role,
                   text AS message, created_at
            FROM messages
            WHERE chat_id = $1 AND message_type IN ('ai_user','ai_assistant')
        ) ai_messages
        ORDER BY created_at ASC
    `, [id]);

    return result.rows;
}

async function getAIConversationByTelegramId(telegramId) {

    if (await hasLegacyAIStorage()) {
        const legacy = await pool.query(`
            SELECT * FROM ai_conversations
            WHERE telegram_id = $1
            LIMIT 1
        `, [telegramId]);
        return legacy.rows[0];
    }

    const result = await pool.query(`
        SELECT id, student_id AS telegram_id, username,
               student_name AS full_name, phone, created_at, last_activity_at AS updated_at
        FROM chats
        WHERE student_id = $1
        LIMIT 1
    `, [telegramId]);

    return result.rows[0];
}

async function createAIConversation(telegramId, username, fullName, phone) {
    if (await hasLegacyAIStorage()) {
        const legacy = await pool.query(`
            INSERT INTO ai_conversations (telegram_id, username, full_name, phone)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (telegram_id) DO UPDATE SET
                username=EXCLUDED.username,
                full_name=EXCLUDED.full_name,
                phone=EXCLUDED.phone,
                updated_at=now()
            RETURNING *
        `, [telegramId, username, fullName, phone]);
        return legacy.rows[0];
    }
    await getOrCreateChat(telegramId, fullName || username, phone);
    return getAIConversationByTelegramId(telegramId);
}

async function saveAIMessage(conversationId, role, message) {
    if (await hasLegacyAIStorage()) {
        await pool.query(`
            INSERT INTO ai_messages (conversation_id, role, message)
            VALUES ($1, $2, $3)
        `, [conversationId, role, message]);
        return;
    }
    const sender = role === "user" ? "student" : "assistant";
    const messageType = role === "user" ? "ai_user" : "ai_assistant";
    await pool.query(`
        INSERT INTO messages(chat_id, sender, text, message_type)
        VALUES ($1, $2, $3, $4)
    `, [conversationId, sender, message, messageType]);
}

async function updateAIConversation(conversationId) {

    if (await hasLegacyAIStorage()) {
        await pool.query(`
            UPDATE ai_conversations SET updated_at=now() WHERE id=$1
        `, [conversationId]);
        return;
    }

    await pool.query(`
        UPDATE chats
        SET last_activity_at = NOW()
        WHERE id = $1
    `, [conversationId]);
}

module.exports = {
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
};
