import asyncio
import hashlib
import json
import logging
import os
import tempfile
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

import aiohttp
import websockets
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (CallbackQuery, FSInputFile, InlineKeyboardButton,
                           InlineKeyboardMarkup, KeyboardButton, Message,
                           ReplyKeyboardMarkup)
from dotenv import load_dotenv

from ai_service import Gemini
from admin_periods import LOCAL_TZ, period_bounds
from report_generator import build_usage_report
from bot_state import (
    AI_BUTTON,
    BACK_TO_AI_BUTTON,
    CONTROL_BUTTONS,
    END_SUPPORT_BUTTON,
    HELP_BUTTON,
    HUMAN_BUTTON,
    MENU_BUTTON,
    ModeCoordinator,
    UserMode,
    is_admin_id,
    is_own_contact,
)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
TOKEN = os.getenv("BOT_TOKEN")
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8004").rstrip("/")
BACKEND_WS_URL = os.getenv("BACKEND_WS_URL", "ws://127.0.0.1:8004").rstrip("/")
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN")
try:
    ADMIN_TELEGRAM_ID = int(os.getenv("ADMIN_TELEGRAM_ID", ""))
    if ADMIN_TELEGRAM_ID <= 0:
        raise ValueError
except ValueError:
    ADMIN_TELEGRAM_ID = None
    logger.error("ADMIN_CONFIG_ERROR | ADMIN_TELEGRAM_ID is missing or invalid")
if not INTERNAL_API_TOKEN:
    logger.error("INTERNAL_API_CONFIG_ERROR | INTERNAL_API_TOKEN is missing")

dp = Dispatcher()
bot = Bot(token=TOKEN)
ai_service = Gemini()
mode_coordinator = ModeCoordinator()
backend_session = None
backend_api_prefix = ""


def user_ref(user_id):
    return hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()[:12]


class ModeState(StatesGroup):
    unregistered = State()
    main_menu = State()
    ai_chat = State()
    waiting_operator = State()
    human_support = State()


STATE_BY_MODE = {
    UserMode.UNREGISTERED: ModeState.unregistered,
    UserMode.MAIN_MENU: ModeState.main_menu,
    UserMode.AI_CHAT: ModeState.ai_chat,
    UserMode.WAITING_FOR_OPERATOR: ModeState.waiting_operator,
    UserMode.HUMAN_SUPPORT: ModeState.human_support,
}

contact_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="📱 Поделиться номером телефона", request_contact=True)],
        [KeyboardButton(text=HELP_BUTTON)],
    ],
    resize_keyboard=True,
)

admin_keyboard = InlineKeyboardMarkup(inline_keyboard=[
    [InlineKeyboardButton(text="📊 Общая статистика", callback_data="admin:overview")],
    [InlineKeyboardButton(text="👥 Пользователи", callback_data="admin:users")],
    [InlineKeyboardButton(text="🤖 Использование ИИ", callback_data="admin:ai")],
    [InlineKeyboardButton(text="📅 Выбрать период", callback_data="admin:period")],
    [InlineKeyboardButton(text="📥 Скачать отчет", callback_data="admin:export")],
    [InlineKeyboardButton(text="🏠 Закрыть панель", callback_data="admin:close")],
])
period_keyboard = InlineKeyboardMarkup(inline_keyboard=[
    [InlineKeyboardButton(text="📅 Сегодня", callback_data="admin_period:today"),
     InlineKeyboardButton(text="📅 Вчера", callback_data="admin_period:yesterday")],
    [InlineKeyboardButton(text="📅 Последние 7 дней", callback_data="admin_period:7d"),
     InlineKeyboardButton(text="📅 Последние 30 дней", callback_data="admin_period:30d")],
    [InlineKeyboardButton(text="📅 Текущий месяц", callback_data="admin_period:month")],
    [InlineKeyboardButton(text="📅 За все время", callback_data="admin_period:all")],
    [InlineKeyboardButton(text="🗓 Произвольный период", callback_data="admin_period:custom")],
])
main_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text=AI_BUTTON)],
        [KeyboardButton(text=HUMAN_BUTTON)],
        [KeyboardButton(text=HELP_BUTTON)],
    ],
    resize_keyboard=True,
)
ai_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text=HUMAN_BUTTON)],
        [KeyboardButton(text=MENU_BUTTON)],
    ],
    resize_keyboard=True,
)
support_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text=BACK_TO_AI_BUTTON)],
        [KeyboardButton(text=MENU_BUTTON)],
        [KeyboardButton(text=END_SUPPORT_BUTTON)],
    ],
    resize_keyboard=True,
)


