import json
import os
import unittest
from unittest.mock import patch

import requests

import ai_service


class FakeResponse:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text or json.dumps(self._payload)

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, search_response=None, model_response=None):
        self.calls = []
        self.search_response = search_response or FakeResponse(payload={"chunks": []})
        self.model_response = model_response

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url.endswith("/search"):
            return self.search_response
        if self.model_response is not None:
            return self.model_response
        return FakeResponse(payload={
            "candidates": [{"content": {"parts": [{"text": "Тестовый ответ"}]}}],
            "usageMetadata": {
                "promptTokenCount": 120,
                "cachedContentTokenCount": 0,
                "thoughtsTokenCount": 8,
                "candidatesTokenCount": 20,
                "totalTokenCount": 148,
            },
        })


class GeminiRoutingTests(unittest.TestCase):
    def make_client(self, session=None):
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}):
            return ai_service.Gemini(session=session or FakeSession())

    def test_simple_chat_has_no_search_documents_or_cache(self):
        session = FakeSession()
        payload, stats = self.make_client(session).build_request("Қазақша білесіңба?")
        self.assertEqual(stats["route"], "chat")
        self.assertEqual(stats["document_chunks"], 0)
        self.assertFalse(stats["cached_content"])
        self.assertNotIn("tools", payload)
        self.assertEqual(session.calls, [])
        self.assertLess(ai_service.estimate_tokens(json.dumps(payload, ensure_ascii=False)), 300)

    def test_internal_question_uses_only_relevant_chunks(self):
        chunks = [
            {"title": "Положение", "text": "Релевантный фрагмент", "distance": 0.2},
            {"title": "Приказ", "text": "Второй фрагмент", "distance": 0.3},
        ]
        session = FakeSession(FakeResponse(payload={"chunks": chunks}))
        payload, stats = self.make_client(session).build_request("Что сказано в положении университета?")
        self.assertEqual(stats["route"], "knowledge")
        self.assertEqual(stats["document_chunks"], 2)
        self.assertFalse(stats["cached_content"])
        self.assertEqual(len(session.calls), 1)
        self.assertIn("Релевантный фрагмент", payload["contents"][-1]["parts"][0]["text"])

    def test_current_question_enables_google_search_only(self):
        session = FakeSession()
        payload, stats = self.make_client(session).build_request("Какие актуальные дедлайны сегодня?")
        self.assertEqual(stats["route"], "search")
        self.assertEqual(payload["tools"], [{"google_search": {}}])
        self.assertEqual(session.calls, [])

    def test_followup_uses_bounded_history(self):
        history = []
        for index in range(20):
            history.extend([
                {"role": "user", "text": f"Вопрос {index} " + "x" * 500},
                {"role": "model", "text": f"Ответ {index} " + "y" * 500},
            ])
        payload, stats = self.make_client().build_request("А там какие сроки?", history)
        self.assertEqual(stats["route"], "history")
        self.assertLessEqual(stats["history_messages"], ai_service.MAX_HISTORY_MESSAGES)
        self.assertLessEqual(stats["history_chars"], ai_service.MAX_HISTORY_CHARS)
        self.assertEqual(len(payload["contents"]), stats["history_messages"] + 1)

    def test_search_500_falls_back_without_retry_or_full_database(self):
        session = FakeSession(FakeResponse(status=500, payload={"message": "Search error"}))
        client = self.make_client(session)
        answer = client.ask_ai("Что сказано в документе университета?")
        self.assertEqual(answer, "Тестовый ответ")
        search_calls = [call for call in session.calls if call[0].endswith("/search")]
        model_calls = [call for call in session.calls if "generateContent" in call[0]]
        self.assertEqual(len(search_calls), 1)
        self.assertEqual(len(model_calls), 1)
        sent_payload = model_calls[0][1]["json"]
        self.assertNotIn("cachedContent", sent_payload)
        self.assertNotIn("data.json", json.dumps(sent_payload))

    def test_long_dialog_context_does_not_grow_unbounded(self):
        history = [
            {"role": "user" if i % 2 == 0 else "model", "text": "z" * 2000}
            for i in range(100)
        ]
        payload, stats = self.make_client().build_request("А что дальше?", history)
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertLessEqual(stats["history_messages"], 6)
        self.assertLessEqual(stats["history_chars"], 4000)
        self.assertLess(ai_service.estimate_tokens(serialized), 1500)

    def test_model_api_unavailable_returns_user_friendly_fallback(self):
        session = FakeSession(model_response=FakeResponse(status=503, payload={"error": {"message": "unavailable"}}))
        answer = self.make_client(session).ask_ai("Қазақша білесіңба?")
        self.assertIn("обратитесь к сотруднику", answer)
        self.assertNotIn("503", answer)


if __name__ == "__main__":
    unittest.main()
