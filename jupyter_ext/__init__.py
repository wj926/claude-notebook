"""Jupyter Notebook 6 server extension for Workspace Viewer."""

import json
import os
import re
from pathlib import Path

from tornado import web
from notebook.utils import url_path_join as ujoin
from notebook.base.handlers import IPythonHandler

STATIC_DIR = Path(__file__).parent.parent / "static"


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
    except Exception:
        return None


SKIP_DIRS = {
    '__pycache__', 'node_modules', '.git', '.venv', 'venv',
    '.Trash', 'Library', '.cache', '.local', '.npm', '.nvm',
    '.zsh_sessions', '.ipython',
}


def get_directory_listing(dir_path: Path, rel_base: Path) -> list:
    """List a single directory level (non-recursive). Fast."""
    items = []
    try:
        entries = sorted(dir_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        return items
    for entry in entries:
        if entry.name.startswith('.') and entry.name not in ('.bkit', '.claude'):
            continue
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


class WorkspaceViewerHandler(IPythonHandler):
    @web.authenticated
    def get(self):
        base_url = self.settings.get("base_url", "/")
        viewer_base = ujoin(base_url, "workspace-viewer")
        html = STATIC_DIR.joinpath("index.html").read_text(encoding="utf-8")
        html = html.replace('href="/style.css"', f'href="{viewer_base}/static/style.css"')
        html = html.replace('src="/app.js"', f'src="{viewer_base}/static/app.js"')
        inject = f'<script>window.__VIEWER_BASE = "{viewer_base}";</script>'
        html = html.replace('</head>', inject + '\n</head>')
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.finish(html)


class WorkspaceTerminalHandler(IPythonHandler):
    @web.authenticated
    def get(self):
        base_url = self.settings.get("base_url", "/")
        viewer_base = ujoin(base_url, "workspace-viewer")
        html = STATIC_DIR.joinpath("terminal.html").read_text(encoding="utf-8")
        inject = (
            f'<script>'
            f'window.__VIEWER_BASE = "{viewer_base}";'
            f'window.__JUPYTER_BASE = "{base_url.rstrip("/")}";'
            f'</script>'
        )
        html = html.replace('</head>', inject + '\n</head>')
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.finish(html)


class WorkspaceStaticHandler(IPythonHandler):
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


class WorkspaceTreeHandler(IPythonHandler):
    @web.authenticated
    def get(self):
        workspace = self.settings["workspace_viewer_path"]
        sub = self.get_argument("path", "")
        if sub and not is_safe_path(workspace, sub):
            raise web.HTTPError(400, "Invalid path")
        target = (workspace / sub).resolve() if sub else workspace
        if not target.is_dir():
            raise web.HTTPError(404, "Directory not found")
        tree = get_directory_listing(target, workspace)
        self.set_header("Content-Type", "application/json; charset=utf-8")
        self.finish(json.dumps(tree, ensure_ascii=False))


class WorkspaceFileHandler(IPythonHandler):
    @web.authenticated
    def get(self):
        workspace = self.settings["workspace_viewer_path"]
        file_path = self.get_argument("path", None)
        if not file_path or not is_safe_path(workspace, file_path):
            raise web.HTTPError(400, "Invalid path")
        full_path = (workspace / file_path).resolve()
        if not full_path.is_file():
            raise web.HTTPError(404, "File not found")
        try:
            content = full_path.read_text(encoding="utf-8")
            self.set_header("Content-Type", "application/json; charset=utf-8")
            self.finish(json.dumps({
                "path": file_path,
                "name": full_path.name,
                "content": content,
                "extension": full_path.suffix.lower(),
            }, ensure_ascii=False))
        except Exception as e:
            raise web.HTTPError(500, str(e))


def _jupyter_server_extension_paths():
    return [{"module": "jupyter_ext"}]


def load_jupyter_server_extension(nb_app):
    workspace = Path(nb_app.notebook_dir).resolve()
    nb_app.web_app.settings["workspace_viewer_path"] = workspace

    # Open new terminals in the workspace directory instead of process cwd
    term_mgr = nb_app.web_app.settings.get('terminal_manager')
    if term_mgr is not None:
        term_mgr.term_settings['cwd'] = str(workspace)

    base_url = nb_app.web_app.settings["base_url"]
    handlers = [
        (ujoin(base_url, r"/workspace-viewer"), WorkspaceViewerHandler),
        (ujoin(base_url, r"/workspace-viewer/terminal"), WorkspaceTerminalHandler),
        (ujoin(base_url, r"/workspace-viewer/static/(.+)"), WorkspaceStaticHandler),
        (ujoin(base_url, r"/workspace-viewer/api/tree"), WorkspaceTreeHandler),
        (ujoin(base_url, r"/workspace-viewer/api/file"), WorkspaceFileHandler),
    ]
    nb_app.web_app.add_handlers(".*$", handlers)
    nb_app.log.info("Workspace Viewer extension loaded at %s/workspace-viewer (workspace: %s)", base_url, workspace)