async def transition_mode(message, state, mode, event):
    async def persist(normalized):
        await state.set_state(STATE_BY_MODE[normalized])

    generation = await mode_coordinator.transition(message.from_user.id, mode, persist)
    logger.info(
        "MODE_CHANGE | user_ref=%s | mode=%s | generation=%d | event=%s",
        user_ref(message.from_user.id),
        UserMode(mode).value,
        generation,
        event,
    )
    return generation


async def backend_post(path, payload):
    if backend_session is None:
        return False, ""
    try:
        headers = {"x-internal-token": INTERNAL_API_TOKEN} if INTERNAL_API_TOKEN else {}
        async with backend_session.post(
            f"{BACKEND_URL}{backend_api_prefix}{path}", json=payload, headers=headers,
            timeout=aiohttp.ClientTimeout(total=30 if path.startswith("/internal/admin/") else 12)
        ) as response:
            text = await response.text()
            if response.status >= 400:
                error_hint = " ".join(text[:160].splitlines())
                logger.error(
                    "BACKEND_ERROR | path=%s | status=%d | body_hint=%r",
                    path,
                    response.status,
                    error_hint,
                )
                return False, ""
            return True, text
    except (aiohttp.ClientError, asyncio.TimeoutError) as error:
        logger.error("BACKEND_ERROR | path=%s | type=%s", path, type(error).__name__)
        return False, ""


async def backend_get(path):
    if backend_session is None or not INTERNAL_API_TOKEN:
        return False, None
    try:
        async with backend_session.get(
            f"{BACKEND_URL}{backend_api_prefix}{path}", headers={"x-internal-token": INTERNAL_API_TOKEN},
            timeout=aiohttp.ClientTimeout(total=12),
        ) as response:
            if response.status >= 400:
                error_hint = " ".join((await response.text())[:160].splitlines())
                logger.error(
                    "BACKEND_ERROR | path=%s | status=%d | body_hint=%r",
                    path.split("?")[0],
                    response.status,
                    error_hint,
                )
                return False, None
            return True, await response.json()
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
        logger.error("BACKEND_ERROR | path=%s | type=%s", path.split("?")[0], type(error).__name__)
        return False, None


async def get_registration(user_id):
    ok, payload = await backend_get(f"/internal/bot-user?telegramId={user_id}")
    return bool(ok and payload and payload.get("registered")), (payload or {}).get("user")


async def check_backend_contract():
    global backend_api_prefix
    for candidate in ("", "/api"):
        backend_api_prefix = candidate
        ok, payload = await backend_get("/internal/health")
        if ok and payload and payload.get("service") == "bot-backend" and payload.get("apiVersion") == 2:
            logger.info(
                "BACKEND_READY | api_version=%s | schema_target=%s | api_prefix=%r",
                payload.get("apiVersion"),
                payload.get("schemaTarget"),
                backend_api_prefix,
            )
            return True
    backend_api_prefix = ""
    if not ok or not payload:
        logger.critical(
            "BACKEND_CONTRACT_ERROR | expected_api_version=2 | backend_url=%s",
            BACKEND_URL,
        )
        return False
    compatible = payload.get("service") == "bot-backend" and payload.get("apiVersion") == 2
    if not compatible:
        logger.critical(
            "BACKEND_CONTRACT_ERROR | expected_api_version=2 | actual_api_version=%r",
            payload.get("apiVersion"),
        )
    return compatible


async def prompt_registration(message, state):
    await transition_mode(message, state, UserMode.UNREGISTERED, "registration_required")
    await message.answer(
        "👋 Добро пожаловать!\n\n"
        "Для использования ИИ-консультанта и связи с сотрудником необходимо пройти регистрацию.\n\n"
        "Нажмите кнопку ниже, чтобы поделиться номером телефона.\n\n"
        "Номер необходим для идентификации пользователя, учета обращений и ведения статистики использования сервиса.",
        reply_markup=contact_keyboard,
    )


