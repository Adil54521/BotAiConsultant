import asyncio
import uuid
from enum import Enum


class UserMode(str, Enum):
    UNREGISTERED = "unregistered"
    MAIN_MENU = "main_menu"
    AI_CHAT = "ai_chat"
    WAITING_FOR_OPERATOR = "waiting_for_operator"
    HUMAN_SUPPORT = "human_support"


AI_BUTTON = "🤖 ИИ-консультант"
HUMAN_BUTTON = "👨‍💼 Связаться с сотрудником"
HELP_BUTTON = "ℹ️ Помощь"
MENU_BUTTON = "🏠 Главное меню"
BACK_TO_AI_BUTTON = "🤖 Вернуться к ИИ"
END_SUPPORT_BUTTON = "❌ Завершить обращение"

CONTROL_BUTTONS = frozenset({
    AI_BUTTON,
    HUMAN_BUTTON,
    HELP_BUTTON,
    MENU_BUTTON,
    BACK_TO_AI_BUTTON,
    END_SUPPORT_BUTTON,
    # Backward compatibility with keyboards already visible in Telegram.
    "Режим ИИ",
    "Связаться с сотрудником",
    "Выход",
    "Выход из режима общения с сотрудником",
})
CONTROL_COMMANDS = frozenset({"/start", "/menu", "/help", "/cancel", "/admin", "/admin_period", "/admin_user"})
AI_REQUEST_NAMESPACE = uuid.UUID("7c6f6d43-5c48-4f75-8617-1e4543f31240")


def telegram_request_id(user_id, message_id):
    """Stable UUID used to deduplicate a Telegram message across restarts/instances."""
    return str(uuid.uuid5(AI_REQUEST_NAMESPACE, f"telegram:{int(user_id)}:{int(message_id)}"))


def normalize_command(text):
    value = (text or "").strip().split(maxsplit=1)[0].lower()
    return value.split("@", maxsplit=1)[0]


def is_control_message(text):
    value = (text or "").strip()
    return value in CONTROL_BUTTONS or normalize_command(value) in CONTROL_COMMANDS


def is_own_contact(contact_user_id, sender_user_id):
    return contact_user_id is not None and contact_user_id == sender_user_id


def is_admin_id(configured_admin_id, sender_user_id):
    return configured_admin_id is not None and configured_admin_id == sender_user_id


def route_text(mode, text):
    """Pure routing rule used both by handlers and concurrency tests."""
    if is_control_message(text):
        return "control"
    try:
        normalized = UserMode(mode)
    except (ValueError, TypeError):
        return "menu"
    if normalized is UserMode.AI_CHAT:
        return "ai"
    if normalized in {UserMode.WAITING_FOR_OPERATOR, UserMode.HUMAN_SUPPORT}:
        return "support"
    return "menu"


class ModeCoordinator:
    """Per-user atomic mode and AI-generation coordination."""

    def __init__(self):
        self._modes = {}
        self._generations = {}
        self._locks = {}

    def _lock(self, user_id):
        return self._locks.setdefault(user_id, asyncio.Lock())

    async def transition(self, user_id, mode, persist=None):
        try:
            normalized = UserMode(mode)
        except (ValueError, TypeError):
            normalized = UserMode.MAIN_MENU
        async with self._lock(user_id):
            generation = self._generations.get(user_id, 0) + 1
            self._generations[user_id] = generation
            self._modes[user_id] = normalized
            if persist is not None:
                await persist(normalized)
            return generation

    async def snapshot(self, user_id):
        async with self._lock(user_id):
            return (
                self._modes.get(user_id, UserMode.MAIN_MENU),
                self._generations.get(user_id, 0),
            )

    async def is_current(self, user_id, mode, generation):
        async with self._lock(user_id):
            return (
                self._modes.get(user_id, UserMode.MAIN_MENU) == UserMode(mode)
                and self._generations.get(user_id, 0) == generation
            )
