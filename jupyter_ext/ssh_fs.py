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


def _validate_host(host_id):
    """host_id 가 hosts.json 의 등록된 alias 인지 검증. 미등록이면 ValueError.

    codex audit P1: 검증 없으면 임의 SSH 타겟으로 명령 실행 가능.
    """
    if not isinstance(host_id, str) or not host_id or host_id == "local":
        raise ValueError(f"invalid host: {host_id!r}")
    from .hosts import get_host
    if get_host(host_id) is None:
        raise ValueError(f"unknown host: {host_id!r}")


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
    _validate_host(host_id)
    sub = _safe_subpath(sub_path)
    # P0 fix (codex audit): shell quoting 만으로는 $(), backtick, \ 등 안전
    # 못 함. ssh 가 모든 args 를 remote shell 로 넘기므로, stdin script 로
    # 보내고 sub_path 는 positional arg 로 전달해 "$1" 로 quoted reference.
    # 그러면 sub_path 가 어떤 문자열이어도 remote shell expansion 차단됨.
    remote_script = (
        'cd "$HOME" 2>/dev/null || exit 1\n'
        'sub="$1"\n'
        'if [ -n "$sub" ]; then cd "$sub" 2>/dev/null || exit 1; fi\n'
        # P2 codex audit: symlink escape 차단 — pwd -P 로 physical path 가
        # $HOME 아래인지 확인. cd 가 symlink 통해 외부로 갔으면 거부.
        'case "$(pwd -P)" in "$HOME"|"$HOME"/*) ;; *) exit 7;; esac\n'
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
    if proc.returncode == 7:
        raise ValueError(f"path escapes HOME: {sub_path!r}")
    if proc.returncode != 0:
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


# Spec 3-b: 원격 파일 read — local 의 _MAX_TEXT_PREVIEW (10 MB) 와 동일
_MAX_TEXT_PREVIEW = 10 * 1024 * 1024


def stat_file(host_id, sub_path):
    """원격 파일 stat — size + mtime + mtime_ns. 없으면 None.

    Returns dict {size, mtime, mtime_ns, version}. version = 'mtime_ns:size'
    (codex 권장 — float 정밀도 + FS 해상도 회피).
    """
    _validate_host(host_id)
    sub = _safe_subpath(sub_path)
    if not sub:
        raise ValueError("path required")
    remote_script = (
        'cd "$HOME" 2>/dev/null || exit 1\n'
        'sub="$1"\n'
        # P2: symlink escape 차단 — realpath 결과가 $HOME 하위인지 확인
        'abs=$(realpath -m -- "$sub" 2>/dev/null)\n'
        'case "$abs" in "$HOME"|"$HOME"/*) ;; *) exit 7;; esac\n'
        'if [ ! -f "$sub" ]; then exit 2; fi\n'
        'stat -c "%s %Y %.Y" "$sub"\n'
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
    if proc.returncode == 7:
        raise ValueError(f"path escapes HOME: {sub_path!r}")
    if proc.returncode != 0:
        raise RuntimeError(f"ssh exit {proc.returncode}: {proc.stderr.strip()[:200]}")
    parts = proc.stdout.strip().split()
    if len(parts) < 2:
        raise RuntimeError(f"unexpected stat output: {proc.stdout!r}")
    size = int(parts[0])
    mtime = float(parts[1])
    # mtime_ns from %.Y if available (GNU stat), else fallback to int(mtime*1e9)
    if len(parts) >= 3 and '.' in parts[2]:
        sec_str, ns_str = parts[2].split('.', 1)
        ns_str = (ns_str + "000000000")[:9]
        mtime_ns = int(sec_str) * 1_000_000_000 + int(ns_str)
    else:
        mtime_ns = int(mtime * 1_000_000_000)
    return {
        "size": size, "mtime": mtime, "mtime_ns": mtime_ns,
        "version": f"{mtime_ns}:{size}",
    }


def read_text(host_id, sub_path, max_size=_MAX_TEXT_PREVIEW):
    """원격 텍스트 파일 read. (content, info) 반환.
    info = {size, mtime, mtime_ns, version}. 큰 파일/binary 면 content=None.
    """
    _validate_host(host_id)
    info = stat_file(host_id, sub_path)
    if info is None:
        raise FileNotFoundError(sub_path)
    if info["size"] > max_size:
        return None, info
    sub = _safe_subpath(sub_path)
    remote_script = (
        'cd "$HOME" 2>/dev/null || exit 1\n'
        'sub="$1"\n'
        'abs=$(realpath -m -- "$sub" 2>/dev/null)\n'
        'case "$abs" in "$HOME"|"$HOME"/*) ;; *) exit 7;; esac\n'
        'cat "$sub"\n'
    )
    cmd = _ssh_base(host_id) + ["sh", "-s", "--", sub]
    proc = subprocess.run(
        cmd, input=remote_script.encode("utf-8"),
        capture_output=True, timeout=30,
    )
    if proc.returncode == 7:
        raise ValueError(f"path escapes HOME: {sub_path!r}")
    if proc.returncode != 0:
        raise RuntimeError(f"ssh cat failed: {proc.stderr.decode('utf-8', 'replace')[:200]}")
    try:
        return proc.stdout.decode("utf-8"), info
    except UnicodeDecodeError:
        return None, info


# Spec 3-b 보완: 원격 binary read (PDF/이미지/HTML 등 raw stream)
_MAX_BINARY_RAW = 50 * 1024 * 1024  # 50 MB — 기본 상한


def read_binary(host_id, sub_path, max_size=_MAX_BINARY_RAW):
    """원격 파일을 binary 로 read. PDF/이미지/HTML 등 raw stream 용도.

    Returns: (bytes, stat_info).
    Raises: FileNotFoundError, RuntimeError(too large or ssh fail).
    """
    _validate_host(host_id)
    info = stat_file(host_id, sub_path)
    if info is None:
        raise FileNotFoundError(sub_path)
    if info["size"] > max_size:
        raise RuntimeError(f"file too large ({info['size']} bytes > {max_size})")
    sub = _safe_subpath(sub_path)
    remote_cmd = (
        'cd "$HOME" 2>/dev/null || exit 1; '
        'sub="$1"; '
        'abs=$(realpath -m -- "$sub" 2>/dev/null); '
        'case "$abs" in "$HOME"|"$HOME"/*) ;; *) exit 7;; esac; '
        'cat "$sub"'
    )
    remote_full = "sh -c " + shlex.quote(remote_cmd) + " _ " + shlex.quote(sub)
    cmd = _ssh_base(host_id) + [remote_full]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise RuntimeError("ssh cat timeout")
    if proc.returncode == 7:
        raise ValueError(f"path escapes HOME: {sub_path!r}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh cat exit {proc.returncode}: "
            f"{proc.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return proc.stdout, info


# Spec 3-c: 원격 파일 save / upload
class VersionMismatch(Exception):
    """파일이 다른 곳에서 수정됨 (lost-update 보호). HTTP 409 로 매핑."""
    def __init__(self, expected, actual):
        super().__init__(f"version mismatch: expected={expected!r} actual={actual!r}")
        self.expected = expected
        self.actual = actual


def write_text(host_id, sub_path, content, expected_version=None):
    """원격 텍스트 파일 atomic 저장 — content 는 stdin (argv 한도 회피).

    expected_version 주어지면 stat+검사+write 를 flock 임계구역에서 한 번에
    실행 (codex TOCTOU 권장). 불일치 시 special exit code → VersionMismatch.

    Returns: 새 version string ('mtime_ns:size').
    """
    _validate_host(host_id)
    sub = _safe_subpath(sub_path)
    if not sub:
        raise ValueError("path required")
    # flock + stat 검사 + atomic mv. expected_version 가 None 이면 검사 skip.
    # remote 에서 special exit code: 9 = version mismatch
    expected = expected_version or ""
    remote_cmd = (
        'set -e; cd "$HOME"; '
        'sub="$1"; expected="$2"; '
        # P2: symlink escape 차단 — realpath 가 $HOME 하위가 아니면 거부
        'abs=$(realpath -m -- "$sub" 2>/dev/null); '
        'case "$abs" in "$HOME"|"$HOME"/*) ;; *) exit 7;; esac; '
        # flock — 같은 파일 임계구역. -x exclusive, -w 30 wait 30s.
        '(flock -x -w 30 9 || { echo "flock timeout" >&2; exit 4; }; '
        '  if [ -n "$expected" ] && [ -f "$sub" ]; then '
        '    cur_size=$(stat -c "%s" "$sub"); '
        '    cur_ns=$(stat -c "%.Y" "$sub" 2>/dev/null | tr -d "."); '
        '    cur_ns=${cur_ns:-$(($(stat -c "%Y" "$sub")*1000000000))}; '
        '    cur_ver="${cur_ns}:${cur_size}"; '
        '    if [ "$cur_ver" != "$expected" ]; then '
        '      printf "MISMATCH:%s\\n" "$cur_ver" >&2; exit 9; '
        '    fi; '
        '  fi; '
        '  tmp="${sub}.cn-tmp.$$"; '
        '  cat > "$tmp"; '
        '  mv -f "$tmp" "$sub"; '
        '  new_size=$(stat -c "%s" "$sub"); '
        '  new_ns=$(stat -c "%.Y" "$sub" 2>/dev/null | tr -d "."); '
        '  new_ns=${new_ns:-$(($(stat -c "%Y" "$sub")*1000000000))}; '
        '  printf "%s:%s" "$new_ns" "$new_size"; '
        ') 9>"${sub}.cn-lock"'
    )
    remote_full = (
        "sh -c " + shlex.quote(remote_cmd)
        + " _ " + shlex.quote(sub) + " " + shlex.quote(expected)
    )
    cmd = _ssh_base(host_id) + [remote_full]
    try:
        proc = subprocess.run(
            cmd, input=content.encode("utf-8"),
            capture_output=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("ssh save timeout")
    if proc.returncode == 9:
        stderr = proc.stderr.decode("utf-8", "replace")
        actual = ""
        for line in stderr.splitlines():
            if line.startswith("MISMATCH:"):
                actual = line[len("MISMATCH:"):].strip()
                break
        raise VersionMismatch(expected, actual)
    if proc.returncode == 7:
        raise ValueError(f"path escapes HOME: {sub_path!r}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh save exit {proc.returncode}: "
            f"{proc.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return proc.stdout.decode("utf-8", "replace").strip()


def upload_file(host_id, sub_dir, name, content_bytes):
    """원격에 파일 업로드 — content 는 stdin (binary OK), unique naming.

    Returns: 업로드된 파일의 원격 절대 경로.
    """
    _validate_host(host_id)
    sub = _safe_subpath(sub_dir or "")
    if "/" in name or "\x00" in name or name in ("", ".", ".."):
        raise ValueError(f"unsafe filename: {name!r}")
    remote_cmd = (
        'set -e; cd "$HOME"; '
        'sub="$1"; orig="$2"; '
        # P2: 대상 디렉토리 escape 차단
        'if [ -n "$sub" ]; then '
        '  abs=$(realpath -m -- "$sub" 2>/dev/null); '
        '  case "$abs" in "$HOME"|"$HOME"/*) ;; *) exit 7;; esac; '
        '  mkdir -p "$sub" && cd "$sub"; '
        'fi; '
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
    if proc.returncode == 7:
        raise ValueError(f"path escapes HOME: {sub_dir!r}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"ssh upload exit {proc.returncode}: "
            f"{proc.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return proc.stdout.decode("utf-8", "replace").strip()