async def require_registration(message, state):
    registered, user = await get_registration(message.from_user.id)
    if registered:
        await state.update_data(phone=user.get("phone"))
        return True
    await prompt_registration(message, state)
    return False


def is_admin(user_id):
    return is_admin_id(ADMIN_TELEGRAM_ID, user_id)


async def selected_period(state):
    data = await state.get_data()
    if data.get("admin_from") and data.get("admin_to"):
        return datetime.fromisoformat(data["admin_from"]), datetime.fromisoformat(data["admin_to"]), data["admin_label"]
    return period_bounds("30d")


async def analytics_request(action, state, **extra):
    start, end, label = await selected_period(state)
    ok, text = await backend_post("/internal/admin/analytics", {
        "action": action, "from": start.isoformat(), "to": end.isoformat(), **extra
    })
    if not ok:
        return None, label
    try:
        return json.loads(text).get("data"), label
    except (ValueError, AttributeError):
        return None, label


async def set_consultant_mode(user_id, enabled):
    return await backend_post(
        "/consultant-mode", {"studentId": user_id, "enabled": enabled}
    )


async def show_main_menu(message, state, event="menu"):
    if not await require_registration(message, state):
        return
    await transition_mode(message, state, UserMode.MAIN_MENU, event)
    await set_consultant_mode(message.from_user.id, False)
    await message.answer("🏠 Главное меню. Выберите режим общения.", reply_markup=main_keyboard)


# Global commands are intentionally registered before all state-specific text handlers.
@dp.message(CommandStart())
async def start(message: Message, state: FSMContext):
    logger.info("USER_START | user_ref=%s", user_ref(message.from_user.id))
    registered, user = await get_registration(message.from_user.id)
    if not registered:
        await prompt_registration(message, state)
        return
    await state.update_data(phone=user.get("phone"))
    await transition_mode(message, state, UserMode.MAIN_MENU, "start")
    await set_consultant_mode(message.from_user.id, False)
    await message.answer("👋 Добро пожаловать! Выберите режим общения.", reply_markup=main_keyboard)


@dp.message(Command("menu"))
@dp.message(F.text.in_({MENU_BUTTON, "Выход"}))
async def menu_command(message: Message, state: FSMContext):
    await show_main_menu(message, state)


@dp.message(Command("cancel"))
@dp.message(F.text.in_({END_SUPPORT_BUTTON, "Выход из режима общения с сотрудником"}))
async def cancel_command(message: Message, state: FSMContext):
    if not await require_registration(message, state):
        return
    await transition_mode(message, state, UserMode.MAIN_MENU, "cancel")
    await set_consultant_mode(message.from_user.id, False)
    await backend_post("/internal/support/request", {"telegramId": message.from_user.id, "action": "update", "status": "closed"})
    logger.info("SUPPORT_END | user_ref=%s", user_ref(message.from_user.id))
    await message.answer("Обращение завершено. Выберите режим общения.", reply_markup=main_keyboard)


@dp.message(Command("help"))
@dp.message(F.text == HELP_BUTTON)
async def help_command(message: Message):
    await message.answer(
        "ℹ️ Выберите ИИ-консультанта для быстрого ответа или связь с сотрудником для живого общения. "
        "Кнопка «Главное меню» доступна в каждом режиме."
    )


@dp.message(Command("admin"))
async def admin_command(message: Message):
    if not is_admin(message.from_user.id):
        logger.warning("ADMIN_ACCESS_DENIED | user_ref=%s", user_ref(message.from_user.id))
        await message.answer("Команда недоступна.")
        return
    await message.answer(
        "🔐 Панель администратора\n\nВыберите раздел для просмотра статистики.",
        reply_markup=admin_keyboard,
    )


