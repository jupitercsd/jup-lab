"""
接收用户建议反馈 → 存入 Upstash Redis
POST /api/feedback  body: {"text": "...", "page": "..."}

需要 Vercel 环境变量：
  KV_REST_API_URL   — Upstash REST API 地址
  KV_REST_API_TOKEN — Upstash REST API token
"""
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

REDIS_URL = os.environ.get("KV_REST_API_URL", "")
REDIS_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")
LIST_KEY = "feedbacks"
MAX_LEN = 500  # 最多保留条数


def store_feedback(data: dict) -> bool:
    """LPUSH 到 Redis，成功返回 True"""
    if not REDIS_URL or not REDIS_TOKEN:
        print("[feedback] Redis 未配置，仅打印日志:", json.dumps(data, ensure_ascii=False))
        return False

    payload = json.dumps(data, ensure_ascii=False)
    encoded = urllib.parse.quote(payload, safe="")

    # LPUSH + LTRIM 保持列表长度
    push_url = f"{REDIS_URL}/lpush/{LIST_KEY}/{encoded}"
    trim_url = f"{REDIS_URL}/ltrim/{LIST_KEY}/0/{MAX_LEN - 1}"

    headers = {"Authorization": f"Bearer {REDIS_TOKEN}"}
    req = urllib.request.Request(push_url, method="POST", headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode()
            print(f"[feedback] LPUSH OK: {body}")

        # 裁剪长度（异步不阻塞，失败不影响主流程）
        trim_req = urllib.request.Request(trim_url, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(trim_req, timeout=3):
                pass
        except Exception:
            pass

        return True
    except Exception as exc:
        print(f"[feedback] Redis 写入失败: {exc}")
        return False


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(content_length) if content_length else b"{}"

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            self._respond(400, {"ok": False, "error": "JSON 解析失败"})
            return

        text = (data.get("text") or "").strip()
        if not text or len(text) > 2000:
            self._respond(400, {"ok": False, "error": "内容为空或超过2000字"})
            return

        record = {
            "time": datetime.now(timezone.utc).isoformat(),
            "page": data.get("page", ""),
            "ip": self.headers.get("X-Forwarded-For", ""),
            "text": text,
        }

        ok = store_feedback(record)

        # 即使 Redis 挂了也返回成功（数据已打印到日志可查）
        self._respond(200, {"ok": True, "stored": ok})

    def do_OPTIONS(self):
        self._cors_headers(204)

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode("utf-8"))

    def _cors_headers(self, status=None):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if status:
            self.send_response(status)
            self.end_headers()
