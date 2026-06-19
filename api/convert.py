"""
Adobe PDF Services API — 文档转 PDF
POST /api/convert   multipart/form-data: file=<file>

环境变量：
  ADOBE_CLIENT_ID      — Adobe API Key
  ADOBE_CLIENT_SECRET  — Adobe Client Secret
  KV_REST_API_URL      — Upstash Redis REST API 地址（用于频率限制）
  KV_REST_API_TOKEN    — Upstash Redis REST API token
"""
import hashlib
import ipaddress
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

def _env(name, default=""):
    return os.environ.get(name, default).strip()


CLIENT_ID = _env("ADOBE_CLIENT_ID").lower()
CLIENT_SECRET = _env("ADOBE_CLIENT_SECRET")
ORG_ID = _env("ADOBE_ORG_ID")
TOKEN_URL = _env("ADOBE_TOKEN_URL", "https://pdf-services.adobe.io/token")
API_BASE = _env("ADOBE_API_BASE", "https://pdf-services.adobe.io")
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_POLL_SECONDS = 50
POLL_INTERVAL_SECONDS = 2
DAILY_LIMIT = 10
REDIS_URL = os.environ.get("KV_REST_API_URL", "")
REDIS_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")
IP_HASH_SALT = os.environ.get("CONVERT_IP_HASH_SALT", REDIS_TOKEN)
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.environ.get("CONVERT_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}

SUPPORTED_TYPES = {
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "bmp": "image/bmp",
    "gif": "image/gif",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "txt": "text/plain",
    "rtf": "application/rtf",
}


def _request(req, timeout=20, expect_json=True):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            if expect_json:
                return json.loads(body.decode("utf-8"))
            return body
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {err_body}") from exc
    except Exception as exc:
        raise RuntimeError(str(exc)) from exc


def _adobe_headers(token=None, content_type=None):
    headers = {
        "x-api-key": CLIENT_ID,
        "X-Request-ID": str(int(time.time() * 1000)),
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _get_token():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise RuntimeError("Adobe 凭据未配置")

    # Adobe PDF Services token endpoint only accepts client_id + client_secret.
    params = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }
    body = urllib.parse.urlencode(params).encode("utf-8")

    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )

    try:
        data = _request(req, timeout=10)
    except RuntimeError as exc:
        raise RuntimeError(f"Adobe token 获取失败: {exc}") from exc

    token = data.get("access_token")
    if not token:
        raise RuntimeError("Adobe 鉴权失败：未获取到 access_token")
    return token


def _create_asset(token, mime_type):
    body = json.dumps({"mediaType": mime_type}).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE.rstrip('/')}/assets",
        data=body,
        method="POST",
        headers=_adobe_headers(token, "application/json"),
    )
    data = _request(req, timeout=15)
    asset_id = data.get("assetID")
    upload_uri = data.get("uploadUri")
    if not asset_id or not upload_uri:
        raise RuntimeError(f"Adobe 未返回上传地址: {json.dumps(data, ensure_ascii=False)}")
    return asset_id, upload_uri


def _upload_to_asset(upload_uri, file_bytes, mime_type):
    req = urllib.request.Request(
        upload_uri,
        data=file_bytes,
        method="PUT",
        headers={
            "Content-Type": mime_type,
            "Content-Length": str(len(file_bytes)),
        },
    )
    _request(req, timeout=45, expect_json=False)


def _create_job(token, asset_id):
    body = json.dumps({"assetID": asset_id}).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE.rstrip('/')}/operation/createpdf",
        data=body,
        method="POST",
        headers=_adobe_headers(token, "application/json"),
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            location = resp.headers.get("Location") or resp.headers.get("location")
            if not location:
                raise RuntimeError("Adobe 未返回任务 Location")
            return location
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode(errors="replace")
        raise RuntimeError(f"Adobe 创建任务失败 ({exc.code}): {err_body}") from exc


def _poll_job(token, location):
    deadline = time.time() + MAX_POLL_SECONDS

    while time.time() < deadline:
        req = urllib.request.Request(
            location,
            method="GET",
            headers=_adobe_headers(token),
        )
        data = _request(req, timeout=15)

        status = data.get("status")
        if status == "done":
            download_uri = data.get("asset", {}).get("downloadUri")
            if not download_uri:
                raise RuntimeError("Adobe 返回完成但缺少下载地址")
            return download_uri
        if status in ("failed", "cancelled"):
            error_info = data.get("error", {}).get("message", status)
            raise RuntimeError(f"Adobe 转换失败: {error_info}")

        time.sleep(POLL_INTERVAL_SECONDS)

    raise RuntimeError("Adobe 转换超时，请重试")


def _download_pdf(token, download_uri):
    req = urllib.request.Request(download_uri, method="GET")
    try:
        pdf_bytes = _request(req, timeout=45, expect_json=False)
    except RuntimeError:
        auth_req = urllib.request.Request(
            download_uri,
            method="GET",
            headers=_adobe_headers(token),
        )
        pdf_bytes = _request(auth_req, timeout=45, expect_json=False)

    if not pdf_bytes.startswith(b"%PDF"):
        raise RuntimeError("Adobe 下载结果不是有效 PDF")
    return pdf_bytes