@dp.message(Command("admin_period"))
async def custom_admin_period(message: Message, state: FSMContext):
    if not is_admin(message.from_user.id):
        await message.answer("Команда недоступна.")
        return
    parts = (message.text or "").split()
    if len(parts) != 3:
        await message.answer("Укажите период так: /admin_period 01.11.2026 30.11.2026")
        return
    try:
        start_date = datetime.strptime(parts[1], "%d.%m.%Y").date()
        end_date = datetime.strptime(parts[2], "%d.%m.%Y").date()
        if start_date > end_date:
            raise ValueError
        start = datetime.combine(start_date, time.min, LOCAL_TZ).astimezone(timezone.utc)
        end = datetime.combine(end_date + timedelta(days=1), time.min, LOCAL_TZ).astimezone(timezone.utc)
    except ValueError:
        await message.answer("Некорректный период. Используйте даты ДД.ММ.ГГГГ, начало не позже конца.")
        return
    label = f"{start_date:%d.%m.%Y}–{end_date:%d.%m.%Y}"
    await state.update_data(admin_from=start.isoformat(), admin_to=end.isoformat(), admin_label=label)
    await message.answer(f"Выбран период: {label}", reply_markup=admin_keyboard)


@dp.message(Command("admin_user"))
async def admin_user_search(message: Message, state: FSMContext):
    if not is_admin(message.from_user.id):
        await message.answer("Команда недоступна.")
        return
    query = (message.text or "").partition(" ")[2].strip()
    if not query:
        await message.answer("Укажите Telegram ID, телефон или username: /admin_user 123456789")
        return
    rows, label = await analytics_request("users", state, search=query, limit=10, offset=0)
    if rows is None:
        await message.answer("Не удалось выполнить поиск.")
        return
    if not rows:
        await message.answer("Пользователь не найден.")
        return
    lines = [f"👤 Результаты поиска\nПериод: {label}"]
    for row in rows:
        lines.append(
            f"\nTelegram ID: {row.get('telegram_id')}\n"
            f"Имя: {row.get('full_name') or 'не указано'}\n"
            f"Username: @{row.get('username') or 'не указан'}\n"
            f"Телефон: {row.get('phone')}\n"
            f"AI-запросы: {metric(row.get('ai_requests'))}, успешные: {metric(row.get('successful_requests'))}, ошибки: {metric(row.get('failed_requests'))}\n"
            f"Токены: {metric(row.get('total_tokens'))}, среднее время: {metric(row.get('avg_duration_ms'))} мс\n"
            f"Обращения к сотрудникам: {metric(row.get('support_requests'))}"
        )
    await message.answer("\n".join(lines), reply_markup=admin_keyboard)


def metric(value):
    if value is None:
        return "нет данных"
    try:
        number = float(value)
        return f"{number:,.1f}" if not number.is_integer() else f"{int(number):,}"
    except (TypeError, ValueError):
        return str(value)


