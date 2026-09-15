# -*- coding: utf-8 -*-
"""虎头虎脑 · 云端提醒推送

读仓库根目录的订阅源 ICS（`cal-*.ics`），按每条 VALARM 的提前量算出触发时刻，
把"刚刚到点"的提醒通过 Bark 推到手机。已推送的用 `.github/state/fired.json` 去重。

放在这里而不是页面里，是为了绕开 iPhone 后台冻结网页 JS 的限制 ——
由云端定时任务代为推送，工作台关着也能收到。

环境变量：
  BARK_KEY     必填，Bark 的 key（存在仓库 Secrets 里，不落明文）
  BARK_SERVER  可选，默认 https://api.day.app
  DIGEST_HOUR  可选，默认 "8"，每天这个整点推一条"今日行程"；设为 "off" 关闭
  WINDOW_MIN   可选，默认 45，容忍 GitHub 调度的延迟
"""
import glob
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # 极老环境兜底
    TZ = timezone(timedelta(hours=8))

STATE_PATH = ".github/state/fired.json"
KEEP_DAYS = 5
DEFAULT_OFF_MIN = 15


# ---------- ICS 解析 ----------

def unfold(text):
    """RFC5545 折行还原：CRLF + 一个空格/制表符 = 续行。"""
    return re.sub(r"\r?\n[ \t]", "", text.replace("\r\n", "\n"))


def parse_dt(raw):
    """支持 20260918T200000 / 20260918T200000Z / 20260918（浮动时间按本地时区理解）。"""
    raw = raw.strip()
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$", raw)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if m.group(4):
        hh, mi, ss = int(m.group(4)), int(m.group(5)), int(m.group(6))
    else:
        hh, mi, ss = 9, 0, 0  # 全天事件：按当天 9 点算
    if m.group(7):
        return datetime(y, mo, d, hh, mi, ss, tzinfo=timezone.utc).astimezone(TZ)
    return datetime(y, mo, d, hh, mi, ss, tzinfo=TZ)


def parse_offset(value):
    """-PT15M → -15（分钟）；-P1D → -1440。"""
    m = re.match(r"^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$", value.strip())
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    mins = (int(m.group(2) or 0) * 10080 + int(m.group(3) or 0) * 1440
            + int(m.group(4) or 0) * 60 + int(m.group(5) or 0) + int(m.group(6) or 0) / 60)
    return sign * mins


def field(block, name):
    m = re.search(r"^" + name + r"[^:\n]*:(.*)$", block, re.M)
    return m.group(1).strip() if m else ""


def load_events():
    files = sorted(glob.glob("cal-*.ics")) or sorted(glob.glob("*.ics"))
    events = []
    for path in files:
        text = unfold(open(path, encoding="utf-8", errors="replace").read())
        for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S):
            start = parse_dt(field(block, "DTSTART"))
            if not start:
                continue
            offs = [o for o in (parse_offset(v) for v in re.findall(r"^TRIGGER[^:\n]*:([^\n]+)", block, re.M)) if o is not None]
            if not offs:
                offs = [-DEFAULT_OFF_MIN]
            for off in sorted(set(offs)):
                events.append({
                    "file": path,
                    "uid": field(block, "UID") or field(block, "SUMMARY"),
                    "title": field(block, "SUMMARY") or "(无标题)",
                    "loc": field(block, "LOCATION"),
                    "start": start,
                    "off": off,
                    # off 是有符号偏移（-PT15M → -15）：负=起始前，正=起始后
                    "fire": start + timedelta(minutes=off),
                })
    return events


# ---------- 状态（去重） ----------

def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    cutoff = (datetime.now(TZ) - timedelta(days=KEEP_DAYS)).strftime("%Y%m%d")
    state = {k: v for k, v in state.items() if v[:8] >= cutoff}
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)


# ---------- 推送 ----------

def bark(title, body, group="虎头虎脑"):
    key = (os.environ.get("BARK_KEY") or "").strip()
    if not key:
        raise SystemExit("缺少 BARK_KEY（仓库 Settings → Secrets and variables → Actions）")
    base = (os.environ.get("BARK_SERVER") or "https://api.day.app").strip().rstrip("/")
    payload = json.dumps({
        "title": title, "body": body, "group": group,
        "level": "timeSensitive", "sound": "bell",
    }).encode("utf-8")
    req = urllib.request.Request(base + "/" + key, data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")[:200]


def human_off(off):
    off = -off
    if off <= 0:
        return "到点提醒"
    if off % 60 == 0:
        return "提前 %d 小时" % (off // 60)
    return "提前 %d 分钟" % off


def main():
    # 手动通道自检：Workflow 手动触发时把 test 填 1，只发一条测试推送
    if (os.environ.get("PUSH_TEST") or "").strip() not in ("", "0", "false", "False"):
        code, resp = bark("✅ 虎头虎脑 · 通道自检", "云端定时任务工作正常，日程提醒会按时送达。")
        print("TEST -> %s %s" % (code, resp))
        return 0

    window = int(os.environ.get("WINDOW_MIN") or 45)
    digest_hour = (os.environ.get("DIGEST_HOUR") or "8").strip().lower()
    now = datetime.now(TZ)
    events = load_events()
    state = load_state()
    sent = 0

    # 1) 到点提醒
    lo = now - timedelta(minutes=window)
    for ev in sorted(events, key=lambda e: e["fire"]):
        fire = ev["fire"]
        if not (lo <= fire <= now):
            continue
        mark = "%s|%s" % (ev["uid"], fire.strftime("%Y%m%dT%H%M"))
        if mark in state:
            continue
        body = "%s 开始（%s）" % (ev["start"].strftime("%m月%d日 %H:%M"), human_off(ev["off"]))
        if ev["loc"]:
            body += "\n地点：" + ev["loc"]
        code, resp = bark("⏰ " + ev["title"], body)
        print("PUSH %s -> %s %s" % (ev["title"], code, resp))
        state[mark] = now.strftime("%Y%m%d%H%M")
        sent += 1

    # 2) 每日行程（默认 08 点档）
    #    在 08:00–11:59 之间任意一次运行都可补推：GitHub 的整点调度常被延迟或跳过，
    #    只认「正好 8 点那一小时」会让汇总整天丢掉。
    if digest_hour != "off":
        try:
            dh = int(str(digest_hour).strip().lstrip("0") or 0)
        except ValueError:
            dh = 8
        mark = "digest|" + now.strftime("%Y%m%d")
        if dh <= now.hour <= dh + 3 and mark not in state:
            today = now.date()
            items = sorted({(e["start"], e["title"], e["loc"]) for e in events
                            if e["off"] == -DEFAULT_OFF_MIN and e["start"].date() == today})
            if items:
                body = "\n".join("· %s %s%s" % (s.strftime("%H:%M"), t, ("（" + l + "）") if l else "")
                                 for s, t, l in items)
            else:
                body = "今天没有安排，好好休息。"
            code, resp = bark("🌤 今日行程 %d 项" % len(items), body)
            print("DIGEST -> %s %s" % (code, resp))
            state[mark] = now.strftime("%Y%m%d%H%M")
            sent += 1

    save_state(state)
    print("事件总数 %d，本次推送 %d 条，窗口 %d 分钟，现在 %s" % (len(events), sent, window, now.strftime("%Y-%m-%d %H:%M")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
