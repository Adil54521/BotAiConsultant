const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

function envInt(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : fallback;
}

function envNumber(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

const MAX_EMBEDDING_CHARS = envInt("GEMINI_EMBEDDING_MAX_CHARS", 12_000, 256, 30_000);
const MAX_EMBEDDING_RPM = envInt("GEMINI_EMBEDDING_MAX_RPM", 30, 1, 300);
const MAX_EMBEDDING_DAILY = envInt("GEMINI_EMBEDDING_DAILY_LIMIT", 1_000, 1, 100_000);
const MAX_EMBEDDING_CONCURRENCY = envInt("GEMINI_EMBEDDING_MAX_CONCURRENCY", 3, 1, 16);
const EMBEDDING_INPUT_RATE = envNumber("GEMINI_EMBEDDING_INPUT_USD_PER_MILLION", 0.15, 0, 1000);
const EMBEDDING_DAILY_COST_LIMIT = envNumber("AI_EMBEDDING_DAILY_COST_LIMIT_USD", 1, 0.01, 1000000);
const minuteCalls = [];
let dayKey = new Date().toISOString().slice(0, 10);
let dayCalls = 0;
let dayEstimatedCost = 0;
let activeCalls = 0;
const waiters = [];

function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

async function acquireSlot() {
    if (activeCalls >= MAX_EMBEDDING_CONCURRENCY) {
        await new Promise(resolve => waiters.push(resolve));
    }
    activeCalls += 1;
}

function releaseSlot() {
    activeCalls = Math.max(activeCalls - 1, 0);
    const next = waiters.shift();
    if (next) next();
}

function checkEmbeddingBudget() {
    const now = Date.now();
    const currentDay = new Date(now).toISOString().slice(0, 10);
    if (currentDay !== dayKey) {
        dayKey = currentDay;
        dayCalls = 0;
        dayEstimatedCost = 0;
    }
    while (minuteCalls.length && minuteCalls[0] <= now - 60_000) minuteCalls.shift();
    if (minuteCalls.length >= MAX_EMBEDDING_RPM) throw codedError("EMBEDDING_RATE_LIMIT");
    if (dayCalls >= MAX_EMBEDDING_DAILY) throw codedError("EMBEDDING_DAILY_LIMIT");
    minuteCalls.push(now);
    dayCalls += 1;
}

async function createEmbedding(text, meta = {}) {
    const value = String(text || "").trim();
    if (!value || value.length > MAX_EMBEDDING_CHARS) {
        throw codedError("INVALID_EMBEDDING_INPUT");
    }
    checkEmbeddingBudget();
    const estimatedTokens = Math.ceil(value.length / 3);
    const estimatedCost = estimatedTokens * EMBEDDING_INPUT_RATE / 1_000_000;
    if (dayEstimatedCost + estimatedCost > EMBEDDING_DAILY_COST_LIMIT) {
        throw codedError("EMBEDDING_DAILY_COST_LIMIT");
    }
    dayEstimatedCost += estimatedCost;
    await acquireSlot();
    const started = Date.now();
    const source = String(meta.source || "internal").slice(0, 40);
    console.log(`EMBEDDING_REQUEST source=${source} chars=${value.length} estimated_tokens=${estimatedTokens} estimated_cost_usd=${estimatedCost.toFixed(8)} attempt=1/1`);
    try {
        const response = await ai.models.embedContent({
            model: "gemini-embedding-001",
            contents: value
        });
        console.log(`EMBEDDING_RESPONSE source=${source} status=success duration_ms=${Date.now() - started}`);
        return response.embeddings[0].values;
    } catch (error) {
        const code = String(error && (error.code || error.status) || "unknown").slice(0, 40);
        console.error(`EMBEDDING_ERROR source=${source} code=${code} duration_ms=${Date.now() - started}`);
        throw error;
    } finally {
        releaseSlot();
    }
}

module.exports = {
    createEmbedding
};