@dp.callback_query(F.data.startswith("admin:"))
async def admin_callback(callback: CallbackQuery, state: FSMContext):
    if not is_admin(callback.from_user.id):
        logger.warning("ADMIN_CALLBACK_DENIED | user_ref=%s", user_ref(callback.from_user.id))
        await callback.answer("Доступ запрещен", show_alert=True)
        return
    await callback.answer()
    action = callback.data.split(":", 1)[1]
    if action == "close":
        await callback.message.edit_text("Панель администратора закрыта.")
        return
    if action == "period":
        await callback.message.answer("Выберите период.", reply_markup=period_keyboard)
        return
    if action in {"overview", "ai"}:
        data, label = await analytics_request("overview", state)
        if data is None:
            await callback.message.answer("Не удалось получить статистику.")
            return
        tracking = data.get("tracking_started_at") or "учет еще не начат"
        if action == "overview":
            text = (
                f"📊 Общая статистика\nПериод: {label}\n\n"
                f"Зарегистрировано: {metric(data.get('registered_users'))}\n"
                f"Новых пользователей: {metric(data.get('new_users'))}\n"
                f"Активных пользователей: {metric(data.get('active_users'))}\n"
                f"Пользователей ИИ: {metric(data.get('ai_users'))}\n"
                f"Пользователей поддержки: {metric(data.get('support_users'))}\n"
                f"Обращений к сотрудникам: {metric(data.get('support_requests'))}\n\n"
                f"Достоверный учет AI: {tracking}"
            )
        else:
            text = (
                f"🤖 Использование ИИ\nПериод: {label}\n\n"
                f"Запросов: {metric(data.get('ai_requests'))}\n"
                f"Успешных: {metric(data.get('successful_requests'))}\n"
                f"Ошибок/отмен: {metric(data.get('failed_requests'))}\n"
                f"Всего токенов: {metric(data.get('total_tokens'))}\n"
                f"Среднее токенов: {metric(data.get('avg_tokens'))}\n"
                f"Общее время, мс: {metric(data.get('total_duration_ms'))}\n"
                f"Среднее время, мс: {metric(data.get('avg_duration_ms'))}"
            )
        await callback.message.answer(text, reply_markup=admin_keyboard)
        return
    if action == "users":
        rows, label = await analytics_request("users", state, limit=10, offset=0)
        if rows is None:
            await callback.message.answer("Не удалось получить список пользователей.")
            return
        lines = [f"👥 Пользователи\nПериод: {label}"]
        for row in rows:
            lines.append(f"\n{row.get('telegram_id')} · @{row.get('username') or 'без username'}\nAI: {metric(row.get('ai_requests'))}, токены: {metric(row.get('total_tokens'))}, поддержка: {metric(row.get('support_requests'))}")
        if not rows:
            lines.append("\nНет зарегистрированных пользователей.")
        else:
            lines.append("\nПоиск: /admin_user Telegram_ID, телефон или username")
        await callback.message.answer("\n".join(lines), reply_markup=admin_keyboard)
        return
    if action == "export":
        report_data, label = await analytics_request("report", state)
        if report_data is None:
            await callback.message.answer("Не удалось подготовить отчет.")
            return
        start, end, _ = await selected_period(state)
        filename = f"ai_usage_report_{start.astimezone(LOCAL_TZ):%Y-%m-%d}_{(end.astimezone(LOCAL_TZ)-timedelta(days=1)):%Y-%m-%d}.xlsx"
        temp_path = Path(tempfile.gettempdir()) / f"{callback.from_user.id}_{filename}"
        try:
            await asyncio.to_thread(build_usage_report, report_data, label, temp_path)
            if temp_path.stat().st_size > 49 * 1024 * 1024:
                await callback.message.answer("Отчет превышает допустимый размер Telegram. Выберите меньший период.")
                return
            await callback.message.answer_document(FSInputFile(temp_path, filename=filename), caption=f"Отчет за период {label}")
            logger.info("ADMIN_REPORT_SENT | admin_ref=%s | bytes=%d", user_ref(callback.from_user.id), temp_path.stat().st_size)
        finally:
            temp_path.unlink(missing_ok=True)


@dp.callback_query(F.data.startswith("admin_period:"))
async def admin_period_callback(callback: CallbackQuery, state: FSMContext):
    if not is_admin(callback.from_user.id):
        await callback.answer("Доступ запрещен", show_alert=True)
        return
    kind = callback.data.split(":", 1)[1]
    if kind == "custom":
        await callback.answer()
        await callback.message.answer("Укажите даты командой: /admin_period 01.11.2026 30.11.2026")
        return
    try:
        start, end, label = period_bounds(kind)
    except ValueError:
        await callback.answer("Некорректный период", show_alert=True)
        return
    await state.update_data(admin_from=start.isoformat(), admin_to=end.isoformat(), admin_label=label)
    await callback.answer(f"Период: {label}")
    await callback.message.answer(f"Выбран период: {label}", reply_markup=admin_keyboard)


