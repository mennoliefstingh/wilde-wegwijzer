import base64
import hashlib
import hmac
import json
import mimetypes
import os
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from db import (
    DEFAULT_FESTIVAL_ID,
    MAX_PUBLIC_PIN_LABEL,
    admin_features,
    admin_public_pins,
    bootstrap_payload,
    create_admin_feature,
    create_public_pin,
    delete_admin_feature,
    delete_public_pin,
    init_database,
    patch_admin_feature,
    patch_public_pin,
    seed_database,
)


ROOT = Path(__file__).resolve().parent
COOKIE_NAME = "ww_admin"
SESSION_MAX_AGE = 7 * 24 * 60 * 60
PUBLIC_PIN_RATE_LIMIT = 24
PUBLIC_PIN_RATE_WINDOW = 10 * 60
PUBLIC_PIN_REQUESTS = {}


def load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv()

DATABASE_PATH = os.environ.get("DATABASE_PATH", str(ROOT / "data" / "wildewegwijzer.sqlite"))
SEED_PATH = os.environ.get("SEED_PATH", str(ROOT / "seed" / "wilde-weide-2026.json"))
FESTIVAL_ID = os.environ.get("FESTIVAL_ID", DEFAULT_FESTIVAL_ID)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
SESSION_SECRET = os.environ.get("SESSION_SECRET")
ADMIN_AUTH_DISABLED = os.environ.get("ADMIN_AUTH_DISABLED", "0").lower() in ("1", "true", "yes")


