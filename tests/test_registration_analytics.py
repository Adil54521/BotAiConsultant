import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook

from admin_periods import LOCAL_TZ, period_bounds
from bot_state import UserMode, is_admin_id, is_own_contact, route_text
from report_generator import build_usage_report
from internal_auth import resolve_internal_token


class RegistrationAndAdminTests(unittest.TestCase):
    def test_new_user_mode_has_no_protected_route(self):
        self.assertEqual(route_text(UserMode.UNREGISTERED, "обычный текст"), "menu")

    def test_unregistered_ai_and_support_buttons_are_controls(self):
        self.assertEqual(route_text(UserMode.UNREGISTERED, "🤖 ИИ-консультант"), "control")
        self.assertEqual(route_text(UserMode.UNREGISTERED, "👨‍💼 Связаться с сотрудником"), "control")

    def test_foreign_or_missing_contact_is_rejected(self):
        self.assertFalse(is_own_contact(200, 100))
        self.assertFalse(is_own_contact(None, 100))

    def test_own_telegram_contact_is_accepted(self):
        self.assertTrue(is_own_contact(100, 100))

    def test_bot_and_backend_derive_stable_internal_auth_token(self):
        token, scheme = resolve_internal_token("", "existing-jwt-secret")
        second, _ = resolve_internal_token(None, "existing-jwt-secret")
        self.assertEqual(scheme, "derived_from_jwt_secret")
        self.assertEqual(token, second)
        self.assertNotEqual(token, "existing-jwt-secret")

    def test_explicit_internal_token_has_priority(self):
        token, scheme = resolve_internal_token(" explicit-token ", "fallback")
        self.assertEqual(token, "explicit-token")
        self.assertEqual(scheme, "configured_internal_token")

    def test_admin_authorization_uses_numeric_telegram_id(self):
        self.assertTrue(is_admin_id(100, 100))
        self.assertFalse(is_admin_id(100, 101))
        self.assertFalse(is_admin_id(None, 100))

    def test_period_filter_respects_qyzylorda_day_boundaries(self):
        now = datetime(2026, 11, 3, 12, tzinfo=LOCAL_TZ)
        start, end, label = period_bounds("today", now)
        self.assertEqual(start.isoformat(), "2026-11-02T19:00:00+00:00")
        self.assertEqual(end.isoformat(), "2026-11-03T19:00:00+00:00")
        self.assertEqual(label, "03.11.2026–03.11.2026")

    def test_migration_extends_existing_tables_without_duplicates(self):
        migration = Path("migrations/001_bot_registration_analytics.sql").read_text(encoding="utf-8")
        self.assertIn("ALTER TABLE chats", migration)
        self.assertIn("ALTER TABLE messages", migration)
        self.assertIn("CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_request_id", migration)
        self.assertNotIn("CREATE TABLE", migration)
        self.assertNotIn("ai_conversations", migration)

    def test_backend_uses_live_chat_and_message_schema(self):
        analytics = Path("analytics.js").read_text(encoding="utf-8")
        chat = Path("chat.js").read_text(encoding="utf-8")
        self.assertIn("INSERT INTO public.chats", analytics)
        self.assertIn("INSERT INTO messages", analytics)
        self.assertNotIn("FROM ai_usage_events", analytics)
        self.assertNotIn("FROM support_requests", analytics)
        self.assertIn("to_regclass('public.ai_conversations')", chat)
        self.assertIn("FROM ai_conversations", chat)
        self.assertIn("FROM chats", chat)

    def test_backend_registration_contract_and_port_are_explicit(self):
        backend = Path("index.js").read_text(encoding="utf-8")
        compose = Path("docker-compose.yml").read_text(encoding="utf-8")
        nginx = Path("nginx.conf").read_text(encoding="utf-8")
        self.assertIn('internalPath === "/internal/bot-user/register"', backend)
        self.assertIn('internalPath === "/internal/health"', backend)
        self.assertIn('normalizedPath.startsWith("/api/internal/")', backend)
        self.assertIn("PORT=8004", compose)
        self.assertNotIn("api:8000", nginx)


class ExcelReportTests(unittest.TestCase):
    def test_report_contains_four_required_sheets_and_user_metrics(self):
        data = {
            "overview": {"registered_users": "1", "ai_requests": "1", "tracking_started_at": "2026-11-01T00:00:00Z"},
            "users": [{"telegram_id": 123, "full_name": "Test User", "username": "=FORMULA", "phone": "+77000000000", "registered_at": "2026-11-01T00:00:00Z", "ai_requests": 1, "successful_requests": 1, "failed_requests": 0, "prompt_tokens": 100, "candidate_tokens": 20, "thoughts_tokens": 5, "total_tokens": 125, "cached_tokens": 0, "avg_duration_ms": 500, "last_activity_at": "2026-11-02T00:00:00Z"}],
            "usage": [{"request_id": "00000000-0000-0000-0000-000000000001", "telegram_id": 123, "requested_at": "2026-11-02T00:00:00Z", "model": "gemini-test", "status": "success", "prompt_tokens": 100, "candidate_tokens": 20, "thoughts_tokens": 5, "total_tokens": 125, "cached_tokens": 0, "duration_ms": 500}],
            "support": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.xlsx"
            build_usage_report(data, "01.11.2026–03.11.2026", path)
            workbook = load_workbook(path, read_only=False, data_only=False)
            try:
                self.assertEqual(workbook.sheetnames, ["Общая статистика", "Статистика пользователей", "История AI-запросов", "Обращения к сотрудникам"])
                users = workbook["Статистика пользователей"]
                self.assertEqual(users["A2"].value, "123")
                self.assertEqual(users["C2"].value, "'=FORMULA")
                self.assertEqual(users["L2"].value, 125)
                self.assertEqual(users.freeze_panes, "A2")
            finally:
                workbook.close()


if __name__ == "__main__":
    unittest.main()