@dp.message(F.contact)
async def get_contact(message: Message, state: FSMContext):
    contact = message.contact
    if not contact or not is_own_contact(contact.user_id, message.from_user.id):
        logger.warning("REGISTRATION_REJECTED | user_ref=%s | reason=foreign_contact", user_ref(message.from_user.id))
        await message.answer("Отправьте именно свой контакт кнопкой ниже. Чужой контакт зарегистрировать нельзя.", reply_markup=contact_keyboard)
        return
    ok, text = await backend_post("/internal/bot-user/register", {
        "telegramId": message.from_user.id,
        "phone": contact.phone_number,
        "username": message.from_user.username,
        "fullName": message.from_user.full_name,
        "firstName": message.from_user.first_name,
        "lastName": message.from_user.last_name,
    })
    if not ok:
        await message.answer("Не удалось сохранить регистрацию. Попробуйте ещё раз позже.", reply_markup=contact_keyboard)
        return
    try:
        saved = json.loads(text).get("user")
    except (ValueError, AttributeError):
        saved = None
    if not saved or not saved.get("phone_verified"):
        await message.answer("Регистрация не подтверждена. Попробуйте ещё раз.", reply_markup=contact_keyboard)
        return
    await state.update_data(phone=saved.get("phone"))
    await transition_mode(message, state, UserMode.MAIN_MENU, "registration_complete")
    logger.info("REGISTRATION_COMPLETED | user_ref=%s", user_ref(message.from_user.id))
    await message.answer("Регистрация завершена. Теперь выберите режим общения.", reply_markup=main_keyboard)


@dp.message(F.text.in_({AI_BUTTON, BACK_TO_AI_BUTTON, "Режим ИИ"}))
async def enter_ai_mode(message: Message, state: FSMContext):
    if not await require_registration(message, state):
        return
    current_mode, _ = await mode_coordinator.snapshot(message.from_user.id)
    if current_mode is UserMode.AI_CHAT:
        await message.answer("🤖 Вы уже общаетесь с ИИ-консультантом.", reply_markup=ai_keyboard)
        return
    await transition_mode(message, state, UserMode.AI_CHAT, "ai_button")
    await set_consultant_mode(message.from_user.id, False)
    await message.answer(
        "🤖 Вы общаетесь с ИИ-консультантом. Задайте интересующий вас вопрос.\n\n"
        "Если хотите поговорить с реальным сотрудником, нажмите кнопку ниже.",
        reply_markup=ai_keyboard,
    )


@dp.message(F.text.in_({HUMAN_BUTTON, "Связаться с сотрудником"}))
async def enter_support_mode(message: Message, state: FSMContext):
    if not await require_registration(message, state):
        return
    current_mode, _ = await mode_coordinator.snapshot(message.from_user.id)
    if current_mode in {UserMode.WAITING_FOR_OPERATOR, UserMode.HUMAN_SUPPORT}:
        await message.answer("👨‍💼 Обращение уже открыто. Ожидайте ответа сотрудника.", reply_markup=support_keyboard)
        return
    await transition_mode(message, state, UserMode.WAITING_FOR_OPERATOR, "support_button")
    ok, _ = await set_consultant_mode(message.from_user.id, True)
    if ok:
        await backend_post("/internal/support/request", {"telegramId": message.from_user.id, "action": "open"})
    logger.info("SUPPORT_REQUEST | user_ref=%s | backend_ok=%s", user_ref(message.from_user.id), ok)
    if ok:
        text = "👨‍💼 Вы перешли в режим связи с сотрудником. Оператор ещё не подключился; можете оставить сообщение."
    else:
        text = "Сервис сотрудников временно недоступен. Вы можете вернуться к ИИ и попробовать позже."
    await message.answer(text, reply_markup=support_keyboard)


@dp.message(ModeState.ai_chat, F.text, ~F.text.in_(CONTROL_BUTTONS))
async def process_ai(message: Message, state: FSMContext):
    if not await require_registration(message, state):
        return
    user_id = message.from_user.id
    current_mode, generation = await mode_coordinator.snapshot(user_id)
    if current_mode is not UserMode.AI_CHAT:
        logger.info("AI_REQUEST_SKIPPED | user_ref=%s | reason=mode_mismatch", user_ref(user_id))
        return
    data = await state.get_data()
    history = data.get("ai_history", [])
    logger.info("AI_REQUEST_STARTED | user_ref=%s | generation=%d", user_ref(user_id), generation)
    response, usage_record = await asyncio.to_thread(
        ai_service.ask_ai_detailed,
        message.text,
        {"source": "telegram"},
        history,
    )
    if not await mode_coordinator.is_current(user_id, UserMode.AI_CHAT, generation):
        usage_record["status"] = "ignored"
        usage_record["telegramId"] = user_id
        await backend_post("/internal/ai/usage", usage_record)
        logger.info("AI_RESPONSE_IGNORED | user_ref=%s | generation=%d", user_ref(user_id), generation)
        return

    usage_record["telegramId"] = user_id
    await backend_post("/internal/ai/usage", usage_record)

    history.extend([
        {"role": "user", "text": message.text},
        {"role": "model", "text": response},
    ])
    await state.update_data(ai_history=history[-12:])
    await backend_post(
        "/ai/message",
        {
            "telegramId": user_id,
            "username": message.from_user.username,
            "fullName": message.from_user.full_name,
            "phone": data.get("phone"),
            "userMessage": message.text,
            "assistantMessage": response,
        },
    )
    if await mode_coordinator.is_current(user_id, UserMode.AI_CHAT, generation):
        await message.answer(response, reply_markup=ai_keyboard)
        logger.info("AI_RESPONSE_SENT | user_ref=%s | generation=%d", user_ref(user_id), generation)


