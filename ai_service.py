import json
import logging
import os
import re
import random
import time
import uuid
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler

import requests
from dotenv import load_dotenv

ai_logger = logging.getLogger("ai_usage")
ai_logger.setLevel(logging.INFO)
if not ai_logger.handlers:
    if os.getenv("AI_USAGE_LOG_DISABLED") == "1":
        handler = logging.NullHandler()
    else:
        handler = RotatingFileHandler(
            os.getenv("AI_USAGE_LOG_PATH", "ai_usage.log"),
            maxBytes=5_000_000,
            backupCount=5,
            encoding="utf-8",
        )
    handler.setFormatter(logging.Formatter("%(asctime)s | %(message)s"))
    ai_logger.addHandler(handler)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=False)
SEARCH_URL = os.getenv("KNOWLEDGE_SEARCH_URL", "http://127.0.0.1:8004/search")


def env_int(name, default, minimum=0, maximum=1_000_000):
    try:
        return min(max(int(os.getenv(name, default)), minimum), maximum)
    except (TypeError, ValueError):
        return default


def env_float(name, default, minimum=0.0, maximum=1_000_000.0):
    try:
        return min(max(float(os.getenv(name, default)), minimum), maximum)
    except (TypeError, ValueError):
        return default


MAX_CONTEXT_CHARS = env_int("GEMINI_MAX_CONTEXT_CHARS", 12_000, 1_000, 30_000)
MAX_HISTORY_CHARS = env_int("GEMINI_MAX_HISTORY_CHARS", 4_000, 0, 12_000)
MAX_HISTORY_MESSAGES = env_int("GEMINI_MAX_HISTORY_MESSAGES", 6, 0, 12)
MAX_INPUT_TOKENS = env_int("GEMINI_MAX_INPUT_TOKENS", 6_000, 500, 30_000)
MAX_USER_CHARS = env_int("GEMINI_MAX_USER_CHARS", 4_096, 256, 8_192)
MAX_ATTEMPTS = env_int("GEMINI_MAX_ATTEMPTS", 1, 1, 2)
PRICING_VERSION = os.getenv("GEMINI_PRICING_EFFECTIVE_DATE", "2026-11-05")
INPUT_USD_PER_MILLION = env_float("GEMINI_INPUT_USD_PER_MILLION", 0.30)
CACHED_USD_PER_MILLION = env_float("GEMINI_CACHED_INPUT_USD_PER_MILLION", 0.03)
OUTPUT_USD_PER_MILLION = env_float("GEMINI_OUTPUT_USD_PER_MILLION", 2.50)
SEARCH_USD_PER_QUERY = env_float("GEMINI_SEARCH_USD_PER_QUERY", 0.014)
TRANSIENT_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
SYSTEM_INSTRUCTION = (
    "Ты — консультант по академической мобильности. Отвечай на языке пользователя, "
    "кратко и по существу. Не выдумывай факты. Если данных недостаточно, прямо скажи "
    "об этом. Внутренние документы считай приоритетным источником; для актуальных "
    "внешних фактов используй Google Search, когда инструмент подключён."
)

CURRENT_MARKERS = ("сейчас", "сегодня", "последн", "актуальн", "новост", "2025", "2026", "current", "today", "latest", "deadline", "дедлайн", "курс валют", "погода", "қазір", "бүгін", "соңғы", "өзекті", "жаңалық")
KNOWLEDGE_MARKERS = ("университет", "академическ", "мобильност", "поступ", "перевод", "документ", "положение", "приказ", "стипенд", "общежит", "факультет", "специальност", "university", "mobility", "admission", "университеті", "академиялық", "ұтқырлық", "аударма", "құжат", "грант")
FOLLOWUP_MARKERS = ("а если", "а как", "а там", "подробнее", "про это", "этот", "эта", "они", "ал егер", "ал онда", "толығырақ", "бұл", "сол", "what about", "and there")


