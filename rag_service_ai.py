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

path_env = os.path.join("C:\\BotAiConsultant", ".env")
load_dotenv(path_env)

class RagServiceAi:
        def __init__(self):
            self.api_key = os.getenv("GEMINI_API_KEY")
            self.base_url = "https://generativelanguage.googleapis.com/v1beta"
            self.model = "models/gemini-3.5-flash"
            self.cache_name = None

        def create_cache(self):
            try:
                with open('links.json', 'r', encoding='utf-8') as f:
                    data = json.load(f)

                url = f"{self.base_url}/cachedContents?key={self.api_key}"

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

                response = requests.post(url, json=payload)
                response.raise_for_status()

                self.cache_name = response.json()["name"]

                ai_logger.info(f"CACHE_CREATED | name={self.cache_name}")

            except Exception as e:
                ai_logger.error(f"CACHE_ERROR | {e}")

        def ask(self, user_input: str, user_meta: dict | None = None) -> str:

            if not self.cache_name:
                return "Ошибка: Кэш данных не инициализирован."

            meta = user_meta or {}

            try:
                url = f"{self.base_url}/{self.model}:generateContent?key={self.api_key}"
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
                    f"AI_REQUEST | {meta} | text={user_input[:300]}"
                )

                response = requests.post(url, json=payload)
                print(response.text)

                if response.status_code == 403:
                    self.create_cache()
                    payload["cachedContent"] = self.cache_name
                    response = requests.post(url, json=payload)

                response.raise_for_status()

                data = response.json()

                # ---------- USAGE TOKENS ----------
                usage = data.get("usageMetadata", {})

                ai_logger.info(f"AI_USAGE | {meta} | {usage}")

                # ---------- RESPONSE TEXT ----------
                answer = data["candidates"][0]["content"]["parts"][0]["text"]

                ai_logger.info(
                    f"AI_RESPONSE | {meta} | text={answer[:500]}"
                )

                return answer

            except Exception as e:

                ai_logger.error(f"AI_ERROR | {meta} | {e}")

                return "Ошибка при получении ответа."

if __name__ == "__main__":
    service = RagServiceAi()
    service.create_cache()

    while True:
        q = input("Вопрос: ")

        print(service.ask(q, user_meta={"source": "console"}))