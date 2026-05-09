"""SSH terminal creation + term-host mapping + pending-command store."""
from __future__ import annotations
import json, shlex
from pathlib import Path
import tornado.ioloop
from tornado import web

from .jsonio import write_json_atomic
from .hosts import CONFIG_DIR, get_host

TERM_HOSTS_FILE       = CONFIG_DIR / "term-hosts.json"
PENDING_COMMANDS_FILE = CONFIG_DIR / "pending-commands.json"

PTY_READY_DELAY_SEC = 1.5


# ----- term-hosts store -----

def load_term_hosts() -> dict:
    if not TERM_HOSTS_FILE.is_file():
        return {}
    try:
        return json.loads(TERM_HOSTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_term_hosts(data: dict) -> None:
    write_json_atomic(TERM_HOSTS_FILE, data)


def set_term_host(name: str, host_id: str):
    data = load_term_hosts()
    data[name] = host_id
    save_term_hosts(data)


def remove_term_host(name: str):
    data = load_term_hosts()
    if name in data:
        del data[name]
        save_term_hosts(data)


def sync_term_hosts(term_mgr):
    """부팅 시 + 주기적: Jupyter 의 살아있는 terminal 만 남기기."""
    if term_mgr is None:
        return
    try:
        alive = {t["name"] for t in term_mgr.list()}
    except Exception:
        alive = set()
    data = load_term_hosts()
    pruned = {k: v for k, v in data.items() if k in alive}
    if pruned != data:
        save_term_hosts(pruned)


# ----- pending command store -----

def load_pending() -> dict:
    if not PENDING_COMMANDS_FILE.is_file():
        return {}
    try:
        return json.loads(PENDING_COMMANDS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_pending(data: dict) -> None:
    write_json_atomic(PENDING_COMMANDS_FILE, data)


def set_pending(name: str, command: str):
    data = load_pending()
    data[name] = command
    save_pending(data)


def remove_pending(name: str):
    data = load_pending()
    if name in data:
        del data[name]
        save_pending(data)


# ----- handlers (factory) -----

def make_handlers(BaseHandler):

    class NewSshTerminalHandler(BaseHandler):
        @web.authenticated
        def post(self):
            body = json.loads(self.request.body or b"{}")
            host_id = body.get("host_id", "local")
            host = get_host(host_id)
            if host is None:
                raise web.HTTPError(404, f"unknown host_id={host_id}")

            term_mgr = self.settings.get("terminal_manager")
            if term_mgr is None:
                raise web.HTTPError(500, "terminal_manager not available")
            term_model = term_mgr.create()
            name = term_model["name"]
            set_term_host(name, host_id)

            if host.get("connect"):
                target = host["connect"]
                tornado.ioloop.IOLoop.current().call_later(
                    PTY_READY_DELAY_SEC,
                    _write_ssh_command, term_mgr, name, target,
                )
            self.json_response({"name": name, "host_id": host_id})


    class TermHostsHandler(BaseHandler):
        @web.authenticated
        def get(self):
            self.json_response(load_term_hosts())


    class TermDeleteHookHandler(BaseHandler):
        """프런트엔드가 Jupyter /api/terminals/<name> DELETE 후 호출 — term-hosts cleanup."""
        @web.authenticated
        def post(self, name):
            remove_term_host(name)
            remove_pending(name)
            self.set_status(204)
            self.finish()


    class PendingListHandler(BaseHandler):
        @web.authenticated
        def get(self):
            self.json_response(load_pending())


    class PendingItemHandler(BaseHandler):
        @web.authenticated
        def post(self, name):
            """사용자 클릭 — 보류된 startup command 실행."""
            pending = load_pending()
            cmd = pending.get(name)
            if cmd is None:
                raise web.HTTPError(404, "no pending command for this terminal")
            term_mgr = self.settings.get("terminal_manager")
            t = term_mgr.get_terminal(name) if term_mgr else None
            if t is None or getattr(t, "ptyproc", None) is None:
                raise web.HTTPError(404, "terminal not found")
            for line in [l for l in cmd.split("\n") if l.strip()]:
                try:
                    t.ptyproc.write(line + "\r")
                except Exception:
                    pass
            remove_pending(name)
            self.set_status(204)
            self.finish()

        @web.authenticated
        def delete(self, name):
            remove_pending(name)
            self.set_status(204)
            self.finish()


    return {
        "NewSshTerminalHandler":  NewSshTerminalHandler,
        "TermHostsHandler":       TermHostsHandler,
        "TermDeleteHookHandler":  TermDeleteHookHandler,
        "PendingListHandler":     PendingListHandler,
        "PendingItemHandler":     PendingItemHandler,
    }


def _write_ssh_command(term_mgr, name, target):
    t = term_mgr.get_terminal(name)
    if t is None or getattr(t, "ptyproc", None) is None:
        return
    t.ptyproc.write(f"exec ssh {shlex.quote(target)}\r")
