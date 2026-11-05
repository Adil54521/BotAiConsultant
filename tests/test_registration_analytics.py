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

    def test_all_admin_period_presets_have_valid_utc_boundaries(self):
        now = datetime(2026, 11, 3, 12, tzinfo=LOCAL_TZ)
        for kind in ("today", "yesterday", "7d", "30d", "month", "all"):
            start, end, label = period_bounds(kind, now)
            self.assertLess(start, end, kind)
            self.assertIsNotNone(label)

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

    def test_paid_embedding_endpoints_and_static_secrets_are_protected(self):
        backend = Path("index.js").read_text(encoding="utf-8")
        nginx = Path("nginx.conf").read_text(encoding="utf-8")
        compose = Path("docker-compose.yml").read_text(encoding="utf-8")
        dockerignore = Path(".dockerignore").read_text(encoding="utf-8")
        search_handler = backend[backend.index('if (req.url === "/search"'):]
        self.assertIn("isInternalAuthorized(req)", search_handler[:1200])
        upload_handler = backend[backend.index('if (req.url === "/ai"'):]
        self.assertIn("isAdminSession(req)", upload_handler[:500])
        self.assertIn("location = /", nginx)
        self.assertIn("location / {\n            return 404;", nginx)
        self.assertNotIn("- .:/usr/share/nginx/html:ro", compose)
        self.assertIn("./account.html:/usr/share/nginx/html/account.html:ro", compose)
        self.assertIn(".env", dockerignore)
        self.assertIn("project.tar.gz", dockerignore)

    def test_manual_migration_extends_messages_for_cost_audit_without_new_table(self):
        migration = Path("migrations/manual_messages_analytics.sql").read_text(encoding="utf-8")
        for column in ("source", "telegram_message_id", "retry_count", "estimated_cost_usd", "pricing_effective_date"):
            self.assertIn(column, migration)
        self.assertNotIn("CREATE TABLE", migration)


class ExcelReportTests(unittest.TestCase):
    def test_report_contains_four_required_sheets_and_user_metrics(self):
        data = {
            "overview": {"registered_users": "1", "ai_requests": "1", "estimated_cost_usd": "0.001", "tracking_started_at": "2026-11-01T00:00:00Z"},
            "users": [{"telegram_id": 123, "full_name": "Test User", "username": "=FORMULA", "phone": "+77000000000", "registered_at": "2026-11-01T00:00:00Z", "ai_requests": 1, "successful_requests": 1, "failed_requests": 0, "prompt_tokens": 100, "candidate_tokens": 20, "thoughts_tokens": 5, "total_tokens": 125, "cached_tokens": 0, "estimated_cost_usd": 0.001, "avg_duration_ms": 500, "last_activity_at": "2026-11-02T00:00:00Z"}],
            "usage": [{"request_id": "00000000-0000-0000-0000-000000000001", "telegram_id": 123, "requested_at": "2026-11-02T00:00:00Z", "model": "gemini-test", "status": "success", "prompt_tokens": 100, "candidate_tokens": 20, "thoughts_tokens": 5, "total_tokens": 125, "cached_tokens": 0, "estimated_cost_usd": 0.001, "source": "telegram", "telegram_message_id": "55", "retry_count": 0, "duration_ms": 500}],
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
                self.assertEqual(users["O2"].value, 0.001)
                self.assertEqual(users.freeze_panes, "A2")
            finally:
                workbook.close()

    def test_empty_period_generates_a_valid_report(self):
        data = {
            "overview": {
                "registered_users": "0", "new_users": "0", "active_users": "0",
                "ai_users": "0", "ai_requests": "0", "successful_requests": "0",
                "failed_requests": "0", "prompt_tokens": "0", "candidate_tokens": "0",
                "thoughts_tokens": "0", "cached_tokens": "0", "total_tokens": "0",
                "total_duration_ms": "0",
            },
            "users": [], "usage": [], "support": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.xlsx"
            build_usage_report(data, "01.01.2020–01.01.2020", path)
            workbook = load_workbook(path, read_only=False, data_only=True)
            try:
                self.assertEqual(len(workbook.sheetnames), 4)
                overview = workbook["Общая статистика"]
                values = {overview.cell(row=row, column=1).value: overview.cell(row=row, column=2).value
                          for row in range(5, overview.max_row + 1)}
                self.assertEqual(values["Всего токенов"], 0)
            finally:
                workbook.close()


if __name__ == "__main__":
    unittest.main()