def convert(file_bytes, mime_type):
    token = _get_token()
    asset_id, upload_uri = _create_asset(token, mime_type)
    _upload_to_asset(upload_uri, file_bytes, mime_type)
    location = _create_job(token, asset_id)
    download_uri = _poll_job(token, location)
    return _download_pdf(token, download_uri)


# ---- 频率限制（Upstash Redis）----

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
        print(f"[convert] Redis 命令失败 {command}: {exc}")
        raise RuntimeError("Redis 命令失败") from exc


def _hash_ip(ip: str) -> str:
    material = f"{IP_HASH_SALT}:{ip}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def _check_rate_limit(ip: str) -> tuple:
    """返回 (allowed: bool, count: int)，失败时放行以避免阻断正常用户"""
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        ip_hash = _hash_ip(ip)
        key = f"cv:rate:{ip_hash}:{today}"

        count = int(_redis_cmd("incr", key))

        if count == 1:
            seconds_left = int(86400 - time.time() % 86400)
            _redis_cmd("expire", key, seconds_left, timeout=3)

        return count <= DAILY_LIMIT, count
    except RuntimeError:
        # Redis 不可用时放行，避免阻断正常用户
        return True, 0


def _client_ip(headers) -> str:
    raw = headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not raw:
        raw = headers.get("X-Real-IP", "").strip()
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return "unknown"


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._respond(400, {"ok": False, "error": "请使用 multipart/form-data 上传"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._respond(400, {"ok": False, "error": "Content-Length 无效"})
            return

        if content_length <= 0:
            self._respond(400, {"ok": False, "error": "请求体为空"})
            return
        if content_length > MAX_FILE_BYTES + 4096:
            self._respond(413, {"ok": False, "error": "文件过大，上限 10 MB"})
            return

        # 频率检查在读取 body 之前，避免已限流用户浪费带宽
        ip = _client_ip(self.headers)
        allowed, count = _check_rate_limit(ip)
        if not allowed:
            self._respond(429, {"ok": False, "error": f"今日转换已达上限，明天再来吧"})
            return

        raw = self.rfile.read(content_length)
        file_bytes, filename, uploaded_mime = _parse_multipart(raw, content_type)
        if not file_bytes:
            self._respond(400, {"ok": False, "error": "未找到上传文件"})
            return
        if len(file_bytes) > MAX_FILE_BYTES:
            self._respond(413, {"ok": False, "error": "文件过大，上限 10 MB"})
            return

        filename = _safe_filename(filename)
        ext = _file_ext(filename)
        mime_type = _canonical_mime(ext, uploaded_mime)
        if not mime_type:
            self._respond(400, {"ok": False, "error": "不支持的文件格式"})
            return

        print(f"[convert] 收到文件: {filename} ({mime_type}) {len(file_bytes)} bytes (IP 今日第 {count} 次)")

        try:
            pdf_bytes = convert(file_bytes, mime_type)
        except RuntimeError as exc:
            print(f"[convert] 错误: {exc}")
            self._respond(502, {"ok": False, "error": str(exc)})
            return

        out_name = _output_filename(filename)

        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Disposition", _content_disposition(out_name))
        self.send_header("Content-Length", str(len(pdf_bytes)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(pdf_bytes)

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
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


def _parse_multipart(body, content_type):
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[len("boundary="):].strip('"')

    if not boundary:
        return None, None, None

    b_boundary = boundary.encode("utf-8")
    parts = body.split(b"--" + b_boundary)

    for part in parts:
        if b"Content-Disposition:" not in part or b"filename=" not in part:
            continue

        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue

        headers_raw = part[:header_end].decode("utf-8", errors="replace")
        file_data = part[header_end + 4:].rstrip(b"\r\n")
        filename = "input"
        mime_type = "application/octet-stream"

        for h in headers_raw.split("\r\n"):
            if "filename=" in h:
                fname_part = h.split("filename=", 1)[1].strip().strip('"')
                filename = fname_part or filename
            if h.lower().startswith("content-type:"):
                mime_type = h.split(":", 1)[1].strip()

        return file_data, filename, mime_type

    return None, None, None


def _safe_filename(filename):
    filename = (filename or "input").replace("\\", "/")
    filename = os.path.basename(filename or "input")
    filename = filename.replace("\r", "").replace("\n", "").replace('"', "")
    filename = re.sub(r"[^\w.\-() \u4e00-\u9fff]", "_", filename, flags=re.UNICODE)
    return filename.strip(" .") or "input"


def _file_ext(filename):
    if "." not in filename:
        return ""
    return filename.rsplit(".", 1)[1].lower()


def _canonical_mime(ext, uploaded_mime):
    if ext in SUPPORTED_TYPES:
        return SUPPORTED_TYPES[ext]

    uploaded_mime = (uploaded_mime or "").lower()
    for allowed_mime in set(SUPPORTED_TYPES.values()):
        if uploaded_mime == allowed_mime:
            return uploaded_mime
    return None


def _output_filename(filename):
    base = filename.rsplit(".", 1)[0] if "." in filename else filename
    return _safe_filename(base + ".pdf")


def _content_disposition(filename):
    ascii_name = re.sub(r"[^A-Za-z0-9._() -]", "_", filename).strip(" .")
    if not ascii_name or ascii_name == ".pdf":
        ascii_name = "converted.pdf"
    quoted_name = urllib.parse.quote(filename, safe="")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted_name}'
