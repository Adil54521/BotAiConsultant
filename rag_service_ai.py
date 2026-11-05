import os
import json
import requests
from dotenv import load_dotenv
import logging
from logging.handlers import RotatingFileHandler

ai_logger = logging.getLogger("ai_usage")
ai_logger.setLevel(logging.INFO)

if not ai_logger.handlers:
    handler = RotatingFileHandler(
        "ai_usage.log",
        maxBytes=5_000_000,
        backupCount=5,
        encoding="utf-8"
    )

    formatter = logging.Formatter("%(asctime)s | %(message)s")

    handler.setFormatter(formatter)
    ai_logger.addHandler(handler)

path_env = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(path_env)

class RagServiceAi:
        def __init__(self):
            self.api_key = os.getenv("GEMINI_API_KEY")
            self.base_url = "https://generativelanguage.googleapis.com/v1beta"
            self.model = os.getenv("GEMINI_MODEL", "models/gemini-3.5-flash-lite")
            self.cache_name = None

        def _headers(self):
            return {"Content-Type": "application/json", "x-goog-api-key": self.api_key}

        def create_cache(self):
            try:
                with open('links.json', 'r', encoding='utf-8') as f:
                    data = json.load(f)

                url = f"{self.base_url}/cachedContents"

                payload = {
                    "model": self.model,
                    "displayName": "university_data",
                    "contents": [
                        {
                            "role": "user",
                            "parts": [{
                                "text": f"Используй эти данные: {json.dumps(data, ensure_ascii=False)}"
                            }]
                        }
                    ],
                    "ttl": "3600s"
                }

                response = requests.post(url, headers=self._headers(), json=payload, timeout=30)
                response.raise_for_status()

                self.cache_name = response.json()["name"]

                ai_logger.info(f"CACHE_CREATED | name={self.cache_name}")

            except Exception as e:
                ai_logger.error("CACHE_ERROR | type=%s", type(e).__name__)

        def ask(self, user_input: str, user_meta: dict | None = None) -> str:

            if not self.cache_name:
                return "Ошибка: Кэш данных не инициализирован."

            meta = user_meta or {}

            try:
                url = f"{self.base_url}/{self.model}:generateContent"
                payload = {
                    "cachedContent": self.cache_name,
                    "generationConfig": {
                        "temperature": 0.2,
                        "topP": 0.9,
                        "topK": 40
                    },
                    "contents": [
                        {
                            "role": "user",
                            "parts": [{
                                "text": (
                                    "Ты — консультант отдела академической мобильности."
                                    "Используй информацию из кэша."
                                    "Отвечай только по теме поступления."
                                    f"Вопрос: {user_input}"
                                )
                            }]
                        }
                    ]
                }

                # ---------- REQUEST LOG ----------
                ai_logger.info(
                    "AI_REQUEST | source=legacy_rag | chars=%d",
                    len(user_input),
                )

                response = requests.post(url, headers=self._headers(), json=payload, timeout=60)

                response.raise_for_status()

                data = response.json()

                # ---------- USAGE TOKENS ----------
                usage = data.get("usageMetadata", {})

                ai_logger.info("AI_USAGE | source=legacy_rag | %s", usage)

                # ---------- RESPONSE TEXT ----------
                answer = data["candidates"][0]["content"]["parts"][0]["text"]

                ai_logger.info(
                    "AI_RESPONSE | source=legacy_rag | chars=%d",
                    len(answer),
                )

                return answer

            except Exception as e:

                ai_logger.error("AI_ERROR | source=legacy_rag | type=%s", type(e).__name__)

                return "Ошибка при получении ответа."

if __name__ == "__main__":
    if os.getenv("ENABLE_AI_CONSOLE") != "1":
        raise SystemExit("AI console is disabled. Set ENABLE_AI_CONSOLE=1 for explicit manual use.")
    service = RagServiceAi()
    service.create_cache()

    while True:
        q = input("Вопрос: ")

        print(service.ask(q, user_meta={"source": "console"}))