class WildeWegwijzerHandler(SimpleHTTPRequestHandler):
    server_version = "WildeWegwijzer/1.0"

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("GET")
            return
        self.serve_static()

    def do_POST(self):
        self.handle_api("POST")

    def do_PATCH(self):
        self.handle_api("PATCH")

    def do_DELETE(self):
        self.handle_api("DELETE")

    def handle_api(self, method):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        parts = [part for part in path.split("/") if part]

        try:
            if method == "GET" and path == "/api/bootstrap":
                self.send_json(bootstrap_payload(DATABASE_PATH, FESTIVAL_ID))
                return

            if method == "POST" and path == "/api/public-pins":
                self.check_public_pin_rate_limit()
                payload = self.read_json()
                pin = create_public_pin(DATABASE_PATH, payload, FESTIVAL_ID)
                self.send_json({"pin": pin}, HTTPStatus.CREATED)
                return

            if method == "POST" and path == "/api/admin/login":
                self.handle_admin_login()
                return

            if method == "POST" and path == "/api/admin/logout":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.send_header("Set-Cookie", expired_cookie())
                self.end_headers()
                return

            if len(parts) >= 2 and parts[0] == "api" and parts[1] == "admin":
                if not ADMIN_AUTH_DISABLED and not self.is_admin():
                    self.send_json({"error": "Niet ingelogd"}, HTTPStatus.UNAUTHORIZED)
                    return
                self.handle_admin_api(method, parts)
                return

            self.send_json({"error": "Niet gevonden"}, HTTPStatus.NOT_FOUND)
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self.log_error("API error: %s", error)
            self.send_json({"error": "Serverfout"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_admin_api(self, method, parts):
        if method == "GET" and parts == ["api", "admin", "features"]:
            self.send_json({"features": admin_features(DATABASE_PATH, FESTIVAL_ID)})
            return

        if method == "POST" and parts == ["api", "admin", "features"]:
            feature = create_admin_feature(DATABASE_PATH, self.read_json(), FESTIVAL_ID)
            self.send_json({"feature": feature}, HTTPStatus.CREATED)
            return

        if len(parts) == 4 and parts[:3] == ["api", "admin", "features"]:
            feature_id = unquote(parts[3])
            if method == "PATCH":
                feature = patch_admin_feature(DATABASE_PATH, feature_id, self.read_json(), FESTIVAL_ID)
                if not feature:
                    self.send_json({"error": "Niet gevonden"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json({"feature": feature})
                return
            if method == "DELETE":
                deleted = delete_admin_feature(DATABASE_PATH, feature_id, FESTIVAL_ID)
                self.send_json({"ok": deleted}, HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND)
                return

        if method == "GET" and parts == ["api", "admin", "public-pins"]:
            self.send_json({"pins": admin_public_pins(DATABASE_PATH, FESTIVAL_ID)})
            return

        if len(parts) == 4 and parts[:3] == ["api", "admin", "public-pins"]:
            pin_id = unquote(parts[3])
            if method == "PATCH":
                pin = patch_public_pin(DATABASE_PATH, pin_id, self.read_json(), FESTIVAL_ID)
                if not pin:
                    self.send_json({"error": "Niet gevonden"}, HTTPStatus.NOT_FOUND)
                else:
                    self.send_json({"pin": pin})
                return
            if method == "DELETE":
                deleted = delete_public_pin(DATABASE_PATH, pin_id, FESTIVAL_ID)
                self.send_json({"ok": deleted}, HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND)
                return

        self.send_json({"error": "Niet gevonden"}, HTTPStatus.NOT_FOUND)

    def handle_admin_login(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        redirect_to = safe_redirect(query.get("redirect", [""])[0])
        wants_redirect = bool(redirect_to)
        if ADMIN_AUTH_DISABLED:
            if wants_redirect:
                self.redirect(redirect_to)
            else:
                self.send_json({"ok": True, "authDisabled": True})
            return
        if not ADMIN_PASSWORD or not SESSION_SECRET:
            if wants_redirect:
                self.redirect(f"{redirect_to}?login=config")
                return
            self.send_json({"error": "Admin is niet geconfigureerd"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        payload = self.read_login_payload()
        password = str(payload.get("password") or "")
        if not hmac.compare_digest(password, ADMIN_PASSWORD):
            if wants_redirect:
                self.redirect(f"{redirect_to}?login=bad")
                return
            self.send_json({"error": "Nope"}, HTTPStatus.UNAUTHORIZED)
            return
        token = signed_session_token()
        if wants_redirect:
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", redirect_to)
            self.send_header("Cache-Control", "no-store")
            self.send_header(
                "Set-Cookie",
                f"{COOKIE_NAME}={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax",
            )
            self.end_headers()
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Set-Cookie",
            f"{COOKIE_NAME}={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax",
        )
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))

    def read_login_payload(self):
        content_type = self.headers.get("Content-Type", "")
        if "application/x-www-form-urlencoded" not in content_type:
            return self.read_json()
        length = int(self.headers.get("Content-Length") or 0)
        if length > 8 * 1024:
            raise ValueError("Request te groot")
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        data = parse_qs(raw)
        return {key: values[-1] if values else "" for key, values in data.items()}

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024:
            raise ValueError("Request te groot")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def is_admin(self):
        cookie = SimpleCookie(self.headers.get("Cookie"))
        token = cookie.get(COOKIE_NAME)
        return bool(token and verify_session_token(token.value))

    def check_public_pin_rate_limit(self):
        now = time.time()
        ip = self.client_address[0]
        entries = [stamp for stamp in PUBLIC_PIN_REQUESTS.get(ip, []) if now - stamp < PUBLIC_PIN_RATE_WINDOW]
        if len(entries) >= PUBLIC_PIN_RATE_LIMIT:
            raise ValueError("Even rustig aan met pins")
        entries.append(now)
        PUBLIC_PIN_REQUESTS[ip] = entries

    def serve_static(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path in ("/", "/share", "/share/"):
            path = "/index.html"
        elif path in ("/admin", "/admin/"):
            path = "/admin.html"

        relative = path.lstrip("/")
        if not static_path_allowed(relative):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        file_path = (ROOT / relative).resolve()
        if not str(file_path).startswith(str(ROOT)) or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if file_path.name == "manifest.webmanifest":
            content_type = "application/manifest+json"
        data = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control_for(relative))
        self.end_headers()
        self.wfile.write(data)


def static_path_allowed(relative):
    if not relative:
        return False
    allowed_files = {
        "index.html",
        "admin.html",
        "app.js",
        "admin.js",
        "styles.css",
        "sw.js",
        "manifest.webmanifest",
    }
    if relative in allowed_files:
        return True
    return relative.startswith(("assets/", "icons/", "vendor/"))


def safe_redirect(value):
    if value in ("/admin", "/admin/"):
        return "/admin"
    return ""


def cache_control_for(relative):
    if relative == "sw.js":
        return "no-cache"
    if relative.startswith(("assets/", "icons/")):
        return "public, max-age=31536000, immutable"
    if relative.endswith((".css", ".js")):
        return "public, max-age=86400"
    return "public, max-age=300"


def signed_session_token():
    payload = {"iat": int(time.time()), "exp": int(time.time()) + SESSION_MAX_AGE}
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    encoded = base64_url_encode(payload_bytes)
    signature = hmac.new(SESSION_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{base64_url_encode(signature)}"


def verify_session_token(token):
    if not SESSION_SECRET or "." not in token:
        return False
    encoded, signature = token.split(".", 1)
    expected = base64_url_encode(hmac.new(SESSION_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return False
    try:
        payload = json.loads(base64_url_decode(encoded).decode("utf-8"))
    except Exception:
        return False
    return int(payload.get("exp") or 0) >= int(time.time())


def expired_cookie():
    return f"{COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"


def base64_url_encode(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def base64_url_decode(value):
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def ensure_database():
    init_database(DATABASE_PATH)
    if Path(SEED_PATH).exists():
        seed_database(DATABASE_PATH, SEED_PATH, reset=False, only_if_empty=True)


def main():
    ensure_database()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    if ADMIN_AUTH_DISABLED:
        print("Admin auth disabled: /admin is open", flush=True)
    elif not ADMIN_PASSWORD or not SESSION_SECRET:
        print("Admin disabled: set ADMIN_PASSWORD and SESSION_SECRET to enable /admin", flush=True)
    server = ThreadingHTTPServer((host, port), WildeWegwijzerHandler)
    print(f"Wilde Wegwijzer serving on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
