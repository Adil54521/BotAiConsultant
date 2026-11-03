from datetime import datetime, timezone

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter


HEADER_FILL = PatternFill("solid", fgColor="1F4E78")
HEADER_FONT = Font(color="FFFFFF", bold=True)


def safe_excel_value(value):
    if isinstance(value, str) and value[:1] in {"=", "+", "-", "@"}:
        return "'" + value
    return value


def parse_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return safe_excel_value(str(value))


def append_header(sheet, labels, row_number=1):
    sheet.freeze_panes = f"A{row_number + 1}"
    sheet.auto_filter.ref = f"A{row_number}:{chr(64 + min(len(labels), 26))}1048576"
    row = []
    for label in labels:
        cell = WriteOnlyCell(sheet, value=label)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        row.append(cell)
    sheet.append(row)


def append_row(sheet, values):
    cells = []
    for value in values:
        cell = WriteOnlyCell(sheet, value=safe_excel_value(value))
        if isinstance(value, datetime):
            cell.number_format = "dd.mm.yyyy hh:mm"
        elif isinstance(value, float):
            cell.number_format = "#,##0.00"
        cells.append(cell)
    sheet.append(cells)


def set_widths(sheet, widths):
    for index, width in enumerate(widths, 1):
        sheet.column_dimensions[get_column_letter(index)].width = width


def build_usage_report(data, period_label, output_path):
    workbook = Workbook(write_only=True)
    generated_at = datetime.now(timezone.utc).replace(tzinfo=None)

    overview_sheet = workbook.create_sheet("Общая статистика")
    set_widths(overview_sheet, [38, 24])
    overview_sheet.sheet_view.showGridLines = False
    overview_sheet.append(["Отчет по использованию сервиса", period_label])
    overview_sheet.append(["Дата формирования (UTC)", generated_at])
    overview_sheet.append([])
    append_header(overview_sheet, ["Показатель", "Значение"], row_number=4)
    overview = data.get("overview") or {}
    labels = [
        ("Зарегистрированные пользователи", "registered_users"), ("Новые пользователи", "new_users"),
        ("Уникальные активные пользователи", "active_users"),
        ("Пользователи ИИ", "ai_users"), ("Запросы к ИИ", "ai_requests"),
        ("Успешные запросы", "successful_requests"), ("Ошибки ИИ", "failed_requests"),
        ("Входные токены", "prompt_tokens"), ("Выходные токены", "candidate_tokens"),
        ("Thinking-токены", "thoughts_tokens"), ("Кэшированные токены", "cached_tokens"),
        ("Всего токенов", "total_tokens"), ("Среднее токенов на запрос", "avg_tokens"),
        ("Общее время ИИ, мс", "total_duration_ms"), ("Среднее время ИИ, мс", "avg_duration_ms"),
        ("Обращения к сотрудникам", "support_requests"), ("Пользователи поддержки", "support_users"),
        ("Начало достоверного учета", "tracking_started_at"),
    ]
    for label, key in labels:
        value = parse_datetime(overview.get(key)) if key == "tracking_started_at" else overview.get(key)
        append_row(overview_sheet, [label, value if value is not None else "Нет данных"])

    users_sheet = workbook.create_sheet("Статистика пользователей")
    set_widths(users_sheet, [16, 24, 20, 20, 20, 14, 18, 12, 16, 16, 20, 16, 20, 24, 24, 22, 22, 22])
    append_header(users_sheet, ["Telegram ID", "Имя", "Username", "Номер телефона", "Дата регистрации", "AI-запросы", "Успешные запросы", "Ошибки", "Входные токены", "Выходные токены", "Дополнительные токены", "Всего токенов", "Кэшированные токены", "Среднее время ответа, мс", "Оценочная стоимость", "Последняя активность", "Первое обращение к ИИ", "Последнее обращение к ИИ"])
    for row in data.get("users") or []:
        append_row(users_sheet, [str(row.get("telegram_id", "")), row.get("full_name"), row.get("username"), row.get("phone"), parse_datetime(row.get("registered_at")), row.get("ai_requests"), row.get("successful_requests"), row.get("failed_requests"), row.get("prompt_tokens"), row.get("candidate_tokens"), row.get("thoughts_tokens"), row.get("total_tokens"), row.get("cached_tokens"), row.get("avg_duration_ms"), "Нет достоверного тарифа", parse_datetime(row.get("last_activity_at")), parse_datetime(row.get("first_ai_at")), parse_datetime(row.get("last_ai_at"))])

    usage_sheet = workbook.create_sheet("История AI-запросов")
    set_widths(usage_sheet, [38, 16, 22, 20, 14, 18, 18, 22, 18, 22, 20, 24])
    append_header(usage_sheet, ["ID запроса", "Telegram ID", "Дата и время (UTC)", "Модель", "Статус", "Входные токены", "Выходные токены", "Дополнительные токены", "Всего токенов", "Кэшированные токены", "Время ответа, мс", "Оценочная стоимость"])
    for row in data.get("usage") or []:
        append_row(usage_sheet, [str(row.get("request_id", "")), str(row.get("telegram_id", "")), parse_datetime(row.get("requested_at")), row.get("model"), row.get("status"), row.get("prompt_tokens"), row.get("candidate_tokens"), row.get("thoughts_tokens"), row.get("total_tokens"), row.get("cached_tokens"), row.get("duration_ms"), "Нет достоверного тарифа"])

    support_sheet = workbook.create_sheet("Обращения к сотрудникам")
    set_widths(support_sheet, [16, 16, 22, 26, 22, 14, 22, 24])
    append_header(support_sheet, ["ID обращения", "Telegram ID", "Дата создания (UTC)", "Подключение сотрудника (UTC)", "Дата завершения (UTC)", "Статус", "Время ожидания, сек", "Продолжительность, сек"])
    for row in data.get("support") or []:
        append_row(support_sheet, [row.get("id"), str(row.get("telegram_id", "")), parse_datetime(row.get("opened_at")), parse_datetime(row.get("operator_connected_at")), parse_datetime(row.get("closed_at")), row.get("status"), row.get("wait_seconds"), row.get("duration_seconds")])

    workbook.save(output_path)
    return output_path
