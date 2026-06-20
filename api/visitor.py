"""
访问统计 — PV 计数 + 返回近 N 天数据
POST /api/visitor  body: {"path": "/"}  → 计数 +1，返回近 30 天 PV
GET  /api/visitor  → 仅返回近 30 天 PV（不计数）

环境变量：
  KV_REST_API_URL   — Upstash REST API 地址
  KV_REST_API_TOKEN — Upstash REST API token
"""
import hashlib
import ipaddress
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler

REDIS_URL = os.environ.get("KV_REST_API_URL", "")
REDIS_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")
IP_HASH_SALT = os.environ.get("VISITOR_IP_HASH_SALT", REDIS_TOKEN)
PV_TOTAL_KEY = "visitor:pv:total"
DAILY_KEY_PREFIX = "visitor:pv:daily:"
HISTORY_DAYS = 30
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.environ.get("VISITOR_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}


def _redis_cmd(command, *args, timeout=5):
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
        print(f"[visitor] Redis 命令失败 {command}: {exc}")
        raise RuntimeError("Redis 命令失败") from exc


def _hash_ip(ip: str) -> str:
    material = f"{IP_HASH_SALT}:{ip}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def _client_ip(headers) -> str:
    raw = headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not raw:
        raw = headers.get("X-Real-IP", "").strip()
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return "unknown"


def _record_visit(ip: str) -> None:
    """总计数 +1，当日计数 +1（首次设 TTL 到当天结束）"""
    try:
        _redis_cmd("incr", PV_TOTAL_KEY, timeout=3)

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        daily_key = DAILY_KEY_PREFIX + today
        count = int(_redis_cmd("incr", daily_key, timeout=3))
        if count == 1:
            seconds_left = int(86400 - time.time() % 86400)
            _redis_cmd("expire", daily_key, seconds_left, timeout=3)
    except RuntimeError:
        pass


def _daily_history(days: int):
    """返回 [(日期, pv), ...]，按时间正序。需要用 mget 批量取，失败回退逐个取。"""
    now = datetime.now(timezone.utc)
    keys, dates = [], []
    for i in range(days - 1, -1, -1):
        d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        dates.append(d)
        keys.append(DAILY_KEY_PREFIX + d)

    values = [0] * len(keys)
    try:
        result = _redis_cmd("mget", *keys, timeout=5)
        if isinstance(result, list):
            for i, v in enumerate(result):
                values[i] = int(v) if v else 0
    except RuntimeError:
        for i, k in enumerate(keys):
            try:
                v = _redis_cmd("get", k, timeout=3)
                values[i] = int(v) if v else 0
            except RuntimeError:
                values[i] = 0

    return list(zip(dates, values))


def _total_pv():
    try:
        v = _redis_cmd("get", PV_TOTAL_KEY, timeout=3)
        return int(v) if v else 0
    except RuntimeError:
        return 0


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._serve()

    def do_POST(self):
        self._serve(count=True)

    def _serve(self, count=False):
        if count:
            _record_visit(_client_ip(self.headers))

        payload = {
            "ok": True,
            "total": _total_pv(),
            "daily": _daily_history(HISTORY_DAYS),
        }

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _cors_headers(self):
        origin = self.headers.get("Origin", "")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")