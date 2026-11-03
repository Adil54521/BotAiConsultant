from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


try:
    LOCAL_TZ = ZoneInfo("Asia/Qyzylorda")
except ZoneInfoNotFoundError:
    # Windows images without the tzdata package still use Qyzylorda's current UTC+5.
    LOCAL_TZ = timezone(timedelta(hours=5), name="Asia/Qyzylorda")


def period_bounds(kind, now=None):
    now = now or datetime.now(LOCAL_TZ)
    today = now.date()
    if kind == "today": start, end = today, today + timedelta(days=1)
    elif kind == "yesterday": start, end = today - timedelta(days=1), today
    elif kind == "7d": start, end = today - timedelta(days=6), today + timedelta(days=1)
    elif kind == "30d": start, end = today - timedelta(days=29), today + timedelta(days=1)
    elif kind == "month": start, end = today.replace(day=1), today + timedelta(days=1)
    elif kind == "all": start, end = date(1970, 1, 1), today + timedelta(days=1)
    else: raise ValueError("invalid period")
    start_dt = datetime.combine(start, time.min, LOCAL_TZ).astimezone(timezone.utc)
    end_dt = datetime.combine(end, time.min, LOCAL_TZ).astimezone(timezone.utc)
    return start_dt, end_dt, f"{start:%d.%m.%Y}–{(end - timedelta(days=1)):%d.%m.%Y}"
