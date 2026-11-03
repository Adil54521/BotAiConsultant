import asyncio
import unittest

from bot_state import (
    AI_BUTTON,
    BACK_TO_AI_BUTTON,
    HUMAN_BUTTON,
    ModeCoordinator,
    UserMode,
    route_text,
)


class BotModeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.modes = ModeCoordinator()

    async def test_scenario_1_ai_question_routes_to_ai(self):
        await self.modes.transition(1, UserMode.AI_CHAT)
        mode, _ = await self.modes.snapshot(1)
        self.assertEqual(route_text(mode, "Как подать документы?"), "ai")

    async def test_scenario_2_support_button_is_control_not_ai(self):
        await self.modes.transition(1, UserMode.AI_CHAT)
        mode, _ = await self.modes.snapshot(1)
        self.assertEqual(route_text(mode, HUMAN_BUTTON), "control")
        await self.modes.transition(1, UserMode.WAITING_FOR_OPERATOR)
        mode, _ = await self.modes.snapshot(1)
        self.assertEqual(route_text(mode, "Сообщение сотруднику"), "support")

    async def test_scenario_3_return_to_ai(self):
        await self.modes.transition(1, UserMode.HUMAN_SUPPORT)
        self.assertEqual(route_text(UserMode.HUMAN_SUPPORT, BACK_TO_AI_BUTTON), "control")
        await self.modes.transition(1, UserMode.AI_CHAT)
        mode, _ = await self.modes.snapshot(1)
        self.assertEqual(route_text(mode, "Новый вопрос"), "ai")

    async def test_scenario_4_commands_never_route_to_ai(self):
        for command in ("/start", "/start@my_bot", "/menu", "/cancel", "/help"):
            self.assertEqual(route_text(UserMode.AI_CHAT, command), "control")

    async def test_scenario_5_stale_ai_generation_is_rejected(self):
        generation = await self.modes.transition(1, UserMode.AI_CHAT)
        await self.modes.transition(1, UserMode.WAITING_FOR_OPERATOR)
        self.assertFalse(await self.modes.is_current(1, UserMode.AI_CHAT, generation))

    async def test_scenario_6_rapid_switches_have_deterministic_final_mode(self):
        async def switch_after(delay, mode):
            await asyncio.sleep(delay)
            await self.modes.transition(1, mode)

        await asyncio.gather(
            switch_after(0, UserMode.AI_CHAT),
            switch_after(0.001, UserMode.WAITING_FOR_OPERATOR),
            switch_after(0.002, UserMode.AI_CHAT),
        )
        mode, generation = await self.modes.snapshot(1)
        self.assertEqual(mode, UserMode.AI_CHAT)
        self.assertEqual(generation, 3)

    async def test_scenario_7_users_are_isolated(self):
        await asyncio.gather(
            self.modes.transition(1, UserMode.AI_CHAT),
            self.modes.transition(2, UserMode.HUMAN_SUPPORT),
        )
        self.assertEqual((await self.modes.snapshot(1))[0], UserMode.AI_CHAT)
        self.assertEqual((await self.modes.snapshot(2))[0], UserMode.HUMAN_SUPPORT)
        self.assertEqual(route_text((await self.modes.snapshot(1))[0], "hello"), "ai")
        self.assertEqual(route_text((await self.modes.snapshot(2))[0], "hello"), "support")

    async def test_scenario_8_ai_failure_does_not_break_mode_controls(self):
        await self.modes.transition(1, UserMode.AI_CHAT)
        # External API failure changes the response, not the user's ability to switch.
        self.assertEqual(route_text(UserMode.AI_CHAT, AI_BUTTON), "control")
        await self.modes.transition(1, UserMode.WAITING_FOR_OPERATOR)
        self.assertEqual((await self.modes.snapshot(1))[0], UserMode.WAITING_FOR_OPERATOR)

    async def test_unknown_state_falls_back_to_menu(self):
        self.assertEqual(route_text("corrupted", "hello"), "menu")


if __name__ == "__main__":
    unittest.main()
