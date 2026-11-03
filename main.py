import asyncio
import json
import logging
import os

import aiohttp
import websockets
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import KeyboardButton, Message, ReplyKeyboardMarkup
from dotenv import load_dotenv

from ai_service import Gemini
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
)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
TOKEN = os.getenv("BOT_TOKEN")
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8004")
BACKEND_WS_URL = os.getenv("BACKEND_WS_URL", "ws://127.0.0.1:8004")

dp = Dispatcher()
bot = Bot(token=TOKEN)
ai_service = Gemini()
mode_coordinator = ModeCoordinator()
backend_session = None


class ModeState(StatesGroup):
    main_menu = State()
    ai_chat = State()
    waiting_operator = State()
    human_support = State()


STATE_BY_MODE = {
    UserMode.MAIN_MENU: ModeState.main_menu,
    UserMode.AI_CHAT: ModeState.ai_chat,
    UserMode.WAITING_FOR_OPERATOR: ModeState.waiting_operator,
    UserMode.HUMAN_SUPPORT: ModeState.human_support,
}

contact_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="📱 Отправить номер телефона", request_contact=True)],
        [KeyboardButton(text=AI_BUTTON)],
        [KeyboardButton(text=HUMAN_BUTTON)],
        [KeyboardButton(text=HELP_BUTTON)],
    ],
    resize_keyboard=True,
)
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
        "MODE_CHANGE | user_id=%s | mode=%s | generation=%d | event=%s",
        message.from_user.id,
        UserMode(mode).value,
        generation,
        event,
    )
    return generation


async def backend_post(path, payload):
    if backend_session is None:
        return False, ""
    try:
        async with backend_session.post(
            f"{BACKEND_URL}{path}", json=payload, timeout=aiohttp.ClientTimeout(total=12)
        ) as response:
            text = await response.text()
            if response.status >= 400:
                logger.error("BACKEND_ERROR | path=%s | status=%d", path, response.status)
                return False, ""
            return True, text
    except (aiohttp.ClientError, asyncio.TimeoutError) as error:
        logger.error("BACKEND_ERROR | path=%s | type=%s", path, type(error).__name__)
        return False, ""


async def set_consultant_mode(user_id, enabled):
    return await backend_post(
        "/consultant-mode", {"studentId": user_id, "enabled": enabled}
    )


async def show_main_menu(message, state, event="menu"):
    await transition_mode(message, state, UserMode.MAIN_MENU, event)
    await set_consultant_mode(message.from_user.id, False)
    await message.answer("🏠 Главное меню. Выберите режим общения.", reply_markup=main_keyboard)


# Global commands are intentionally registered before all state-specific text handlers.
@dp.message(CommandStart())
async def start(message: Message, state: FSMContext):
    await transition_mode(message, state, UserMode.MAIN_MENU, "start")
    await set_consultant_mode(message.from_user.id, False)
    logger.info("USER_START | user_id=%s", message.from_user.id)
    data = await state.get_data()
    keyboard = main_keyboard if data.get("phone") else contact_keyboard
    await message.answer(
        "Здравствуйте! Я помогу с вопросами академической мобильности. Выберите режим ниже.",
        reply_markup=keyboard,
    )


@dp.message(Command("menu"))
@dp.message(F.text.in_({MENU_BUTTON, "Выход"}))
async def menu_command(message: Message, state: FSMContext):
    await show_main_menu(message, state)


@dp.message(Command("cancel"))
@dp.message(F.text.in_({END_SUPPORT_BUTTON, "Выход из режима общения с сотрудником"}))
async def cancel_command(message: Message, state: FSMContext):
    await transition_mode(message, state, UserMode.MAIN_MENU, "cancel")
    await set_consultant_mode(message.from_user.id, False)
    logger.info("SUPPORT_END | user_id=%s", message.from_user.id)
    await message.answer("Обращение завершено. Выберите режим общения.", reply_markup=main_keyboard)


@dp.message(Command("help"))
@dp.message(F.text == HELP_BUTTON)
async def help_command(message: Message):
    await message.answer(
        "ℹ️ Выберите ИИ-консультанта для быстрого ответа или связь с сотрудником для живого общения. "
        "Кнопка «Главное меню» доступна в каждом режиме."
    )


@dp.message(F.contact)
async def get_contact(message: Message, state: FSMContext):
    phone = message.contact.phone_number
    await state.update_data(phone=phone)
    await message.answer("Номер сохранён. Теперь выберите режим общения.", reply_markup=main_keyboard)


@dp.message(F.text.in_({AI_BUTTON, BACK_TO_AI_BUTTON, "Режим ИИ"}))
async def enter_ai_mode(message: Message, state: FSMContext):
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
    current_mode, _ = await mode_coordinator.snapshot(message.from_user.id)
    if current_mode in {UserMode.WAITING_FOR_OPERATOR, UserMode.HUMAN_SUPPORT}:
        await message.answer("👨‍💼 Обращение уже открыто. Ожидайте ответа сотрудника.", reply_markup=support_keyboard)
        return
    await transition_mode(message, state, UserMode.WAITING_FOR_OPERATOR, "support_button")
    ok, _ = await set_consultant_mode(message.from_user.id, True)
    logger.info("SUPPORT_REQUEST | user_id=%s | backend_ok=%s", message.from_user.id, ok)
    if ok:
        text = "👨‍💼 Вы перешли в режим связи с сотрудником. Оператор ещё не подключился; можете оставить сообщение."
    else:
        text = "Сервис сотрудников временно недоступен. Вы можете вернуться к ИИ и попробовать позже."
    await message.answer(text, reply_markup=support_keyboard)


@dp.message(ModeState.ai_chat, F.text, ~F.text.in_(CONTROL_BUTTONS))
async def process_ai(message: Message, state: FSMContext):
    user_id = message.from_user.id
    current_mode, generation = await mode_coordinator.snapshot(user_id)
    if current_mode is not UserMode.AI_CHAT:
        logger.info("AI_REQUEST_SKIPPED | user_id=%s | reason=mode_mismatch", user_id)
        return
    data = await state.get_data()
    history = data.get("ai_history", [])
    logger.info("AI_REQUEST_STARTED | user_id=%s | generation=%d", user_id, generation)
    response = await asyncio.to_thread(
        ai_service.ask_ai,
        message.text,
        {"source": "telegram"},
        history,
    )
    if not await mode_coordinator.is_current(user_id, UserMode.AI_CHAT, generation):
        logger.info("AI_RESPONSE_IGNORED | user_id=%s | generation=%d", user_id, generation)
        return

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
        logger.info("AI_RESPONSE_SENT | user_id=%s | generation=%d", user_id, generation)


@dp.message(StateFilter(ModeState.waiting_operator, ModeState.human_support), F.text, ~F.text.in_(CONTROL_BUTTONS))
async def connect_chat(message: Message, state: FSMContext):
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
                        logger.info("OPERATOR_MESSAGE_IGNORED | user_id=%s | mode=%s", user_id, mode.value)
                        continue
                    context = dp.fsm.get_context(bot=bot, chat_id=user_id, user_id=user_id)
                    if mode is UserMode.WAITING_FOR_OPERATOR:
                        async def persist(normalized):
                            await context.set_state(STATE_BY_MODE[normalized])
                        await mode_coordinator.transition(user_id, UserMode.HUMAN_SUPPORT, persist)
                        logger.info("OPERATOR_CONNECTED | user_id=%s", user_id)
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