@dp.message(StateFilter(ModeState.waiting_operator, ModeState.human_support), F.text, ~F.text.in_(CONTROL_BUTTONS))
async def connect_chat(message: Message, state: FSMContext):
    if not await require_registration(message, state):
        return
    mode, _ = await mode_coordinator.snapshot(message.from_user.id)
    if mode not in {UserMode.WAITING_FOR_OPERATOR, UserMode.HUMAN_SUPPORT}:
        return
    data = await state.get_data()
    ok, _ = await backend_post(
        "/message",
        {
            "studentId": message.from_user.id,
            "phone": data.get("phone"),
            "studentName": message.from_user.username,
            "text": message.text,
        },
    )
    if ok:
        await message.answer("Сообщение отправлено сотруднику.", reply_markup=support_keyboard)
    else:
        await message.answer("Не удалось отправить сообщение. Попробуйте позже или вернитесь к ИИ.", reply_markup=support_keyboard)


@dp.message(StateFilter(ModeState.waiting_operator, ModeState.human_support))
async def support_non_text(message: Message):
    await message.answer("Пожалуйста, отправьте сотруднику текстовое сообщение.", reply_markup=support_keyboard)


@dp.message()
async def unknown_or_menu_message(message: Message, state: FSMContext):
    await show_main_menu(message, state, "unknown_state")


async def websocket_listener():
    while True:
        try:
            async with websockets.connect(BACKEND_WS_URL) as websocket:
                await websocket.send(json.dumps({"type": "bot"}))
                logger.info("OPERATOR_WS_CONNECTED")
                async for raw_message in websocket:
                    data = json.loads(raw_message)
                    if data.get("type") != "employee_message":
                        continue
                    user_id = int(data["telegramId"])
                    mode, _ = await mode_coordinator.snapshot(user_id)
                    if mode not in {UserMode.WAITING_FOR_OPERATOR, UserMode.HUMAN_SUPPORT}:
                        logger.info("OPERATOR_MESSAGE_IGNORED | user_ref=%s | mode=%s", user_ref(user_id), mode.value)
                        continue
                    context = dp.fsm.get_context(bot=bot, chat_id=user_id, user_id=user_id)
                    if mode is UserMode.WAITING_FOR_OPERATOR:
                        async def persist(normalized):
                            await context.set_state(STATE_BY_MODE[normalized])
                        await mode_coordinator.transition(user_id, UserMode.HUMAN_SUPPORT, persist)
                        await backend_post("/internal/support/request", {"telegramId": user_id, "action": "update", "status": "active"})
                        logger.info("OPERATOR_CONNECTED | user_ref=%s", user_ref(user_id))
                        await bot.send_message(user_id, "👨‍💼 Сотрудник подключился к обращению.", reply_markup=support_keyboard)
                    await bot.send_message(user_id, data.get("text", ""), reply_markup=support_keyboard)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.error("OPERATOR_WS_ERROR | type=%s", type(error).__name__)
            await asyncio.sleep(5)


async def main():
    global backend_session
    backend_session = aiohttp.ClientSession()
    await check_backend_contract()
    websocket_task = asyncio.create_task(websocket_listener())
    try:
        await dp.start_polling(bot)
    finally:
        websocket_task.cancel()
        await asyncio.gather(websocket_task, return_exceptions=True)
        await backend_session.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
