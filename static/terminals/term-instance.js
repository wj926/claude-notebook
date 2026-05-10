// xterm 인스턴스 + WebSocket transport + resize.
// 5b 에서 input bar/upload/vkb, 5c 에서 chat mode/config 흡수 예정.

const BASE = window.__VIEWER_BASE || '';
const JUPYTER = window.__JUPYTER_BASE !== undefined ? window.__JUPYTER_BASE : BASE;
const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

export class TerminalInstance {
  constructor({ name }) {
    this.name = name;
    this.xterm = null;
    this.fitAddon = null;
    this.webLinksAddon = null;
    this.socket = null;
    this.dom = null;
    this.disposed = false;
    this._ro = null;
    this._resizeTimer = null;
  }

  mount(hostEl) {
    if (this.disposed) throw new Error('disposed');
    this.dom = hostEl;

    // Original options from createXterm() in terminal.js
    this.xterm = new window.Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'SFMono-Regular', 'Fira Code', 'Consolas', 'Courier New', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#d7ba7d',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
      },
      scrollback: 10000,
      smoothScrollDuration: 0,
      allowProposedApi: true,
    });

    this.fitAddon = new window.FitAddon.FitAddon();
    this.webLinksAddon = new window.WebLinksAddon.WebLinksAddon();
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.loadAddon(this.webLinksAddon);
    this.xterm.open(hostEl);

    setTimeout(() => {
      this.fitAddon?.fit();
    }, 50);

    this._connect();
    this._attachResize();
  }

  fit() { this.fitAddon?.fit(); }

  _connect() {
    const url = `${WS_BASE}${JUPYTER}/terminals/websocket/${this.name}`;
    this.socket = new WebSocket(url);

    this.socket.addEventListener('open', () => {
      const dims = this.fitAddon?.proposeDimensions();
      if (dims && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(['set_size', dims.rows, dims.cols]));
      }
    });

    // Use addEventListener (not onmessage) so other listeners (chat, status) can coexist.
    this.socket.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg[0] === 'stdout') {
          this.xterm.write(msg[1]);
        }
      } catch (_) {}
    });

    this.xterm.onData((d) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(['stdin', d]));
      }
    });
  }

  _attachResize() {
    let lastW = 0, lastH = 0;
    this._ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;

      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (!this.fitAddon || !this.xterm) return;
        const viewport = this.dom?.querySelector('.xterm-viewport');
        const wasAtBottom = viewport
          ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30
          : true;
        const savedTop = viewport ? viewport.scrollTop : 0;

        this.fitAddon.fit();

        if (viewport) {
          requestAnimationFrame(() => {
            viewport.scrollTop = wasAtBottom
              ? viewport.scrollHeight
              : Math.min(savedTop, viewport.scrollHeight - viewport.clientHeight);
          });
        }

        if (this.socket?.readyState === WebSocket.OPEN) {
          const dims = this.fitAddon.proposeDimensions();
          if (dims) {
            this.socket.send(JSON.stringify(['set_size', dims.rows, dims.cols]));
          }
        }
      }, 200);
    });
    this._ro.observe(this.dom);
  }

  reconnect() {
    try { this.socket?.close(); } catch (_) {}
    this._connect();
  }

  dispose() {
    this.disposed = true;
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._inputCtrl?.abort();
    this._uploadCtrl?.abort();
    this._vkbCtrl?.abort();
    try { this.socket?.close(); } catch (_) {}
    try { this._ro?.disconnect(); } catch (_) {}
    try { this.xterm?.dispose(); } catch (_) {}
    try { this._dropOverlay?.remove(); } catch (_) {}
    this.dom = null;
    this.xterm = null;
    this.fitAddon = null;
    this.socket = null;
    this._dropOverlay = null;
  }

  // ----- input bar -----
  attachInputBar(formEl, sendBtn, inputField, opts = {}) {
    this._inputCtrl?.abort();
    this._inputCtrl = new AbortController();
    const sig = { signal: this._inputCtrl.signal };

    const {
      isMobile = false,
      pendingFilesRef = null,
      isChatMode = null,    // () => boolean — chat mode 여부 체크 콜백
      chatSubmit = null,    // () => void — chat mode submit 콜백
    } = opts;

    const submit = async (e) => {
      if (e) e.preventDefault();
      // chat mode intercept
      if (isChatMode?.()) { chatSubmit?.(); return; }
      const text = inputField.value.trim();
      if (!text || this.socket?.readyState !== WebSocket.OPEN) return;

      // Upload pending files first (preserving legacy sendInput behaviour)
      let uploadedMeta = '';
      if (pendingFilesRef && pendingFilesRef.list.length) {
        try {
          const data = await this._uploadFiles(pendingFilesRef.list);
          uploadedMeta = data.files.map(f =>
            `File uploaded: ${f.path} (${f.size} bytes, ${f.content_type})`
          ).join('\n');
        } catch (err) {
          alert('Upload failed: ' + err.message);
          return;
        }
        pendingFilesRef.list = [];
        pendingFilesRef.render();
      }

      const fullText = uploadedMeta ? uploadedMeta + '\n' + text : text;
      this.socket.send(JSON.stringify(['stdin', fullText]));
      setTimeout(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify(['stdin', '\r']));
        }
      }, 50);
      inputField.value = '';
      // trigger auto-resize if available
      inputField.dispatchEvent(new Event('input'));
    };

    formEl?.addEventListener('submit', submit, sig);
    sendBtn?.addEventListener('click', submit, sig);

    // 클립보드 paste — 캡처 도구로 찍은 이미지 등을 Ctrl+V 로 바로 첨부
    // (ChatGPT 식). textarea 의 paste 이벤트에서 clipboardData.items 검사.
    inputField.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items || !pendingFilesRef) return;
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) {
            // 캡처 도구 이미지는 보통 'image.png' 같은 generic 이름
            // → 타임스탬프 prefix 추가해서 식별 쉽게
            const ext = (f.name.split('.').pop() || 'png').toLowerCase();
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const renamed = new File([f], `paste-${ts}.${ext}`, { type: f.type });
            files.push(renamed);
          }
        }
      }
      if (files.length) {
        e.preventDefault();  // 텍스트로 paste 안 되게 차단
        pendingFilesRef.list.push(...files);
        pendingFilesRef.render();
      }
    }, sig);

    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !isMobile && !e.shiftKey) {
        e.preventDefault();
        submit(e);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify(['stdin', '\t']));
        }
      }
      if (e.key === 'c' && e.ctrlKey) {
        const hasSelection = inputField.selectionStart !== inputField.selectionEnd;
        if (hasSelection) return;
        e.preventDefault();
        inputField.value = '';
        inputField.dispatchEvent(new Event('input'));
      }
    }, sig);
  }

  async _uploadFiles(fileList) {
    if (!fileList.length) return null;
    const base = window.__VIEWER_BASE || '';
    const xsrf = window.__XSRF_TOKEN || '';
    const form = new FormData();
    for (const f of fileList) form.append('file', f, f.name);
    const res = await fetch(`${base}/api/terminal-upload`, {
      method: 'POST', body: form, credentials: 'same-origin',
      headers: { 'X-XSRFToken': xsrf, 'ngrok-skip-browser-warning': '1' },
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ----- upload (pending files + file input wiring + drag-drop) -----
  attachUpload(fileInputEl, pendingContainerEl, attachBtnEl, dropZoneEl = null) {
    this._uploadCtrl?.abort();
    this._uploadCtrl = new AbortController();
    const sig = { signal: this._uploadCtrl.signal };

    if (!this._pendingFiles) this._pendingFiles = [];

    const render = () => {
      const list = this._pendingFiles;
      pendingContainerEl.innerHTML = '';
      if (!list.length) {
        pendingContainerEl.classList.remove('active');
        attachBtnEl?.classList.remove('has-files');
        return;
      }
      pendingContainerEl.classList.add('active');
      attachBtnEl?.classList.add('has-files');
      list.forEach((f, i) => {
        const badge = document.createElement('div');
        badge.className = 'pending-file-badge';
        badge.innerHTML = `<span>📎 ${f.name}</span><span class="pending-file-remove" data-idx="${i}">&times;</span>`;
        pendingContainerEl.appendChild(badge);
      });
      pendingContainerEl.querySelectorAll('.pending-file-remove').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.idx);
          this._pendingFiles.splice(idx, 1);
          render();
        });
      });
    };

    fileInputEl.addEventListener('change', () => {
      for (const f of fileInputEl.files) this._pendingFiles.push(f);
      fileInputEl.value = '';
      render();
    }, sig);

    // Drag-drop: dropZone (보통 page 전체) 위로 drag 하면 visual feedback,
    // drop 시 _pendingFiles 에 추가 (ChatGPT 스타일 — submit 시 자동 업로드 +
    // path prepend).
    if (dropZoneEl) {
      let dragDepth = 0;  // dragenter/leave 가 자식 요소마다 발화하므로 카운터로 정확히 추적
      const overlay = document.createElement('div');
      overlay.className = 'drop-overlay';
      overlay.innerHTML = '<div class="drop-overlay-msg">📎 파일을 놓으면 터미널 입력에 첨부됩니다</div>';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;' +
        'background:rgba(0,0,0,0.7);color:#fff;display:none;' +
        'align-items:center;justify-content:center;font-size:18px;' +
        'pointer-events:none;border:4px dashed rgba(255,255,255,0.7);';
      document.body.appendChild(overlay);
      const showOverlay = (s) => { overlay.style.display = s ? 'flex' : 'none'; };

      dropZoneEl.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragDepth++;
        if (dragDepth === 1) showOverlay(true);
      }, sig);
      dropZoneEl.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }, sig);
      dropZoneEl.addEventListener('dragleave', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) showOverlay(false);
      }, sig);
      dropZoneEl.addEventListener('drop', (e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        dragDepth = 0;
        showOverlay(false);
        for (const f of e.dataTransfer.files) this._pendingFiles.push(f);
        render();
      }, sig);
      // dispose 시 overlay 도 제거
      this._dropOverlay = overlay;
    }

    this._pendingFilesRef = { list: this._pendingFiles, render };
  }

  // ----- chat mode -----
  setChatMode(enabled) {
    if (this.chatMode === !!enabled) return;
    this.chatMode = !!enabled;
    // Delegate to IIFE-scoped openChat()/closeChat() in terminal.js via bridge
    if (typeof window.__setChatMode === 'function') {
      window.__setChatMode(this.chatMode);
    }
  }

  isChatMode() { return !!this.chatMode; }

  // ----- config modal -----
  openConfigModal() {
    if (typeof window.__openTerminalConfig === 'function') {
      window.__openTerminalConfig(this);
    }
  }

  // ----- virtual keyboard -----
  attachVKB(vkbPanelEl) {
    this._vkbCtrl?.abort();
    this._vkbCtrl = new AbortController();
    const sig = { signal: this._vkbCtrl.signal };

    const keyMap = {
      'Escape':    '\x1b',
      'Tab':       '\t',
      'Enter':     '\r',
      'Backspace': '\x7f',
      'Delete':    '\x1b[3~',
      'Insert':    '\x1b[2~',
      'Home':      '\x1b[H',
      'End':       '\x1b[F',
      'PageUp':    '\x1b[5~',
      'PageDown':  '\x1b[6~',
      'ArrowUp':   '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight':'\x1b[C',
      'ArrowLeft': '\x1b[D',
      'F1': '\x1bOP',  'F2': '\x1bOQ',  'F3': '\x1bOR',  'F4': '\x1bOS',
      'F5': '\x1b[15~','F6': '\x1b[17~','F7': '\x1b[18~','F8': '\x1b[19~',
      'F9': '\x1b[20~','F10':'\x1b[21~','F11':'\x1b[23~','F12':'\x1b[24~',
    };

    // modifier state lives on the instance
    const mods = { ctrl: false, alt: false, shift: false, meta: false };

    vkbPanelEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.vkb-key');
      if (!btn) return;

      // Modifier toggle
      const mod = btn.dataset.mod;
      if (mod) {
        mods[mod] = !mods[mod];
        btn.classList.toggle('active', mods[mod]);
        return;
      }

      // Regular key
      const key = btn.dataset.key;
      if (!key || this.socket?.readyState !== WebSocket.OPEN) return;

      let seq = keyMap[key] || key;

      if (mods.ctrl && seq.length === 1) {
        const code = seq.toUpperCase().charCodeAt(0);
        if (code >= 65 && code <= 90) seq = String.fromCharCode(code - 64);
      }
      if (mods.alt) {
        seq = '\x1b' + seq;
      }

      this.socket.send(JSON.stringify(['stdin', seq]));

      // Reset modifiers after key press
      Object.keys(mods).forEach(m => { mods[m] = false; });
      vkbPanelEl.querySelectorAll('.vkb-mod').forEach(el => el.classList.remove('active'));
    }, sig);
  }
}
