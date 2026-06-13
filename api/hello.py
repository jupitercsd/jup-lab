"""
Vercel Serverless Function (Python) — 测试云函数是否正常工作
部署后访问 https://你的域名/api/hello
"""
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        now = datetime.now(timezone.utc)

        body = json.dumps({
            "ok": True,
            "message": "Python 云函数运行正常",
            "serverTime": now.isoformat(),
            "request": {
                "method": self.command,
                "path": self.path,
                "host": self.headers.get("Host", ""),
                "userAgent": self.headers.get("User-Agent", ""),
                "forwardedFor": self.headers.get("X-Forwarded-For", ""),
            },
            "env": {
                "python": sys.version,
                "region": os.environ.get("VERCEL_REGION", "unknown"),
            },
        }, ensure_ascii=False, indent=2)

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        