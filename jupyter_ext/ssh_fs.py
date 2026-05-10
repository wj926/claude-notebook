"""SSH-backed filesystem operations (Spec 3 — 원격 파일 트리 PoC).

subprocess + ssh ControlMaster 멀티플렉싱으로 원격 디렉토리 read.
~/.ssh/config 의 Host alias (jump-server, nhn 등) 그대로 사용.

Stage a (현재): list_dir 만. 응답 포맷은 local get_directory_listing 과 1:1 호환.
"""

import shlex
import subprocess
from pathlib import Path

# ControlMaster 멀티플렉싱 — 첫 SSH 연결만 느리고 이후는 ms 단위 (codex 권장)
CONTROL_PATH = "/tmp/cn-ssh-%r@%h:%p"
SKIP_NAMES = {".git", "__pycache__", "node_modules", ".venv", ".pytest_cache"}


def _ssh_base(host_id, timeout=30):
    """ssh 공통 옵션 — BatchMode (password prompt 차단) + ControlMaster."""
    return [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={CONTROL_PATH}",
        "-o", "ControlPersist=300",  # 5분 유지 — 5초 단위 유저 클릭에 충분
        "-o", f"ConnectTimeout={min(timeout, 15)}",
        host_id,
    ]


def _safe_subpath(sub_path):
    """path traversal 방지 — `..`, 절대경로, leading slash 금지."""
    if not sub_path:
        return ""
    if sub_path.startswith("/"):
        raise ValueError("absolute path not allowed")
    parts = sub_path.split("/")
    if any(p == ".." for p in parts):
        raise ValueError("'..' not allowed")
    return sub_path


