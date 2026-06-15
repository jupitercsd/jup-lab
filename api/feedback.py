"""
接收用户建议反馈 → 存入 Upstash Redis（同 IP 每日上限 10 条）
POST /api/feedback  body: {"text": "...", "page": "..."}

需要 Vercel 环境变量：
  KV_REST_API_URL   — Upstash REST API 地址
  KV_REST_API_TOKEN — Upstash REST API token
"""
import json
import hashlib
import ipaddress
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

REDIS_URL = os.environ.get("KV_REST_API_URL", "")
REDIS_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")
LIST_KEY = "feedbacks"
MAX_LEN = 500
DAILY_LIMIT = 10
MAX_BODY_BYTES = 8 * 1024
MAX_TEXT_LEN = 2000
MAX_PAGE_LEN = 500
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.environ.get("FEEDBACK_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}
IP_HASH_SALT = os.environ.get("FEEDBACK_IP_HASH_SALT", REDIS_TOKEN)


def _redis_cmd(command, *args, timeout=5):
    """发送 Redis REST 命令，返回解析后的 result"""
    if not REDIS_URL or not REDIS_TOKEN:
        raise RuntimeError("Redis 未配置")

    encoded_args = "/".join(urllib.parse.quote(str(arg), safe="") for arg in args)
    url = f"{REDIS_URL.rstrip('/')}/{command}"
    if encoded_args:
        url += f"/{encoded_args}"

    headers = {"Authorization": f"Bearer {REDIS_TOKEN}"}
    req = urllib.request.Request(url, method="POST", headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
            return body.get("result")
    except Exception as exc:
        print(f"[feedback] Redis 命令失败 {command}: {exc}")
        raise RuntimeError("Redis 命令失败") from exc


def check_rate_limit(ip: str) -> tuple:
    """返回 (allowed: bool, count: int)"""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ip_hash = _hash_ip(ip)
    key = f"fb:rate:{ip_hash}:{today}"

    count = int(_redis_cmd("incr", key))

    if count == 1:
        # 首次设置，TTL 到当天结束
        seconds_left = int(86400 - time.time() % 86400)
        _redis_cmd("expire", key, seconds_left, timeout=3)

    return count <= DAILY_LIMIT, count


def store_feedback(data: dict) -> bool:
    """LPUSH 到 Redis"""
    payload = json.dumps(data, ensure_ascii=False)
    result = _redis_cmd("lpush", LIST_KEY, payload)
    _redis_cmd("ltrim", LIST_KEY, 0, MAX_LEN - 1, timeout=3)
    print(f"[feedback] LPUSH OK, 列表长度: {result}")
    return True


def _client_ip(headers) -> str:
    """从平台代理头里取 IP；异常值统一归为 unknown。"""
    raw = headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not raw:
        raw = headers.get("X-Real-IP", "").strip()

    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return "unknown"


def _hash_ip(ip: str) -> str:
    material = f"{IP_HASH_SALT}:{ip}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def _clean_text(value, max_len: int):
    if not isinstance(value, str):
        return None

    text = value.strip()
    if not text or len(text) > max_len:
        return None

    return text


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._respond(400, {"ok": False, "error": "Content-Length 无效"})
            return

        if content_length <= 0:
            self._respond(400, {"ok": False, "error": "请求体为空"})
            return

        if content_length > MAX_BODY_BYTES:
            self._respond(413, {"ok": False, "error": "请求体过大"})
            return

        raw = self.rfile.read(content_length) if content_length else b"{}"

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            self._respond(400, {"ok": False, "error": "JSON 解析失败"})
            return

        if not isinstance(data, dict):
            self._respond(400, {"ok": False, "error": "JSON 必须是对象"})
            return

        text = _clean_text(data.get("text"), MAX_TEXT_LEN)
        if text is None:
            self._respond(400, {"ok": False, "error": "内容为空或超过2000字"})
            return

        page = data.get("page", "")
        if page is None:
            page = ""
        if not isinstance(page, str) or len(page) > MAX_PAGE_LEN:
            self._respond(400, {"ok": False, "error": "页面地址无效"})
            return

        ip = _client_ip(self.headers)

        try:
            allowed, count = check_rate_limit(ip)
        except RuntimeError:
            self._respond(503, {"ok": False, "error": "反馈服务暂时不可用"})
            return

        if not allowed:
            self._respond(429, {"ok": False, "error": f"今日已达上限（{DAILY_LIMIT} 条），明天再来吧"})
            return

        record = {
            "time": datetime.now(timezone.utc).isoformat(),
            "page": page,
            "ip_hash": _hash_ip(ip),
            "text": text,
        }

        try:
            store_feedback(record)
        except RuntimeError:
            self._respond(503, {"ok": False, "error": "反馈服务暂时不可用"})
            return

        self._respond(200, {"ok": True, "stored": True, "remaining": max(DAILY_LIMIT - count, 0)})

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode("utf-8"))

    def _cors_headers(self):
        origin = self.headers.get("Origin", "")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
