"""Jupyter Notebook 6 server extension for Claude Notebook."""

import json
import os
import re
from pathlib import Path

from tornado import web
from notebook.utils import url_path_join as ujoin
from notebook.base.handlers import IPythonHandler

STATIC_DIR = Path(__file__).parent.parent / "static"


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def is_safe_path(workspace: Path, requested_path: str) -> bool:
    try:
        resolved = (workspace / requested_path).resolve()
        return str(resolved).startswith(str(workspace))
    except (ValueError, OSError):
        return False


def get_git_remote_url(dir_path: Path):
    git_config = dir_path / ".git" / "config"
    if not git_config.is_file():
        return None
    try:
        text = git_config.read_text(encoding="utf-8")
        match = re.search(r'\[remote "origin"\][^\[]*url\s*=\s*(.+)', text)
        if not match:
            return None
        url = match.group(1).strip()
        ssh_match = re.match(r'git@github\.com:(.+?)(?:\.git)?$', url)
        if ssh_match:
            return f"https://github.com/{ssh_match.group(1)}"
        https_match = re.match(r'(https://github\.com/.+?)(?:\.git)?$', url)
        if https_match:
            return https_match.group(1)
        return None
    except (OSError, ValueError):
        return None


SKIP_DIRS = {
    '__pycache__', 'node_modules', '.git', '.venv', 'venv',
    '.Trash', 'Library', '.cache', '.local', '.npm', '.nvm',
    '.zsh_sessions', '.ipython', '.claude',
}