def list_dir(host_id, sub_path=""):
    """원격 호스트 의 sub_path (HOME 기준) 디렉토리 1 레벨 list.

    Returns: [{name, path, type, mtime, size?, has_children?}, ...]
    응답 포맷은 local get_directory_listing 과 동일.

    Raises: ValueError (unsafe path), RuntimeError (ssh failure).
    """
    sub = _safe_subpath(sub_path)
    # P0 fix (codex audit): shell quoting 만으로는 $(), backtick, \ 등 안전
    # 못 함. ssh 가 모든 args 를 remote shell 로 넘기므로, stdin script 로
    # 보내고 sub_path 는 positional arg 로 전달해 "$1" 로 quoted reference.
    # 그러면 sub_path 가 어떤 문자열이어도 remote shell expansion 차단됨.
    remote_script = (
        'cd "$HOME" 2>/dev/null || exit 1\n'
        'sub="$1"\n'
        'if [ -n "$sub" ]; then cd "$sub" 2>/dev/null || exit 1; fi\n'
        'find . -mindepth 1 -maxdepth 1 '
        '-printf "%y\\t%s\\t%T@\\t%P\\n" 2>/dev/null | sort\n'
    )
    cmd = _ssh_base(host_id) + ["sh", "-s", "--", sub]
    try:
        proc = subprocess.run(
            cmd, input=remote_script,
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ssh timeout after 30s")
    if proc.returncode != 0:
        # 1 = path 없음, 255 = ssh 자체 fail
        msg = proc.stderr.strip()[:300] or proc.stdout.strip()[:300]
        raise RuntimeError(f"ssh exit {proc.returncode}: {msg}")

    items = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t", 3)
        if len(parts) != 4:
            continue
        ty, size_s, mtime_s, name = parts
        if name in SKIP_NAMES:
            continue
        rel = f"{sub}/{name}" if sub else name
        try:
            mtime = float(mtime_s)
        except ValueError:
            mtime = None
        if ty == "d":
            items.append({
                "name": name,
                "path": rel,
                "type": "directory",
                "has_children": True,
                "mtime": mtime,
            })
        elif ty == "f":
            try:
                size = int(size_s)
            except ValueError:
                size = None
            items.append({
                "name": name,
                "path": rel,
                "type": "file",
                "mtime": mtime,
                "size": size,
            })
        # 'l' (symlink), 'p', 'b', 'c' 등은 PoC 단계에서 skip
    # local과 동일 정렬: 디렉토리 먼저, 이름 case-insensitive
    items.sort(key=lambda e: (e["type"] != "directory", e["name"].lower()))
    return items


# Spec 3-b: 원격 파일 read
_MAX_TEXT_PREVIEW = 2 * 1024 * 1024  # 2 MB — local 과 동일한 한도


def stat_file(host_id, sub_path):
    """원격 파일 stat — size + mtime + extension. 없으면 None.

    list_dir 처럼 sh -s + "$1" 로 path injection 차단.
    """
    sub = _safe_subpath(sub_path)
    if not sub:
        raise ValueError("path required")
    remote_script = (
        'cd "$HOME" 2>/dev/null || exit 1\n'
        'sub="$1"\n'
        'if [ ! -f "$sub" ]; then exit 2; fi\n'
        # %s = size, %T@ = mtime, 그 다음 file 자체 (file -b 의 mime)
        'stat -c "%s %Y" "$sub"\n'
    )
    cmd = _ssh_base(host_id) + ["sh", "-s", "--", sub]
    try:
        proc = subprocess.run(
            cmd, input=remote_script,
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("ssh timeout")
    if proc.returncode == 2:
        return None
    if proc.returncode != 0:
        raise RuntimeError(f"ssh exit {proc.returncode}: {proc.stderr.strip()[:200]}")
    parts = proc.stdout.strip().split()
    if len(parts) < 2:
        raise RuntimeError(f"unexpected stat output: {proc.stdout!r}")
    return {"size": int(parts[0]), "mtime": float(parts[1])}


def read_text(host_id, sub_path, max_size=_MAX_TEXT_PREVIEW):
    """원격 텍스트 파일 read. 큰 파일은 (None, size) 로 too_large 표시."""
    info = stat_file(host_id, sub_path)
    if info is None:
        raise FileNotFoundError(sub_path)
    if info["size"] > max_size:
        return None, info["size"]
    sub = _safe_subpath(sub_path)
    remote_script = (
        'cd "$HOME" 2>/dev/null || exit 1\n'
        'cat "$1"\n'
    )
    cmd = _ssh_base(host_id) + ["sh", "-s", "--", sub]
    proc = subprocess.run(
        cmd, input=remote_script.encode("utf-8"),
        capture_output=True, timeout=30,  # bytes 모드 (utf-8 decode 직접)
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh cat failed: {proc.stderr.decode('utf-8', 'replace')[:200]}")
    try:
        return proc.stdout.decode("utf-8"), info["size"]
    except UnicodeDecodeError:
        # binary file
        return None, info["size"]


# Spec 3-b 보완: 원격 binary read (PDF/이미지/HTML 등 raw stream)
_MAX_BINARY_RAW = 50 * 1024 * 1024  # 50 MB — 기본 상한


def read_binary(host_id, sub_path, max_size=_MAX_BINARY_RAW):
    """원격 파일을 binary 로 read. PDF/이미지/HTML 등 raw stream 용도.

    Returns: (bytes, stat_info).
    Raises: FileNotFoundError, RuntimeError(too large or ssh fail).
    """
    info = stat_file(host_id, sub_path)
    if info is None:
        raise FileNotFoundError(sub_path)
    if info["size"] > max_size:
        raise RuntimeError(f"file too large ({info['size']} bytes > {max_size})")
    sub = _safe_subpath(sub_path)
    remote_cmd = 'cd "$HOME" 2>/dev/null || exit 1; cat "$1"'
    remote_full = "sh -c " + shlex.quote(remote_cmd) + " _ " + shlex.quote(sub)
    cmd = _ssh_base(host_id) + [remote_full]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise RuntimeError("ssh cat timeout")
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh cat exit {proc.returncode}: "
            f"{proc.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return proc.stdout, info


# Spec 3-c: 원격 파일 save / upload
def write_text(host_id, sub_path, content):
    """원격 텍스트 파일 atomic 저장 — content 는 stdin 으로 (argv 한도 회피).

    sub_path 는 _safe_subpath 로 검증, content 는 ssh stdin 으로 직접 넘김
    → 어떤 binary/text 도 안전. 임시 파일 → mv 로 atomic.
    """
    sub = _safe_subpath(sub_path)
    if not sub:
        raise ValueError("path required")
    # ssh "sh -c 'script' _ arg1 arg2..." — name=_, $1=sub. content 는 stdin.
    remote_cmd = (
        'set -e; cd "$HOME"; '
        'sub="$1"; '
        'tmp="${sub}.cn-tmp.$$"; '
        'cat > "$tmp"; '
        'mv -f "$tmp" "$sub"'
    )
    # ssh 는 host 뒤 args 를 space-join 해서 remote shell 에 던짐 → 우리 args
    # 의 quoting 손실. shlex.quote 로 한 줄로 묶어서 ssh 가 수정 못 하게.
    remote_full = "sh -c " + shlex.quote(remote_cmd) + " _ " + shlex.quote(sub)
    cmd = _ssh_base(host_id) + [remote_full]
    try:
        proc = subprocess.run(
            cmd, input=content.encode("utf-8"),
            capture_output=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("ssh save timeout")
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh save exit {proc.returncode}: "
            f"{proc.stderr.decode('utf-8', 'replace')[:200]}"
        )


def upload_file(host_id, sub_dir, name, content_bytes):
    """원격에 파일 업로드 — content 는 stdin (binary OK), unique naming.

    Returns: 업로드된 파일의 원격 절대 경로.
    """
    sub = _safe_subpath(sub_dir or "")
    if "/" in name or "\x00" in name or name in ("", ".", ".."):
        raise ValueError(f"unsafe filename: {name!r}")
    remote_cmd = (
        'set -e; cd "$HOME"; '
        'sub="$1"; orig="$2"; '
        'if [ -n "$sub" ]; then mkdir -p "$sub" && cd "$sub"; fi; '
        'name="$orig"; i=1; '
        'while [ -e "$name" ]; do '
        '  ext=""; base="$orig"; '
        '  case "$orig" in *.*) ext=".${orig##*.}"; base="${orig%.*}";; esac; '
        '  name="${base} (${i})${ext}"; '
        '  i=$((i+1)); '
        'done; '
        'tmp=".${name}.cn-up.$$"; '
        'cat > "$tmp"; '
        'mv -f "$tmp" "$name"; '
        'printf "%s" "$PWD/$name"'
    )
    remote_full = (
        "sh -c " + shlex.quote(remote_cmd)
        + " _ " + shlex.quote(sub) + " " + shlex.quote(name)
    )
    cmd = _ssh_base(host_id) + [remote_full]
    try:
        proc = subprocess.run(
            cmd, input=content_bytes,
            capture_output=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("ssh upload timeout")
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh upload exit {proc.returncode}: "
            f"{proc.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return proc.stdout.decode("utf-8", "replace").strip()

