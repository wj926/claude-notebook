"""SSH host registry + REST handlers (Spec 1 §5.2)."""
from __future__ import annotations
import json, re, subprocess
from pathlib import Path

from tornado import web

from .jsonio import write_json_atomic

CONFIG_DIR = Path(__file__).parent.parent / "config"
HOSTS_FILE = CONFIG_DIR / "hosts.json"

_VALID_CONNECT = re.compile(r"^[A-Za-z0-9._@:+\-/ ]+$")
_FORBIDDEN     = re.compile(r"[\n\r;|&`$\\]")

DEFAULT_HOSTS = {
    "hosts": [{"id": "local", "label": "local", "connect": None}],
    "current_id": "local",
}


def _slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", label.lower()).strip("-")
    return s or "host"


def load_hosts() -> dict:
    if not HOSTS_FILE.is_file():
        write_json_atomic(HOSTS_FILE, DEFAULT_HOSTS)
        return dict(DEFAULT_HOSTS)
    try:
        return json.loads(HOSTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return dict(DEFAULT_HOSTS)


def save_hosts(data: dict) -> None:
    write_json_atomic(HOSTS_FILE, data)


def get_host(host_id: str):
    return next((h for h in load_hosts()["hosts"] if h["id"] == host_id), None)


def validate_connect(connect):
    if connect is None:
        return None
    s = str(connect).strip()
    if not s:
        raise web.HTTPError(400, "empty connect")
    if _FORBIDDEN.search(s):
        raise web.HTTPError(400, f"forbidden char in connect: {s!r}")
    if not _VALID_CONNECT.match(s):
        raise web.HTTPError(400, f"invalid connect: {s!r}")
    return s


def make_handlers(BaseHandler):
    """Factory returning handler classes (avoids circular import)."""

    class HostsListHandler(BaseHandler):
        @web.authenticated
        def get(self):
            self.json_response(load_hosts())

        @web.authenticated
        def post(self):
            body = json.loads(self.request.body)
            label = (body.get("label") or "").strip()
            connect = validate_connect(body.get("connect"))
            if not label:
                raise web.HTTPError(400, "label required")
            data = load_hosts()
            base = _slug(label)
            existing_ids = {h["id"] for h in data["hosts"]}
            new_id, n = base, 1
            while new_id in existing_ids:
                n += 1
                new_id = f"{base}-{n}"
            data["hosts"].append({"id": new_id, "label": label, "connect": connect})
            save_hosts(data)
            self.json_response({"id": new_id})


    class HostItemHandler(BaseHandler):
        @web.authenticated
        def delete(self, host_id):
            # term-hosts.json may not exist yet (Task 3) — guard
            try:
                from .terminals import load_term_hosts
                term_hosts = load_term_hosts()
            except ImportError:
                term_hosts = {}
            in_use = [n for n, h in term_hosts.items() if h == host_id]
            if in_use:
                raise web.HTTPError(409, f"host in use by terminals: {in_use}")
            data = load_hosts()
            data["hosts"] = [h for h in data["hosts"] if h["id"] != host_id]
            if data.get("current_id") == host_id:
                data["current_id"] = "local"
            save_hosts(data)
            self.set_status(204)
            self.finish()


    class HostTestHandler(BaseHandler):
        @web.authenticated
        def post(self, host_id):
            host = get_host(host_id)
            if host is None:
                raise web.HTTPError(404, "unknown host")
            if host["id"] == "local" or not host.get("connect"):
                self.json_response({"status": "key_ok", "exit_code": 0, "stderr_excerpt": "(local)"})
                return
            connect = host["connect"]
            try:
                r = subprocess.run(
                    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                     "-o", "StrictHostKeyChecking=accept-new", connect, "true"],
                    capture_output=True, text=True, timeout=10,
                )
                stderr = (r.stderr or "")[:500]
                status = self._classify(r.returncode, stderr)
                self.json_response({"status": status, "exit_code": r.returncode, "stderr_excerpt": stderr})
            except subprocess.TimeoutExpired:
                self.json_response({"status": "unreachable", "exit_code": -1, "stderr_excerpt": "timeout"})

        @staticmethod
        def _classify(code, stderr):
            if code == 0: return "key_ok"
            s = stderr.lower()
            if "permission denied" in s or "keyboard-interactive" in s: return "auth_prompt_likely"
            if "could not resolve" in s or "connection timed out" in s or "network is unreachable" in s: return "unreachable"
            if "host key verification" in s or "remote host identification has changed" in s: return "host_key_error"
            if "bad configuration" in s or "no matching" in s: return "config_error"
            return "unknown_error"


    class CurrentHostHandler(BaseHandler):
        @web.authenticated
        def put(self):
            body = json.loads(self.request.body)
            host_id = body.get("id")
            if not get_host(host_id):
                raise web.HTTPError(404, "unknown host")
            data = load_hosts()
            data["current_id"] = host_id
            save_hosts(data)
            self.json_response({"current_id": host_id})

    return {
        "HostsListHandler":   HostsListHandler,
        "HostItemHandler":    HostItemHandler,
        "HostTestHandler":    HostTestHandler,
        "CurrentHostHandler": CurrentHostHandler,
    }
