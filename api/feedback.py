"""
接收用户建议反馈，写入 Vercel 日志（可后续扩展存储）
POST /api/feedback  body: {"text": "...", "page": "..."}
"""
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler


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
        if not text or len(text) > 200:
            self._respond(400, {"ok": False, "error": "内容为空或超过200字"})
            return

        # 打印到 Vercel 日志（可在 Vercel Dashboard → Logs 查看）
        print(json.dumps({
            "type": "feedback",
            "time": datetime.now(timezone.utc).isoformat(),
            "page": data.get("page", ""),
            "ip": self.headers.get("X-Forwarded-For", ""),
            "text": text,
        }, ensure_ascii=False))

        self._respond(200, {"ok": True})

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
