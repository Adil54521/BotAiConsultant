import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler

import requests
from dotenv import load_dotenv

ai_logger = logging.getLogger("ai_usage")
ai_logger.setLevel(logging.INFO)
if not ai_logger.handlers:
    handler = RotatingFileHandler("ai_usage.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s | %(message)s"))
    ai_logger.addHandler(handler)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=True)
SEARCH_URL = os.getenv("KNOWLEDGE_SEARCH_URL", "http://127.0.0.1:8004/search")
MAX_CONTEXT_CHARS = 12_000
MAX_HISTORY_CHARS = 4_000
MAX_HISTORY_MESSAGES = 6
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
    return max(1, (len(text or "") + 3) // 4)


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


def get_context(question, limit=3, session=requests):
    """Fetch top RAG chunks once. Retrieval failure is a non-fatal empty result."""
    started = time.perf_counter()
    try:
        response = session.post(SEARCH_URL, json={"question": question, "limit": min(max(limit, 1), 5)}, timeout=12)
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
            chunks, context = get_context(user_input, session=self.session)
        prompt = user_input.strip()
        if context:
            prompt = f"Внутренние фрагменты:\n{context}\n\nВопрос: {prompt}"
        elif route == "knowledge":
            prompt = f"Внутренние документы недоступны или не содержат подходящих фрагментов. Не выдумывай сведения.\n\nВопрос: {prompt}"
        thinking_level = "low" if route in {"chat", "history"} else "medium"
        max_output = 512 if route == "chat" else 1024
        payload = {"systemInstruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]}, "generationConfig": {"maxOutputTokens": max_output, "thinkingConfig": {"thinkingLevel": thinking_level}}, "contents": history_contents + [{"role": "user", "parts": [{"text": prompt}]}]}
        if route == "search":
            payload["tools"] = [{"google_search": {}}]
        use_cache = os.getenv("USE_LEGACY_UNIVERSITY_CACHE") == "1" and route == "knowledge"
        if use_cache and self.cache_name:
            payload["cachedContent"] = self.cache_name
        stats = {"route": route, "system_chars": len(SYSTEM_INSTRUCTION), "system_est_tokens": estimate_tokens(SYSTEM_INSTRUCTION), "history_messages": len(history_contents), "history_chars": sum(len(x["parts"][0]["text"]) for x in history_contents), "document_chunks": len(chunks), "document_chars": len(context), "cached_content": bool(payload.get("cachedContent")), "thinking_level": thinking_level, "max_output_tokens": max_output}
        return payload, stats

    def ask_ai_detailed(self, user_input, user_meta=None, history=None):
        started = time.perf_counter()
        request_id = str(uuid.uuid4())
        requested_at = datetime.now(timezone.utc).isoformat()
        payload, stats = self.build_request(user_input, history)
        ai_logger.info("AI_REQUEST | meta=%s | stats=%s", json.dumps(user_meta or {}, ensure_ascii=False), json.dumps(stats, ensure_ascii=False))
        try:
            response = self.session.post(f"{self.base_url}/{self.model}:generateContent", headers=self._headers(), json=payload, timeout=60)
            if not response.ok:
                ai_logger.error("AI_HTTP_ERROR | %s", safe_response_error(response))
                return "Сейчас не удалось получить ответ ИИ. Попробуйте позже или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type=f"HTTP_{response.status_code}")
            data = response.json()
            usage = data.get("usageMetadata", {})
            final_stats = {**stats, "promptTokenCount": usage.get("promptTokenCount", 0), "cachedContentTokenCount": usage.get("cachedContentTokenCount", 0), "thoughtsTokenCount": usage.get("thoughtsTokenCount", 0), "candidatesTokenCount": usage.get("candidatesTokenCount", 0), "totalTokenCount": usage.get("totalTokenCount", 0), "duration_ms": round((time.perf_counter() - started) * 1000)}
            ai_logger.info("AI_USAGE | %s", json.dumps(final_stats, ensure_ascii=False))
            answer = "".join(part.get("text", "") for part in data["candidates"][0]["content"]["parts"]).strip()
            if not answer:
                raise ValueError("empty model response")
            ai_logger.info("AI_RESPONSE | route=%s | chars=%d", stats["route"], len(answer))
            return answer, self._usage_record(request_id, requested_at, stats, "success", started, usage=usage)
        except requests.Timeout:
            ai_logger.error("AI_ERROR | type=Timeout | route=%s", stats["route"])
            return "ИИ отвечает дольше обычного. Попробуйте ещё раз или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type="Timeout")
        except requests.RequestException as error:
            ai_logger.error("AI_ERROR | type=%s | route=%s", type(error).__name__, stats["route"])
            return "Сервис ИИ временно недоступен. Попробуйте позже или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type=type(error).__name__)
        except (ValueError, KeyError, IndexError, TypeError) as error:
            ai_logger.error("AI_ERROR | type=%s | route=%s", type(error).__name__, stats["route"])
            return "Не удалось обработать ответ ИИ. Попробуйте ещё раз или обратитесь к сотруднику.", self._usage_record(request_id, requested_at, stats, "error", started, error_type=type(error).__name__)

    def _usage_record(self, request_id, requested_at, stats, status, started, usage=None, error_type=None):
        usage = usage or {}
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
            "durationMs": round((time.perf_counter() - started) * 1000),
            "errorType": error_type,
        }

    def ask_ai(self, user_input, user_meta=None, history=None):
        answer, _ = self.ask_ai_detailed(user_input, user_meta, history)
        return answer


if __name__ == "__main__":
    bot = Gemini()
    while True:
        print(bot.ask_ai(input("Вопрос: "), user_meta={"source": "console"}))