def sanitize_error_text(text, limit=300):
    text = re.sub(r"([?&]key=)[^&\s]+", r"\1[REDACTED]", text or "", flags=re.I)
    text = re.sub(r"(GEMINI_API_KEY\s*[=:]\s*)[^,\s]+", r"\1[REDACTED]", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def safe_response_error(response):
    body = sanitize_error_text(getattr(response, "text", ""))
    return f"status={response.status_code} | body={body or '[empty]'}"


def estimate_tokens(text):
    # Conservative text-only estimate. The provider usage metadata remains authoritative.
    return max(1, (len(text or "") + 2) // 3)


def estimate_cost_usd(usage, search_query_count=0):
    prompt = max(int(usage.get("promptTokenCount") or 0), 0)
    cached = min(max(int(usage.get("cachedContentTokenCount") or 0), 0), prompt)
    output = max(int(usage.get("candidatesTokenCount") or 0), 0)
    thoughts = max(int(usage.get("thoughtsTokenCount") or 0), 0)
    cost = (
        (prompt - cached) * INPUT_USD_PER_MILLION
        + cached * CACHED_USD_PER_MILLION
        + (output + thoughts) * OUTPUT_USD_PER_MILLION
    ) / 1_000_000
    cost += max(int(search_query_count or 0), 0) * SEARCH_USD_PER_QUERY
    return round(cost, 8)


def route_request(question, history=None):
    normalized = (question or "").strip().lower()
    if any(marker in normalized for marker in CURRENT_MARKERS):
        return "search"
    if any(marker in normalized for marker in KNOWLEDGE_MARKERS):
        return "knowledge"
    if history and (len(normalized.split()) <= 8 or any(marker in normalized for marker in FOLLOWUP_MARKERS)):
        return "history"
    return "chat"


def trim_history(history):
    selected, size = [], 0
    selection_budget = MAX_HISTORY_CHARS - (800 if len(history or []) > MAX_HISTORY_MESSAGES else 0)
    for item in reversed(history or []):
        role, text = item.get("role"), str(item.get("text", "")).strip()
        if role not in {"user", "model"} or not text:
            continue
        text = text[:1500]
        if selected and size + len(text) > selection_budget:
            break
        selected.append({"role": role, "parts": [{"text": text}]})
        size += len(text)
        if len(selected) >= MAX_HISTORY_MESSAGES - 1:
            break
    selected = list(reversed(selected))
    omitted = max(0, len(history or []) - len(selected))
    if omitted:
        # Bounded extractive summary avoids another paid model call.
        older = (history or [])[:omitted][-4:]
        summary = " | ".join(
            f"{item.get('role', 'message')}: {str(item.get('text', '')).strip()[:180]}"
            for item in older if item.get("text")
        )[:800]
        if summary:
            selected.insert(0, {"role": "user", "parts": [{"text": f"Краткое резюме более раннего диалога: {summary}"}]})
    return selected


def get_context(question, limit=3, session=requests, internal_token=None):
    """Fetch top RAG chunks once. Retrieval failure is a non-fatal empty result."""
    started = time.perf_counter()
    try:
        headers = {"x-internal-token": internal_token} if internal_token else {}
        response = session.post(
            SEARCH_URL,
            json={"question": question[:MAX_USER_CHARS], "limit": min(max(limit, 1), 5)},
            headers=headers,
            timeout=12,
        )
        if not response.ok:
            ai_logger.error("SEARCH_ERROR | endpoint=/search | attempt=1/1 | %s | duration_ms=%d", safe_response_error(response), (time.perf_counter() - started) * 1000)
            return [], ""
        chunks = (response.json().get("chunks") or [])[:limit]
        clean = []
        for chunk in chunks:
            text = str(chunk.get("text", "")).strip()
            if text:
                clean.append({"title": str(chunk.get("title", ""))[:200], "text": text[:4000]})
        context = "\n\n".join(f"[{c['title']}]\n{c['text']}" for c in clean)[:MAX_CONTEXT_CHARS]
        return clean, context
    except requests.RequestException as error:
        status = getattr(getattr(error, "response", None), "status_code", None)
        ai_logger.error("SEARCH_ERROR | endpoint=/search | attempt=1/1 | type=%s | status=%s | duration_ms=%d", type(error).__name__, status or "none", (time.perf_counter() - started) * 1000)
        return [], ""
    except (ValueError, TypeError, AttributeError) as error:
        ai_logger.error("SEARCH_ERROR | endpoint=/search | attempt=1/1 | type=%s", type(error).__name__)
        return [], ""


class Gemini:
    def __init__(self, session=requests):
        self.api_key = os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY отсутствует в .env")
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"
        self.model = os.getenv("GEMINI_MODEL", "models/gemini-3.5-flash-lite")
        self.cache_name = None
        self.session = session
        self.internal_api_token = os.getenv("INTERNAL_API_TOKEN", "").strip()

    def _headers(self):
        return {"Content-Type": "application/json", "x-goog-api-key": self.api_key}

    def create_university_cache(self):
        """Legacy opt-in cache. Routed requests do not attach it by default."""
        self.cache_name = None
        try:
            with open("data.json", "r", encoding="utf-8") as file:
                data = json.load(file)
            response = self.session.post(f"{self.base_url}/cachedContents", headers=self._headers(), json={"model": self.model, "displayName": "university_data", "contents": [{"role": "user", "parts": [{"text": json.dumps(data, ensure_ascii=False)}]}], "ttl": "3600s"}, timeout=30)
            if not response.ok:
                ai_logger.error("CACHE_HTTP_ERROR | %s", safe_response_error(response))
                return False
            self.cache_name = response.json()["name"]
            ai_logger.info("CACHE_CREATED | name=%s", self.cache_name)
            return True
        except (requests.RequestException, OSError, ValueError, KeyError) as error:
            ai_logger.error("CACHE_ERROR | type=%s", type(error).__name__)
            return False

    def build_request(self, user_input, history=None):
        route = route_request(user_input, history)
        history_contents = trim_history(history) if route == "history" else []
        chunks, context = ([], "")
        if route == "knowledge":
            chunks, context = get_context(
                user_input,
                session=self.session,
                internal_token=self.internal_api_token,
            )
        prompt = user_input.strip()[:MAX_USER_CHARS]
        if context:
            prompt = f"Внутренние фрагменты:\n{context}\n\nВопрос: {prompt}"
        elif route == "knowledge":
            prompt = f"Внутренние документы недоступны или не содержат подходящих фрагментов. Не выдумывай сведения.\n\nВопрос: {prompt}"
        thinking_level = {"chat": "minimal", "history": "low"}.get(route, "medium")
        max_output = {
            "chat": env_int("GEMINI_CHAT_MAX_OUTPUT_TOKENS", 384, 128, 1024),
            "history": env_int("GEMINI_HISTORY_MAX_OUTPUT_TOKENS", 512, 128, 1024),
        }.get(route, env_int("GEMINI_COMPLEX_MAX_OUTPUT_TOKENS", 768, 256, 1536))
        payload = {"systemInstruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]}, "generationConfig": {"maxOutputTokens": max_output, "thinkingConfig": {"thinkingLevel": thinking_level}}, "contents": history_contents + [{"role": "user", "parts": [{"text": prompt}]}]}
        if route == "search":
            payload["tools"] = [{"google_search": {}}]
        use_cache = os.getenv("USE_LEGACY_UNIVERSITY_CACHE") == "1" and route == "knowledge"
        if use_cache and self.cache_name:
            payload["cachedContent"] = self.cache_name
        estimated_input = estimate_tokens(json.dumps(payload, ensure_ascii=False))
        if estimated_input > MAX_INPUT_TOKENS:
            overflow_chars = (estimated_input - MAX_INPUT_TOKENS) * 3
            final_text = payload["contents"][-1]["parts"][0]["text"]
            payload["contents"][-1]["parts"][0]["text"] = final_text[max(0, overflow_chars):]
            estimated_input = estimate_tokens(json.dumps(payload, ensure_ascii=False))
        stats = {"model": self.model.removeprefix("models/"), "route": route, "system_chars": len(SYSTEM_INSTRUCTION), "system_est_tokens": estimate_tokens(SYSTEM_INSTRUCTION), "estimated_input_tokens": estimated_input, "input_token_limit": MAX_INPUT_TOKENS, "history_messages": len(history_contents), "history_chars": sum(len(x["parts"][0]["text"]) for x in history_contents), "document_chunks": len(chunks), "document_chars": len(context), "cached_content": bool(payload.get("cachedContent")), "thinking_level": thinking_level, "max_output_tokens": max_output}
        return payload, stats

    def ask_ai_detailed(self, user_input, user_meta=None, history=None):
        started = time.perf_counter()
        user_meta = dict(user_meta or {})
        request_id = str(user_meta.get("request_id") or uuid.uuid4())
        requested_at = str(user_meta.get("requested_at") or datetime.now(timezone.utc).isoformat())
        payload, stats = self.build_request(user_input, history)
        safe_meta = {
            "source": user_meta.get("source", "internal"),
            "user_ref": user_meta.get("user_ref"),
            "message_id": user_meta.get("message_id"),
            "request_id": request_id,
        }
        ai_logger.info("AI_REQUEST | meta=%s | stats=%s", json.dumps(safe_meta, ensure_ascii=False), json.dumps(stats, ensure_ascii=False))
        response = None
        attempts = 0
        try:
            for attempt in range(1, MAX_ATTEMPTS + 1):
                attempts = attempt
                try:
                    response = self.session.post(f"{self.base_url}/{self.model}:generateContent", headers=self._headers(), json=payload, timeout=60)
                except (requests.Timeout, requests.ConnectionError):
                    if attempt >= MAX_ATTEMPTS:
                        raise
                    delay = 0.5 * (2 ** (attempt - 1)) + random.uniform(0, 0.15)
                    ai_logger.warning("AI_RETRY | request_id=%s | attempt=%d/%d | reason=network | delay_ms=%d", request_id, attempt + 1, MAX_ATTEMPTS, delay * 1000)
                    time.sleep(delay)
                    continue
                if response.ok or response.status_code not in TRANSIENT_HTTP_STATUSES or attempt >= MAX_ATTEMPTS:
                    break
                delay = 0.5 * (2 ** (attempt - 1)) + random.uniform(0, 0.15)
                ai_logger.warning("AI_RETRY | request_id=%s | attempt=%d/%d | status=%d | delay_ms=%d", request_id, attempt + 1, MAX_ATTEMPTS, response.status_code, delay * 1000)
                time.sleep(delay)
            if response is None or not response.ok:
                status = getattr(response, "status_code", "none")
                if response is not None:
                    ai_logger.error("AI_HTTP_ERROR | request_id=%s | attempts=%d | %s", request_id, attempts, safe_response_error(response))
                return "Сейчас не удалось получить ответ ИИ. Попробуйте позже или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type=f"HTTP_{status}", retries=max(attempts - 1, 0), user_meta=user_meta)
            data = response.json()
            usage = data.get("usageMetadata", {})
            candidate = (data.get("candidates") or [{}])[0]
            search_queries = len((candidate.get("groundingMetadata") or {}).get("webSearchQueries") or [])
            estimated_cost = estimate_cost_usd(usage, search_queries)
            final_stats = {**stats, **safe_meta, "status": "success", "attempts": attempts, "promptTokenCount": usage.get("promptTokenCount", 0), "cachedContentTokenCount": usage.get("cachedContentTokenCount", 0), "thoughtsTokenCount": usage.get("thoughtsTokenCount", 0), "candidatesTokenCount": usage.get("candidatesTokenCount", 0), "totalTokenCount": usage.get("totalTokenCount", 0), "search_query_count": search_queries, "estimated_cost_usd": estimated_cost, "pricing_effective_date": PRICING_VERSION, "duration_ms": round((time.perf_counter() - started) * 1000)}
            ai_logger.info("AI_USAGE | %s", json.dumps(final_stats, ensure_ascii=False))
            answer = "".join(part.get("text", "") for part in data["candidates"][0]["content"]["parts"]).strip()
            if not answer:
                raise ValueError("empty model response")
            ai_logger.info("AI_RESPONSE | route=%s | chars=%d", stats["route"], len(answer))
            return answer, self._usage_record(request_id, requested_at, stats, "success", started, usage=usage, retries=max(attempts - 1, 0), user_meta=user_meta, search_query_count=search_queries)
        except requests.Timeout:
            ai_logger.error("AI_ERROR | request_id=%s | type=Timeout | route=%s | attempts=%d", request_id, stats["route"], attempts)
            return "ИИ отвечает дольше обычного. Попробуйте ещё раз или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type="Timeout", retries=max(attempts - 1, 0), user_meta=user_meta)
        except requests.RequestException as error:
            ai_logger.error("AI_ERROR | request_id=%s | type=%s | route=%s | attempts=%d", request_id, type(error).__name__, stats["route"], attempts)
            return "Сервис ИИ временно недоступен. Попробуйте позже или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type=type(error).__name__, retries=max(attempts - 1, 0), user_meta=user_meta)
        except (ValueError, KeyError, IndexError, TypeError) as error:
            ai_logger.error("AI_ERROR | request_id=%s | type=%s | route=%s", request_id, type(error).__name__, stats["route"])
            return "Не удалось обработать ответ ИИ. Попробуйте ещё раз или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type=type(error).__name__, retries=max(attempts - 1, 0), user_meta=user_meta)

    def _usage_record(self, request_id, requested_at, stats, status, started, usage=None, error_type=None, retries=0, user_meta=None, search_query_count=0):
        usage = usage or {}
        user_meta = user_meta or {}
        return {
            "requestId": request_id,
            "requestedAt": requested_at,
            "model": self.model.removeprefix("models/"),
            "route": stats["route"],
            "status": status,
            "promptTokens": usage.get("promptTokenCount"),
            "candidateTokens": usage.get("candidatesTokenCount"),
            "thoughtsTokens": usage.get("thoughtsTokenCount"),
            "totalTokens": usage.get("totalTokenCount"),
            "cachedTokens": usage.get("cachedContentTokenCount"),
            "source": user_meta.get("source", "internal"),
            "telegramMessageId": user_meta.get("message_id"),
            "retryCount": retries,
            "searchQueryCount": search_query_count,
            "estimatedCostUsd": estimate_cost_usd(usage, search_query_count),
            "pricingEffectiveDate": PRICING_VERSION,
            "durationMs": round((time.perf_counter() - started) * 1000),
            "errorType": error_type,
        }

    def ask_ai(self, user_input, user_meta=None, history=None):
        answer, _ = self.ask_ai_detailed(user_input, user_meta, history)
        return answer


if __name__ == "__main__":
    if os.getenv("ENABLE_AI_CONSOLE") != "1":
        raise SystemExit("AI console is disabled. Set ENABLE_AI_CONSOLE=1 for explicit manual use.")
    bot = Gemini()
    while True:
        print(bot.ask_ai(input("Вопрос: "), user_meta={"source": "console"}))