def get_directory_listing(dir_path: Path, rel_base: Path) -> list:
    """List a single directory level (non-recursive). Fast."""
    items = []
    try:
        entries = sorted(dir_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        return items
    for entry in entries:
        if entry.name in SKIP_DIRS:
            continue
        rel = str(entry.relative_to(rel_base))
        if entry.is_dir():
            node = {
                "name": entry.name,
                "path": rel,
                "type": "directory",
                "has_children": True,
            }
            repo_url = get_git_remote_url(entry)
            if repo_url:
                node["repo_url"] = repo_url
            items.append(node)
        else:
            items.append({
                "name": entry.name,
                "path": rel,
                "type": "file",
            })
    return items


CONFIG_DIR = Path(__file__).parent.parent / "config"
CONFIG_DIR.mkdir(exist_ok=True)

# Legacy location — migrate on first read
_LEGACY_NAMES_FILE = Path(__file__).parent.parent / ".terminal_names.json"
NAMES_FILE = CONFIG_DIR / "terminal-names.json"


def _read_config(filepath):
    """Read a JSON config file, return dict or empty dict on failure."""
    try:
        return json.loads(filepath.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_config(filepath, data):
    """Write a JSON config file."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_names():
    """Read terminal config. Migrates from legacy location if needed."""
    # Migrate legacy file
    if _LEGACY_NAMES_FILE.is_file() and not NAMES_FILE.is_file():
        _LEGACY_NAMES_FILE.rename(NAMES_FILE)
    data = _read_config(NAMES_FILE)
    # Migrate legacy format: {name: "displayName"} -> {slot: {display_name, command}}
    if data and all(isinstance(v, str) for v in data.values()):
        migrated = {}
        for i, (k, v) in enumerate(data.items(), 1):
            migrated[str(i)] = {"display_name": v, "command": ""}
        _write_names(migrated)
        return migrated
    return data


def _write_names(data):
    _write_config(NAMES_FILE, data)


TERMINAL_UPLOAD_DIR = "uploads"  # Fixed subdir for terminal uploads


def unique_filepath(dest: Path, fname: str) -> Path:
    """Return a non-colliding path: name.ext -> name (1).ext -> name (2).ext ..."""
    fpath = dest / fname
    if not fpath.exists():
        return fpath
    stem = Path(fname).stem
    suffix = Path(fname).suffix
    i = 1
    while True:
        candidate = dest / f"{stem} ({i}){suffix}"
        if not candidate.exists():
            return candidate
        i += 1


IMAGE_CONTENT_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.bmp': 'image/bmp',
}


# ---------------------------------------------------------------------------
# Base handler with shared helpers
# ---------------------------------------------------------------------------

class BaseHandler(IPythonHandler):
    """Common helpers shared by all Claude Notebook handlers."""

    def json_response(self, data):
        """Serialize *data* as JSON and finish the response."""
        self.set_header("Content-Type", "application/json; charset=utf-8")
        self.finish(json.dumps(data, ensure_ascii=False))

    def get_xsrf_string(self):
        """Return the XSRF token as a str (decoded from bytes if needed)."""
        xsrf = self.xsrf_token
        if isinstance(xsrf, bytes):
            xsrf = xsrf.decode("utf-8")
        return xsrf

    def inject_script(self, html, **variables):
        """Inject a ``<script>`` block that sets ``window.__KEY = "value"`` for each kwarg."""
        parts = "".join(
            f'window.{key} = {json.dumps(value)};' for key, value in variables.items()
        )
        inject = f'<script>{parts}</script>'
        return html.replace('</head>', inject + '\n</head>')

    def get_workspace(self):
        """Return the workspace root ``Path``."""
        return self.settings["claude_notebook_path"]

    def validate_path(self, file_path):
        """Validate *file_path* against the workspace and return the resolved ``Path``.

        Raises ``tornado.web.HTTPError`` on invalid or missing paths.
        """
        workspace = self.get_workspace()
        if not file_path:
            raise web.HTTPError(400, "path required")
        if not is_safe_path(workspace, file_path):
            raise web.HTTPError(400, "Invalid path: %s" % file_path)
        full_path = (workspace / file_path).resolve()
        return full_path


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

class TerminalNamesHandler(BaseHandler):
    @web.authenticated
    def get(self):
        self.json_response(_read_names())

    @web.authenticated
    def put(self):
        body = json.loads(self.request.body)
        slot = body.get("slot")
        display_name = body.get("display_name", "")
        command = body.get("command", "")
        if not slot:
            raise web.HTTPError(400, "slot required")
        names = _read_names()
        chat_mode = body.get("chat_mode", False)
        names[str(slot)] = {"display_name": display_name, "command": command, "chat_mode": chat_mode}
        _write_names(names)
        self.json_response({"ok": True})

    @web.authenticated
    def delete(self):
        slot = self.get_argument("slot", None)
        if not slot:
            raise web.HTTPError(400, "slot required")
        names = _read_names()
        names.pop(str(slot), None)
        # Re-index slots to keep them sequential
        reindexed = {}
        for i, key in enumerate(sorted(names.keys(), key=lambda x: int(x)), 1):
            reindexed[str(i)] = names[key]
        _write_names(reindexed)
        self.json_response({"ok": True})


class ConfigHandler(BaseHandler):
    """Generic key-value config store. Files saved as config/<key>.json."""

    _VALID_KEY = re.compile(r'^[a-zA-Z0-9_-]+$')

    def _config_path(self, key):
        if not key or not self._VALID_KEY.match(key):
            raise web.HTTPError(400, "Invalid config key: %s" % key)
        return CONFIG_DIR / f"{key}.json"

    @web.authenticated
    def get(self):
        key = self.get_argument("key", None)
        if not key:
            raise web.HTTPError(400, "key required")
        self.json_response(_read_config(self._config_path(key)))

    @web.authenticated
    def put(self):
        body = json.loads(self.request.body)
        key = body.get("key")
        data = body.get("data")
        if not key:
            raise web.HTTPError(400, "key required")
        if data is None:
            raise web.HTTPError(400, "data required")
        _write_config(self._config_path(key), data)
        self.json_response({"ok": True})


class WorkspaceViewerHandler(BaseHandler):
    @web.authenticated
    def get(self):
        base_url = self.settings.get("base_url", "/")
        viewer_base = ujoin(base_url, "claude-notebook")
        html = STATIC_DIR.joinpath("index.html").read_text(encoding="utf-8")
        html = html.replace('href="/style.css"', f'href="{viewer_base}/static/style.css"')
        html = html.replace('src="/app.js"', f'src="{viewer_base}/static/app.js"')
        xsrf = self.get_xsrf_string()
        html = self.inject_script(
            html,
            __VIEWER_BASE=viewer_base,
            __XSRF_TOKEN=xsrf,
        )
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.finish(html)


class WorkspaceTerminalHandler(BaseHandler):
    @web.authenticated
    def get(self):
        base_url = self.settings.get("base_url", "/")
        viewer_base = ujoin(base_url, "claude-notebook")
        html = STATIC_DIR.joinpath("terminal.html").read_text(encoding="utf-8")
        html = html.replace('href="terminal.css"', f'href="{viewer_base}/static/terminal.css"')
        html = html.replace('src="terminal.js"', f'src="{viewer_base}/static/terminal.js"')
        xsrf = self.get_xsrf_string()
        html = self.inject_script(
            html,
            __VIEWER_BASE=viewer_base,
            __JUPYTER_BASE=base_url.rstrip("/"),
            __XSRF_TOKEN=xsrf,
        )
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.set_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.finish(html)


class WorkspaceStaticHandler(BaseHandler):
    @web.authenticated
    def get(self, filename):
        filepath = STATIC_DIR / filename
        if not filepath.is_file() or not str(filepath.resolve()).startswith(str(STATIC_DIR.resolve())):
            raise web.HTTPError(404)
        content_types = {
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.html': 'text/html; charset=utf-8',
        }
        ct = content_types.get(filepath.suffix, 'application/octet-stream')
        self.set_header("Content-Type", ct)
        self.finish(filepath.read_bytes())


class WorkspaceTreeHandler(BaseHandler):
    @web.authenticated
    def get(self):
        workspace = self.get_workspace()
        sub = self.get_argument("path", "")
        if sub and not is_safe_path(workspace, sub):
            raise web.HTTPError(400, "Invalid path")
        target = (workspace / sub).resolve() if sub else workspace
        if not target.is_dir():
            raise web.HTTPError(404, "Directory not found")
        tree = get_directory_listing(target, workspace)
        self.json_response(tree)


class WorkspaceFileHandler(BaseHandler):
    @web.authenticated
    def get(self):
        workspace = self.get_workspace()
        file_path = self.get_argument("path", None)
        raw_mode = self.get_argument("raw", None)
        full_path = self.validate_path(file_path)
        if not full_path.is_file():
            raise web.HTTPError(404, "Not found: %s" % file_path)
        ext = full_path.suffix.lower()

        # Image or raw mode: serve as binary
        if raw_mode is not None or ext in IMAGE_CONTENT_TYPES:
            try:
                data = full_path.read_bytes()
            except Exception as e:
                raise web.HTTPError(500, "Read error: %s" % str(e))
            ct = IMAGE_CONTENT_TYPES.get(ext, 'application/octet-stream')
            self.set_header("Content-Type", ct)
            self.set_header("Content-Length", str(len(data)))
            self.set_header("Cache-Control", "public, max-age=3600")
            self.write(data)
            self.finish()
            return

        try:
            content = full_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # Binary file that's not in IMAGE_CONTENT_TYPES — serve raw
            data = full_path.read_bytes()
            self.set_header("Content-Type", "application/octet-stream")
            self.set_header("Content-Length", str(len(data)))
            self.write(data)
            self.finish()
            return
        except Exception as e:
            raise web.HTTPError(500, str(e))

        self.json_response({
            "path": file_path,
            "name": full_path.name,
            "content": content,
            "extension": ext,
        })


class WorkspaceUploadHandler(BaseHandler):
    """Upload files to workspace."""
    @web.authenticated
    def post(self):
        workspace = self.get_workspace()
        target_dir = self.get_argument("dir", "")
        if target_dir and not is_safe_path(workspace, target_dir):
            raise web.HTTPError(400, "Invalid dir")
        dest = (workspace / target_dir).resolve() if target_dir else workspace
        if not dest.is_dir():
            raise web.HTTPError(400, "Target is not a directory")
        uploaded = []
        for field_name, file_list in self.request.files.items():
            for f in file_list:
                raw_name = f["filename"]
                # Support relative paths for folder uploads (e.g. "photos/a.png")
                rel = Path(raw_name)
                # Reject absolute or path-traversal attempts
                if rel.is_absolute() or ".." in rel.parts:
                    continue
                fname = str(rel)
                if not fname or not rel.name:
                    continue
                file_dest = dest / rel.parent
                if not str(file_dest.resolve()).startswith(str(workspace.resolve())):
                    continue  # safety check
                file_dest.mkdir(parents=True, exist_ok=True)
                fpath = unique_filepath(file_dest, rel.name)
                fpath.write_bytes(f["body"])
                uploaded.append(str(fpath.relative_to(workspace)))
        self.json_response({"uploaded": uploaded})


class WorkspaceDeleteHandler(BaseHandler):
    """Delete a file or empty folder."""
    @web.authenticated
    def delete(self):
        workspace = self.get_workspace()
        file_path = self.get_argument("path", None)
        full_path = self.validate_path(file_path)
        if not full_path.exists():
            raise web.HTTPError(404, "Not found")
        # Safety: don't delete workspace root or .agent
        if full_path == workspace or ".agent" in full_path.parts:
            raise web.HTTPError(403, "Cannot delete this path")
        import shutil
        if full_path.is_dir():
            shutil.rmtree(full_path)
        else:
            full_path.unlink()
        self.json_response({"deleted": file_path})


class WorkspaceSaveHandler(BaseHandler):
    """Save (overwrite) a text file in the workspace."""
    @web.authenticated
    def put(self):
        workspace = self.get_workspace()
        body = json.loads(self.request.body)
        file_path = body.get("path")
        content = body.get("content")
        if content is None:
            raise web.HTTPError(400, "content required")
        full_path = self.validate_path(file_path)
        if not full_path.is_file():
            raise web.HTTPError(404, "Not found: %s" % file_path)
        try:
            full_path.write_text(content, encoding="utf-8")
        except OSError as e:
            raise web.HTTPError(500, "Write error: %s" % str(e))
        self.json_response({"saved": file_path})


class WorkspaceDownloadHandler(BaseHandler):
    """Download a file as attachment."""
    @web.authenticated
    def get(self):
        workspace = self.get_workspace()
        file_path = self.get_argument("path", None)
        if not file_path or not is_safe_path(workspace, file_path):
            raise web.HTTPError(400, "Invalid path")
        full_path = (workspace / file_path).resolve()
        if not full_path.is_file():
            raise web.HTTPError(404, "Not found")
        data = full_path.read_bytes()
        self.set_header("Content-Type", "application/octet-stream")
        self.set_header("Content-Disposition", f'attachment; filename="{full_path.name}"')
        self.set_header("Content-Length", str(len(data)))
        self.write(data)
        self.finish()


class TerminalUploadHandler(BaseHandler):
    """Upload file to fixed dir for terminal use, return metadata."""
    @web.authenticated
    def post(self):
        workspace = self.get_workspace()
        upload_dir = workspace / TERMINAL_UPLOAD_DIR
        upload_dir.mkdir(exist_ok=True)
        results = []
        for field_name, file_list in self.request.files.items():
            for f in file_list:
                fname = Path(f["filename"]).name
                if not fname:
                    continue
                fpath = unique_filepath(upload_dir, fname)
                fpath.write_bytes(f["body"])
                results.append({
                    "name": fpath.name,
                    "path": str(fpath),
                    "relative": str(fpath.relative_to(workspace)),
                    "size": len(f["body"]),
                    "content_type": f.get("content_type", "application/octet-stream"),
                })
        self.json_response({"files": results})


# ---------------------------------------------------------------------------
# Extension entry points
# ---------------------------------------------------------------------------

def _jupyter_server_extension_paths():
    return [{"module": "jupyter_ext"}]


def _auto_create_terminals(nb_app):
    """Create terminals from saved config on server startup."""
    from tornado.ioloop import IOLoop

    def _create():
        term_mgr = nb_app.web_app.settings.get('terminal_manager')
        if term_mgr is None:
            return
        saved = _read_names()
        if not saved:
            return
        for slot in sorted(saved.keys(), key=lambda x: int(x)):
            cfg = saved[slot]
            try:
                model = term_mgr.create()
                name = model["name"]
                command = cfg.get("command", "")
                if command:
                    term = term_mgr.get_terminal(name)
                    lines = [l for l in command.split("\n") if l.strip()]
                    for idx, line in enumerate(lines):
                        def _send_line(t=term, cmd=line):
                            try:
                                t.ptyproc.write(cmd + "\r")
                            except Exception:
                                pass
                        IOLoop.current().call_later(1.5 + idx * 3, _send_line)
                nb_app.log.info("Auto-created terminal %s (slot %s: %s)",
                                name, slot, cfg.get("display_name", ""))
            except Exception as e:
                nb_app.log.warning("Failed to auto-create terminal for slot %s: %s", slot, e)

    # Delay to ensure terminal manager is fully ready
    IOLoop.current().call_later(2, _create)


def load_jupyter_server_extension(nb_app):
    workspace = Path(nb_app.notebook_dir).resolve()
    nb_app.web_app.settings["claude_notebook_path"] = workspace

    # Open new terminals in the workspace directory instead of process cwd
    term_mgr = nb_app.web_app.settings.get('terminal_manager')
    if term_mgr is not None:
        term_mgr.term_settings['cwd'] = str(workspace)

    base_url = nb_app.web_app.settings["base_url"]
    handlers = [
        (ujoin(base_url, r"/claude-notebook"), WorkspaceTerminalHandler),
        (ujoin(base_url, r"/claude-notebook/terminal"), WorkspaceTerminalHandler),
        (ujoin(base_url, r"/claude-notebook/files"), WorkspaceViewerHandler),
        (ujoin(base_url, r"/claude-notebook/static/(.+)"), WorkspaceStaticHandler),
        (ujoin(base_url, r"/claude-notebook/api/tree"), WorkspaceTreeHandler),
        (ujoin(base_url, r"/claude-notebook/api/file"), WorkspaceFileHandler),
        (ujoin(base_url, r"/claude-notebook/api/upload"), WorkspaceUploadHandler),
        (ujoin(base_url, r"/claude-notebook/api/save"), WorkspaceSaveHandler),
        (ujoin(base_url, r"/claude-notebook/api/delete"), WorkspaceDeleteHandler),
        (ujoin(base_url, r"/claude-notebook/api/download"), WorkspaceDownloadHandler),
        (ujoin(base_url, r"/claude-notebook/api/terminal-upload"), TerminalUploadHandler),
        (ujoin(base_url, r"/claude-notebook/api/terminal-names"), TerminalNamesHandler),
        (ujoin(base_url, r"/claude-notebook/api/config"), ConfigHandler),
    ]
    nb_app.web_app.add_handlers(".*$", handlers)
    nb_app.log.info("Claude Notebook extension loaded at %s/claude-notebook (workspace: %s)", base_url, workspace)

    # Auto-create saved terminals
    _auto_create_terminals(nb_app)
