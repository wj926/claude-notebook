(function () {

// ========== CONSTANTS & DOM ELEMENTS ==========

const BASE = window.__VIEWER_BASE || '';
// JUPYTER_BASE is set when served through Jupyter extension; points to Jupyter root for terminal API
const JUPYTER = window.__JUPYTER_BASE !== undefined ? window.__JUPYTER_BASE : BASE;
const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

const termList = document.getElementById('termList');
const termPlaceholder = document.getElementById('termPlaceholder');
const termToolbar = document.getElementById('termToolbar');
const terminalContainer = document.getElementById('terminalContainer');
const termTitle = document.getElementById('termTitle');
const statusDot = document.getElementById('statusDot');
const newTermBtn = document.getElementById('newTermBtn');
const backBtn = document.getElementById('backBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const mobileToggle = document.getElementById('mobileToggle');
const mobileOverlay = document.getElementById('mobileOverlay');
const termSidebar = document.getElementById('termSidebar');
const termInputBar = document.getElementById('termInputBar');
const termInputField = document.getElementById('termInputField');
const termInputSend = document.getElementById('termInputSend');
const renameBtn = document.getElementById('renameBtn');
const shutdownBtn = document.getElementById('shutdownBtn');
const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatView = document.getElementById('chatView');
const chatMessages = document.getElementById('chatMessages');
const chatScrollAnchor = document.getElementById('chatScrollAnchor');
const chatInputField = document.getElementById('chatInputField');
const chatInputSend = document.getElementById('chatInputSend');
const chatBackBtn = document.getElementById('chatBackBtn');
const chatExpandBtn = document.getElementById('chatExpandBtn');
const chatAvatar = document.getElementById('chatAvatar');
const chatContactName = document.getElementById('chatContactName');
const chatContactStatus = document.getElementById('chatContactStatus');
let typingRow = null; // dynamically created typing indicator in chatMessages
const configModalOverlay = document.getElementById('configModalOverlay');
const configModalTitle = document.getElementById('configModalTitle');
const configNameInput = document.getElementById('configNameInput');
const configCmdInput = document.getElementById('configCmdInput');
const configCancelBtn = document.getElementById('configCancelBtn');
const configConfirmBtn = document.getElementById('configConfirmBtn');

let currentTerm = null;
let currentWs = null;
let currentName = null;
let currentDisplayName = null;
let fitAddon = null;
let terminalData = {};  // name -> {display_name, last_activity}
let chatMode = false;

// Server-synced terminal config (slot-based, shared across devices)
// Format: {slot: {display_name, command}}
const NAMES_API = BASE + '/api/terminal-names';
let serverSlots = {};  // {slot: {display_name, command}}
let slotMap = {};  // termName -> slot

// Shared file upload helpers
const XSRF = window.__XSRF_TOKEN || '';
let chatPendingFileList = [];
let termPendingFileList = [];
const chatFileInput = document.getElementById('chatFileInput');
const chatPendingFiles = document.getElementById('chatPendingFiles');
const chatAttachBtn = document.querySelector('.chat-attach-btn');
const termFileInput = document.getElementById('termFileInput');
const termPendingFiles = document.getElementById('termPendingFiles');
const termAttachBtn = document.querySelector('.term-attach-btn');

// Custom scrollbar state
const scrollbar = document.getElementById('customScrollbar');
const scrollThumb = document.getElementById('customScrollThumb');
let scrollDragging = false;
let scrollDragStartY = 0;
let scrollDragStartTop = 0;

// Terminal list render cache
let lastRenderKey = '';

// Config modal state
let modalResolve = null;
let modalMode = 'create'; // 'create' or 'rename'

// iMessage chat state
let chatLastLine = 0;
let chatSnapshotTimer = null;
let lastChatTimeStr = '';
let sentText = '';
let sentTextFoundLine = -1;
let phase = 'idle';  // 'idle' | 'finding' | 'waiting'
let contentHash = '';
let idleSince = 0;
const IDLE_MS = 3000;

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia('(max-width: 768px)').matches;

// ========== UTILITIES ==========

function esc(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function timeAgo(isoStr) {
    const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
}

// XSRF token (needed for Jupyter)
function getXsrf() {
    if (window.__XSRF_TOKEN) return window.__XSRF_TOKEN;
    const m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
}

function autoResizeInput() {
    termInputField.style.height = 'auto';
    termInputField.style.height = Math.min(termInputField.scrollHeight, 120) + 'px';
}

// Sidebar toggle
function openSidebar() {
    termSidebar.classList.add('open');
    termSidebar.classList.remove('collapsed');
    mobileOverlay.classList.add('active');
}
function closeSidebar() {
    termSidebar.classList.remove('open');
    mobileOverlay.classList.remove('active');
    if (!isMobile) {
        termSidebar.classList.add('collapsed');
    }
}

// Send multiline commands with 3s interval via WebSocket
function sendMultilineCommand(ws, commandText) {
    if (!commandText || !commandText.trim()) return;
    const lines = commandText.split('\n').filter(l => l.trim());
    lines.forEach((line, i) => {
        setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(["stdin", line + "\r"]));
            }
        }, i * 3000);
    });
}

// ========== SERVER SLOTS API ==========

async function fetchServerSlots() {
    try {
        const res = await fetch(NAMES_API);
        if (res.ok) serverSlots = await res.json();
    } catch (e) { /* ignore */ }
}

// Map terminal session names to slots by order
function buildSlotMap(terminals) {
    const sorted = [...terminals].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const map = {};  // termName -> slot
    sorted.forEach((t, i) => { map[t.name] = String(i + 1); });
    return map;
}

async function setServerSlot(slot, displayName, command) {
    serverSlots[slot] = { display_name: displayName, command: command || "" };
    try {
        await fetch(NAMES_API, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-XSRFToken': getXsrf() },
            body: JSON.stringify({ slot, display_name: displayName, command: command || "" }),
        });
    } catch (e) { /* ignore */ }
}

async function removeServerSlot(slot) {
    delete serverSlots[slot];
    try {
        await fetch(NAMES_API + '?slot=' + encodeURIComponent(slot), {
            method: 'DELETE',
            headers: { 'X-XSRFToken': getXsrf() },
        });
    } catch (e) { /* ignore */ }
    await fetchServerSlots();
}

function getSlotConfig(termName) {
    const slot = slotMap[termName];
    if (slot && serverSlots[slot]) return serverSlots[slot];
    return null;
}

function getDisplayName(t) {
    const cfg = getSlotConfig(t.name);
    if (cfg && cfg.display_name) return cfg.display_name;
    return t.display_name || ('Terminal ' + t.name);
}

// ========== CONFIG MODAL ==========

function showConfigModal(termName) {
    const isRename = !!termName;
    modalMode = isRename ? 'rename' : 'create';
    configModalTitle.textContent = isRename ? 'Config Terminal' : 'New Terminal';
    configConfirmBtn.textContent = isRename ? 'Save' : 'Create';

    if (isRename) {
        const cfg = getSlotConfig(termName) || {};
        const currentDisplay = cfg.display_name || getDisplayName(terminalData[termName] || {name: termName});
        const currentCmd = cfg.command || "";
        configNameInput.value = currentDisplay;
        configCmdInput.value = currentCmd;
    } else {
        configNameInput.value = '';
        configCmdInput.value = '';
    }

    configModalOverlay.classList.add('active');
    configNameInput.focus();

    return new Promise(resolve => { modalResolve = resolve; });
}

function closeConfigModal(result) {
    configModalOverlay.classList.remove('active');
    if (modalResolve) {
        modalResolve(result);
        modalResolve = null;
    }
}

configCancelBtn.addEventListener('click', () => closeConfigModal(null));
configModalOverlay.addEventListener('click', (e) => {
    if (e.target === configModalOverlay) closeConfigModal(null);
});
configConfirmBtn.addEventListener('click', () => {
    closeConfigModal({
        name: configNameInput.value.trim(),
        command: configCmdInput.value,
    });
});
configNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        configConfirmBtn.click();
    }
    if (e.key === 'Escape') closeConfigModal(null);
});
configCmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeConfigModal(null);
});

// ========== TERMINAL LIST ==========

async function loadTerminals() {
    try {
        const res = await fetch(JUPYTER + '/api/terminals');
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        terminalData = {};
        data.forEach(t => { terminalData[t.name] = t; });
        await fetchServerSlots();
        slotMap = buildSlotMap(data);
        // Skip re-render if neither terminal list nor slot config changed
        const renderKey = JSON.stringify(data.map(t => t.name).sort()) + JSON.stringify(serverSlots);
        if (renderKey === lastRenderKey) return;
        lastRenderKey = renderKey;
        renderList(data);
    } catch (e) {
        termList.innerHTML = '<div class="term-empty">Error loading terminals</div>';
    }
}

function renderList(terminals) {
    if (terminals.length === 0) {
        termList.innerHTML = '<div class="term-empty">No active terminals.<br>Click <strong>+</strong> to create one.</div>';
        return;
    }
    termList.innerHTML = '';
    terminals.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    terminals.forEach(t => {
        const item = document.createElement('div');
        item.className = 'term-item' + (t.name === currentName ? ' active' : '');
        item.dataset.name = t.name;
        const ago = timeAgo(t.last_activity);
        const displayName = getDisplayName(t);
        item.innerHTML = `
            <span class="term-item-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.146 3.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L4.793 6.5 2.146 3.854a.5.5 0 0 1 0-.708zM6 10h4a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1z"/></svg>
            </span>
            <span class="term-item-name">${esc(displayName)}</span>
            <span class="term-item-time">${ago}</span>
            <button class="term-item-close" title="Shutdown terminal">&times;</button>
        `;
        // Click to connect
        item.addEventListener('click', (e) => {
            if (e.target.closest('.term-item-close')) return;
            if (e.target.closest('.term-item-name')?.isContentEditable) return;
            connectTerminal(t.name);
            closeSidebar();
        });
        // Double-click name to rename
        const nameEl = item.querySelector('.term-item-name');
        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startRename(nameEl, t.name);
        });
        // Close button
        item.querySelector('.term-item-close').addEventListener('click', async (e) => {
            e.stopPropagation();
            await deleteTerminal(t.name);
        });
        termList.appendChild(item);
    });
}

function startRename(nameEl, termName) {
    showConfigModal(termName);
}

async function renameTerminal(name, displayName, command) {
    const slot = slotMap[name];
    if (!slot) return;
    await setServerSlot(slot, displayName, command);
    // Try API rename too (works with standalone server)
    try {
        await fetch(JUPYTER + '/api/terminals/' + name, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': getXsrf(),
            },
            body: JSON.stringify({ display_name: displayName }),
        });
    } catch (e) { /* Jupyter doesn't support PATCH, that's ok */ }
    // Update toolbar if this is the active terminal
    if (name === currentName) {
        currentDisplayName = displayName;
        termTitle.textContent = displayName;
    }
    await loadTerminals();
}

// Delete terminal
async function deleteTerminal(name) {
    try {
        await fetch(JUPYTER + '/api/terminals/' + name, {
            method: 'DELETE',
            headers: { 'X-XSRFToken': getXsrf() },
        });
        const slot = slotMap[name];
        if (slot) await removeServerSlot(slot);
        if (name === currentName) {
            disconnect();
            currentName = null;
            currentDisplayName = null;
            termPlaceholder.style.display = '';
            termToolbar.style.display = 'none';
            terminalContainer.style.display = 'none';
            termInputBar.classList.add('hidden');
            scrollbar.classList.remove('active');
        }
        await loadTerminals();
    } catch (e) {
        alert('Failed to delete terminal');
    }
}

// ========== TERMINAL CONNECTION ==========

function createXterm() {
    const term = new Terminal({
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
    return term;
}

function setupScrollLock(viewport) {
    let followMode = true;  // true = auto-scroll to bottom

    viewport.style.overflowAnchor = 'none';

    // Simple scroll-lock: track whether user has scrolled up
    function isAtBottom() {
        return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30;
    }

    // Scroll up -> lock (stop auto-scroll), scroll to bottom -> unlock
    viewport.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) followMode = false;
        setTimeout(() => {
            if (isAtBottom()) followMode = true;
            updateScrollbar();
        }, 50);
    }, { passive: true });

    viewport.addEventListener('touchmove', () => {
        setTimeout(() => {
            followMode = isAtBottom();
            updateScrollbar();
        }, 100);
    }, { passive: true });

    viewport.addEventListener('scroll', () => { updateScrollbar(); });

    // Auto-scroll to bottom on new content when following
    currentTerm.onWriteParsed(() => {
        if (followMode) {
            viewport.scrollTop = viewport.scrollHeight;
        }
        updateScrollbar();
    });

    // Initial: scroll to bottom
    followMode = true;
    viewport.scrollTop = viewport.scrollHeight;
    updateScrollbar();
}

function setupWebSocket(name) {
    const wsUrl = WS_BASE + JUPYTER + '/terminals/websocket/' + name;
    currentWs = new WebSocket(wsUrl);

    currentWs.onopen = () => {
        statusDot.classList.remove('disconnected');
        const dims = fitAddon.proposeDimensions();
        if (dims) {
            currentWs.send(JSON.stringify(["set_size", dims.rows, dims.cols]));
        }
    };

    currentWs.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg[0] === 'stdout') {
                currentTerm.write(msg[1]);
            } else if (msg[0] === 'disconnect') {
                statusDot.classList.add('disconnected');
            }
        } catch (e) {}
    };

    currentWs.onclose = () => {
        statusDot.classList.add('disconnected');
    };

    currentWs.onerror = () => {
        statusDot.classList.add('disconnected');
    };

    // Send input character by character
    currentTerm.onData((data) => {
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify(["stdin", data]));
        }
    });
}

function setupResizeObserver() {
    let resizeTimer = null;
    const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (fitAddon && currentTerm) {
                const viewport = terminalContainer.querySelector('.xterm-viewport');
                const savedTop = viewport ? viewport.scrollTop : 0;
                const wasAtBottom = viewport
                    ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30
                    : true;
                fitAddon.fit();
                // Restore scroll after fit recalculates viewport
                if (viewport) {
                    requestAnimationFrame(() => {
                        if (wasAtBottom) {
                            viewport.scrollTop = viewport.scrollHeight;
                        } else {
                            viewport.scrollTop = savedTop;
                        }
                        updateScrollbar();
                    });
                }
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    const dims = fitAddon.proposeDimensions();
                    if (dims) {
                        currentWs.send(JSON.stringify(["set_size", dims.rows, dims.cols]));
                    }
                }
            }
        }, 100);
    });
    resizeObserver.observe(terminalContainer);
}

// Connect to terminal — orchestrator
function connectTerminal(name) {
    disconnect();
    currentName = name;
    currentDisplayName = getDisplayName(terminalData[name] || {name: name});

    // Reset chat mode
    chatMode = false;
    chatToggleBtn.classList.remove('active');
    chatView.classList.remove('active');
    chatMessages.innerHTML = '';
    chatLastLine = 0;
    lastChatTimeStr = '';
    if (chatSnapshotTimer) { clearInterval(chatSnapshotTimer); chatSnapshotTimer = null; }
    hideTyping();

    termPlaceholder.style.display = 'none';
    termToolbar.style.display = '';
    terminalContainer.style.display = '';
    termInputBar.classList.remove('hidden');
    scrollbar.classList.add('active');
    termTitle.textContent = currentDisplayName;

    // Mark active in list
    document.querySelectorAll('.term-item').forEach(el => {
        el.classList.toggle('active', el.dataset.name === name);
    });

    // Create xterm
    terminalContainer.innerHTML = '';
    currentTerm = createXterm();

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    currentTerm.loadAddon(fitAddon);
    currentTerm.loadAddon(webLinksAddon);
    currentTerm.open(terminalContainer);

    setTimeout(() => {
        fitAddon.fit();
        const viewport = terminalContainer.querySelector('.xterm-viewport');
        if (viewport) {
            setupScrollLock(viewport);
        }
    }, 50);

    setupWebSocket(name);
    setupResizeObserver();
}

function disconnect() {
    if (currentWs) {
        currentWs.close();
        currentWs = null;
    }
    if (currentTerm) {
        currentTerm.dispose();
        currentTerm = null;
    }
    fitAddon = null;
}

// ========== TERMINAL INPUT ==========

async function sendInput() {
    const text = termInputField.value.trim();
    if (!text || !currentWs || currentWs.readyState !== WebSocket.OPEN) return;
    // Upload pending files first (only if message provided)
    let uploadedMeta = '';
    if (termPendingFileList.length) {
        try {
            const data = await uploadPendingFiles(termPendingFileList);
            uploadedMeta = data.files.map(f => `File uploaded: ${f.path} (${f.size} bytes, ${f.content_type})`).join('\n');
        } catch (err) { alert('Upload failed: ' + err.message); return; }
        termPendingFileList = [];
        renderPendingFiles(termPendingFiles, termPendingFileList, termAttachBtn);
    }
    const fullText = uploadedMeta ? uploadedMeta + '\n' + text : text;
    currentWs.send(JSON.stringify(["stdin", fullText]));
    setTimeout(() => {
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify(["stdin", "\r"]));
        }
    }, 50);
    termInputField.value = '';
    autoResizeInput();
}

termInputField.addEventListener('input', autoResizeInput);
termInputSend.addEventListener('click', sendInput);
termInputField.addEventListener('keydown', (e) => {
    // Desktop: Enter = send, Shift+Enter = newline
    // Mobile: Enter = newline (default), Send button = send
    if (e.key === 'Enter' && !isMobile && !e.shiftKey) {
        e.preventDefault();
        sendInput();
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify(["stdin", "\t"]));
        }
    }
    if (e.key === 'c' && e.ctrlKey) {
        const hasSelection = termInputField.selectionStart !== termInputField.selectionEnd;
        if (hasSelection) {
            // Allow default copy behavior
            return;
        }
        // No selection: clear input field only, do NOT send interrupt to terminal
        e.preventDefault();
        termInputField.value = '';
        autoResizeInput();
    }
});

// File upload handling
function renderPendingFiles(container, fileList, attachBtn) {
    container.innerHTML = '';
    if (!fileList.length) {
        container.classList.remove('active');
        if (attachBtn) attachBtn.classList.remove('has-files');
        return;
    }
    container.classList.add('active');
    if (attachBtn) attachBtn.classList.add('has-files');
    fileList.forEach((f, i) => {
        const badge = document.createElement('div');
        badge.className = 'pending-file-badge';
        badge.innerHTML = `<span>📎 ${f.name}</span><span class="pending-file-remove" data-idx="${i}">&times;</span>`;
        container.appendChild(badge);
    });
    container.querySelectorAll('.pending-file-remove').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx);
            fileList.splice(idx, 1);
            renderPendingFiles(container, fileList, attachBtn);
        });
    });
}

chatFileInput.addEventListener('change', () => {
    for (const f of chatFileInput.files) chatPendingFileList.push(f);
    chatFileInput.value = '';
    renderPendingFiles(chatPendingFiles, chatPendingFileList, chatAttachBtn);
});
termFileInput.addEventListener('change', () => {
    for (const f of termFileInput.files) termPendingFileList.push(f);
    termFileInput.value = '';
    renderPendingFiles(termPendingFiles, termPendingFileList, termAttachBtn);
});

async function uploadPendingFiles(fileList) {
    if (!fileList.length) return null;
    const form = new FormData();
    for (const f of fileList) form.append('file', f, f.name);
    const res = await fetch(BASE + '/api/terminal-upload', {
        method: 'POST', body: form, credentials: 'same-origin',
        headers: { 'X-XSRFToken': XSRF },
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

// ========== iMESSAGE CHAT ==========

function openChat() {
    chatMode = true;
    chatToggleBtn.classList.add('active');
    chatContactName.textContent = currentDisplayName || 'Terminal';
    chatAvatar.textContent = (currentDisplayName || 'T').charAt(0).toUpperCase();
    chatContactStatus.textContent = 'Connected';
    chatContactStatus.classList.remove('typing');
    chatMessages.innerHTML = '';
    chatLastLine = 0;
    lastChatTimeStr = '';
    phase = 'idle';
    chatView.classList.add('active');
    snapshotBuffer();
    scrollChatToBottom();
    chatSnapshotTimer = setInterval(() => {
        if (phase === 'idle') snapshotBuffer();
    }, 500);
    chatInputField.focus();
}

function closeChat() {
    chatMode = false;
    chatToggleBtn.classList.remove('active');
    chatView.classList.remove('active');
    chatView.classList.remove('fullscreen');
    if (chatSnapshotTimer) { clearInterval(chatSnapshotTimer); chatSnapshotTimer = null; }
    hideTyping();
    phase = 'idle';
    if (fitAddon) setTimeout(() => fitAddon.fit(), 50);
}

chatToggleBtn.addEventListener('click', () => { chatMode ? closeChat() : openChat(); });
chatBackBtn.addEventListener('click', closeChat);
chatExpandBtn.addEventListener('click', () => { chatView.classList.toggle('fullscreen'); });

// Send user input -> start two-phase detection
async function chatSendInput() {
    const text = chatInputField.value.trim();
    if (!text || !currentWs || currentWs.readyState !== WebSocket.OPEN) return;
    // Upload pending files first (only if message provided)
    let uploadedMeta = '';
    if (chatPendingFileList.length) {
        try {
            const data = await uploadPendingFiles(chatPendingFileList);
            uploadedMeta = data.files.map(f => `File uploaded: ${f.path} (${f.size} bytes, ${f.content_type})`).join('\n');
            for (const f of data.files) addChatBubble('sent', `📎 ${f.name}`);
        } catch (err) { alert('Upload failed: ' + err.message); return; }
        chatPendingFileList = [];
        renderPendingFiles(chatPendingFiles, chatPendingFileList, chatAttachBtn);
    }
    // Stop history polling, switch to output detection
    if (chatSnapshotTimer) { clearInterval(chatSnapshotTimer); chatSnapshotTimer = null; }
    addChatBubble('sent', text);
    showTyping();
    const fullText = uploadedMeta ? uploadedMeta + '\n' + text : text;
    sentText = text;
    sentTextFoundLine = -1;
    phase = 'finding';
    contentHash = '';
    idleSince = 0;
    scrollChatToBottom();
    currentWs.send(JSON.stringify(["stdin", fullText]));
    setTimeout(() => {
        if (currentWs && currentWs.readyState === WebSocket.OPEN)
            currentWs.send(JSON.stringify(["stdin", "\r"]));
    }, 50);
    chatInputField.value = '';
    chatAutoResize();
    chatSnapshotTimer = setInterval(pollOutput, 300);
}

function pollOutput() {
    if (!currentTerm || phase === 'idle') return;
    const buf = currentTerm.buffer.active;
    const totalLines = buf.baseY + buf.cursorY + 1;

    // Phase 1: find the user's sent text in the buffer (search backwards)
    if (phase === 'finding') {
        const searchFrom = Math.max(0, totalLines - 50);
        for (let i = totalLines - 1; i >= searchFrom; i--) {
            const line = buf.getLine(i);
            if (line && line.translateToString(true).includes(sentText)) {
                sentTextFoundLine = i;
                phase = 'waiting';
                contentHash = '';
                idleSince = 0;
                return;
            }
        }
        // Timeout after 15s
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince > 15000) { finishOutput(buf, totalLines); }
        return;
    }

    // Phase 2: wait for content to stop changing (3s stable)
    if (phase === 'waiting') {
        let h = '';
        for (let i = sentTextFoundLine; i < totalLines; i++) {
            const line = buf.getLine(i);
            if (line) h += line.translateToString(false) + '|';
        }
        if (h !== contentHash) {
            contentHash = h;
            idleSince = Date.now();
            return;
        }
        if (Date.now() - idleSince < IDLE_MS) return;
        finishOutput(buf, totalLines);
    }
}

function finishOutput(buf, totalLines) {
    // Trim trailing blank lines
    let outputTo = totalLines;
    for (let i = outputTo - 1; i >= sentTextFoundLine; i--) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).trim()) break;
        outputTo = i;
    }
    // Collect HTML from sentTextFoundLine to outputTo
    const htmlParts = [];
    for (let j = Math.max(0, sentTextFoundLine); j < outputTo; j++) {
        const { html } = bufferLineToHtml(buf, j);
        htmlParts.push(html);
    }
    const outputHtml = htmlParts.join('\n').replace(/(\n\s*)+$/, '');
    hideTyping();
    if (outputHtml.trim()) addChatBubble('received', '', outputHtml);
    scrollChatToBottom();
    chatLastLine = totalLines;
    phase = 'idle';
    // Resume history polling
    if (chatSnapshotTimer) clearInterval(chatSnapshotTimer);
    chatSnapshotTimer = setInterval(() => {
        if (phase === 'idle') snapshotBuffer();
    }, 500);
}

function chatAutoResize() {
    chatInputField.style.height = 'auto';
    chatInputField.style.height = Math.min(chatInputField.scrollHeight, 100) + 'px';
}
chatInputField.addEventListener('input', chatAutoResize);
chatInputSend.addEventListener('click', chatSendInput);
chatInputField.addEventListener('keydown', (e) => {
    const mob = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (e.key === 'Enter' && !mob && !e.shiftKey) {
        e.preventDefault();
        chatSendInput();
    }
});

function showTyping() {
    if (typingRow) return; // already showing
    typingRow = document.createElement('div');
    typingRow.className = 'chat-typing-row active';
    typingRow.innerHTML = '<div class="chat-typing-bubble"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>';
    chatMessages.appendChild(typingRow);
    chatContactStatus.textContent = 'typing...';
    chatContactStatus.classList.add('typing');
    scrollChatToBottom();
}

function hideTyping() {
    if (typingRow) {
        typingRow.remove();
        typingRow = null;
    }
    chatContactStatus.textContent = 'Connected';
    chatContactStatus.classList.remove('typing');
}

function addChatBubble(type, text, html) {
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    if (timeStr !== lastChatTimeStr) {
        const sep = document.createElement('div');
        sep.className = 'chat-time-sep';
        sep.textContent = timeStr;
        chatMessages.appendChild(sep);
        lastChatTimeStr = timeStr;
    }
    const row = document.createElement('div');
    row.className = 'chat-msg-row ' + type;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    // received: use rich HTML with colors; sent: plain text
    if (type === 'received' && html) {
        // Trim trailing empty lines from HTML for cleaner bubble
        let cleanHtml = html.replace(/(\n\s*)+$/, '');
        bubble.innerHTML = cleanHtml;
    } else {
        bubble.textContent = text;
    }
    row.appendChild(bubble);
    chatMessages.appendChild(row);
}

function scrollChatToBottom() {
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

// Snapshot xterm buffer -> parse into sent/received bubbles with rich HTML
// History: snapshotBuffer reads past terminal output as static HTML bubbles
// Live: user sends text -> typing indicator -> detect response complete -> show bubble
//
// Two-phase detection:
//   Phase 1 (finding): search buffer for user's sent text
//   Phase 2 (waiting): watch content hash until stable for 3s -> capture response
function snapshotBuffer() {
    if (!currentTerm) return;
    const buf = currentTerm.buffer.active;
    const totalLines = buf.baseY + buf.cursorY + 1;
    if (totalLines <= chatLastLine) return;

    // Read lines as both plain text (for classification) and HTML (for display)
    const lines = [];
    for (let i = chatLastLine; i < totalLines; i++) {
        const { text, html } = bufferLineToHtml(buf, i);
        lines.push({ text, html });
    }
    chatLastLine = totalLines;
    if (lines.length === 0) return;

    const blocks = [];
    let mode = 'received';
    let sentTexts = [], sentHtmls = [];
    let recvTexts = [], recvHtmls = [];

    function flushBlock(texts, htmls, type) {
        const t = texts.join('\n').replace(/\s+$/, '');
        const h = htmls.join('\n');
        if (t) blocks.push({ type: type, text: t, html: h });
        return [];
    }

    for (const { text, html } of lines) {
        const promptMatch = text.match(/^❯ (.+)/);
        if (promptMatch) {
            if (mode === 'sent') { flushBlock(sentTexts, sentHtmls, 'sent'); sentTexts = []; sentHtmls = []; }
            else { flushBlock(recvTexts, recvHtmls, 'received'); recvTexts = []; recvHtmls = []; }
            mode = 'sent';
            // Strip prompt from display
            const cmdStart = html.indexOf('❯');
            const cmdHtml = cmdStart >= 0 ? html.substring(cmdStart + 1).replace(/^\s+/, '') : escText(promptMatch[1]);
            sentTexts.push(promptMatch[1]);
            sentHtmls.push(cmdHtml);
            continue;
        }

        if (mode === 'sent') {
            const isBlank = text.trim() === '';
            const hasLeadingSpace = /^\s/.test(text) && !isBlank;
            if (isBlank || hasLeadingSpace) {
                flushBlock(sentTexts, sentHtmls, 'sent');
                sentTexts = []; sentHtmls = [];
                mode = 'received';
                recvTexts.push(text);
                recvHtmls.push(html);
            } else {
                sentTexts.push(text);
                sentHtmls.push(html);
            }
        } else {
            recvTexts.push(text);
            recvHtmls.push(html);
        }
    }
    if (mode === 'sent') { flushBlock(sentTexts, sentHtmls, 'sent'); }
    else { flushBlock(recvTexts, recvHtmls, 'received'); }

    if (blocks.length === 0) return;

    const hasReceived = blocks.some(b => b.type === 'received');
    if (hasReceived) showTyping();

    setTimeout(() => {
        if (hasReceived) hideTyping();
        for (const block of blocks) {
            if (block.text) addChatBubble(block.type, block.text, block.html);
        }
        scrollChatToBottom();
    }, hasReceived ? 200 : 0);
}

// ========== ANSI COLOR RENDERING ==========

// ANSI 16-color palette — GitHub-style for light background (#f6f8fa)
const ANSI16 = [
    '#1f2328','#cf222e','#116329','#9a6700','#0550ae','#8250df','#0e7490','#59636e',
    '#6e7781','#d1242f','#1a7f37','#b35900','#0969da','#8250df','#0e7490','#1f2328',
];
// 256-color: generate the 6x6x6 cube + grayscale
const ANSI256 = [...ANSI16];
// 16-231: 6x6x6 color cube
for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
        for (let b = 0; b < 6; b++)
            ANSI256.push('#' + [r,g,b].map(v => (v ? v*40+55 : 0).toString(16).padStart(2,'0')).join(''));
// 232-255: grayscale
for (let i = 0; i < 24; i++) {
    const v = (8 + i * 10).toString(16).padStart(2, '0');
    ANSI256.push('#' + v + v + v);
}

function escText(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Resolve fg/bg color from mode+value, returns hex string or null
function resolveColor(mode, value) {
    // mode 1 = palette (could be 0-15 or 0-255 depending on xterm version)
    if (mode === 1) {
        if (value < 16) return ANSI16[value];
        else if (value < 256) return ANSI256[value];
    }
    // mode 2 = RGB (24-bit) OR 256-palette in some xterm builds
    else if (mode === 2) {
        if (value < 256) return ANSI256[value];
        else {
            return '#' + ((value >> 16) & 0xff).toString(16).padStart(2,'0')
                       + ((value >> 8) & 0xff).toString(16).padStart(2,'0')
                       + (value & 0xff).toString(16).padStart(2,'0');
        }
    }
    // mode 3 = RGB in newer xterm.js
    else if (mode === 3) {
        return '#' + ((value >> 16) & 0xff).toString(16).padStart(2,'0')
                   + ((value >> 8) & 0xff).toString(16).padStart(2,'0')
                   + (value & 0xff).toString(16).padStart(2,'0');
    }
    return null;
}

// Adjust foreground colors that are too light to read on #f6f8fa background
function adjustForLightBg(hex) {
    if (!hex || hex.length < 4) return hex;
    let r, g, b;
    if (hex.length === 4) { // #RGB
        r = parseInt(hex[1]+hex[1], 16);
        g = parseInt(hex[2]+hex[2], 16);
        b = parseInt(hex[3]+hex[3], 16);
    } else {
        r = parseInt(hex.slice(1,3), 16);
        g = parseInt(hex.slice(3,5), 16);
        b = parseInt(hex.slice(5,7), 16);
    }
    // Relative luminance (sRGB)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    // If too bright (luminance > 0.75), darken to readable
    if (lum > 0.75) {
        const factor = 0.55;
        r = Math.round(r * factor);
        g = Math.round(g * factor);
        b = Math.round(b * factor);
        return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
    }
    return hex;
}

// Convert buffer line -> HTML with color/bold/italic spans
function bufferLineToHtml(buf, lineIdx) {
    const line = buf.getLine(lineIdx);
    if (!line) return { text: '', html: '' };
    const text = line.translateToString(true);
    if (!text.trim()) return { text, html: escText(text) };
    try {
        let html = '';
        let curStyle = '', spanOpen = false;
        const cols = line.length;
        // CRITICAL: reuse cell object for correct data (xterm.js requirement)
        let cell = line.getCell(0);
        if (!cell) return { text, html: escText(text) };
        for (let x = 0; x < cols; x++) {
            cell = line.getCell(x, cell);
            if (!cell) break;
            const ch = cell.getChars();
            // Skip only width-0 cells (2nd cell of wide chars)
            if (!ch) {
                const w = cell.getWidth ? cell.getWidth() : 1;
                if (w === 0) continue;
            }
            let style = '';
            try {
                const fgMode = cell.getFgColorMode();
                const fgVal = cell.getFgColor();
                let color = resolveColor(fgMode, fgVal);
                // Adjust colors that are too light on #f6f8fa background
                if (color) {
                    color = adjustForLightBg(color);
                    style += 'color:' + color + ';';
                }
                // Background color support
                const bgMode = cell.getBgColorMode ? cell.getBgColorMode() : 0;
                const bgVal = cell.getBgColor ? cell.getBgColor() : 0;
                let bgColor = resolveColor(bgMode, bgVal);
                if (bgColor) style += 'background:' + bgColor + ';padding:0 2px;border-radius:2px;';
                // isBold/isItalic/isUnderline return 0 or 1, not boolean
                if (cell.isBold && cell.isBold() === 1) style += 'font-weight:700;';
                if (cell.isItalic && cell.isItalic() === 1) style += 'font-style:italic;';
                if (cell.isUnderline && cell.isUnderline() === 1) style += 'text-decoration:underline;';
            } catch(e) {}
            if (style !== curStyle) {
                if (spanOpen) { html += '</span>'; spanOpen = false; }
                if (style) { html += '<span style="' + style + '">'; spanOpen = true; }
                curStyle = style;
            }
            const outCh = ch || ' ';
            if (outCh === '<') html += '&lt;';
            else if (outCh === '>') html += '&gt;';
            else if (outCh === '&') html += '&amp;';
            else html += outCh;
        }
        if (spanOpen) html += '</span>';
        // Trim trailing spaces from rendered HTML
        html = html.replace(/(<\/span>)?\s+$/, '$1');
        return { text, html: html.length > 0 ? html : escText(text) };
    } catch(e) {
        console.warn('bufferLineToHtml error:', e);
        return { text, html: escText(text) };
    }
}

// ========== CUSTOM SCROLLBAR ==========

function updateScrollbar() {
    const viewport = terminalContainer.querySelector('.xterm-viewport');
    if (!viewport) return;
    const { scrollHeight, clientHeight, scrollTop } = viewport;
    const trackH = scrollbar.clientHeight - 8;
    if (trackH <= 0) return;
    if (scrollHeight <= clientHeight) {
        scrollThumb.style.height = trackH + 'px';
        scrollThumb.style.top = '4px';
        scrollThumb.style.opacity = '0.3';
        return;
    }
    scrollThumb.style.opacity = '1';
    const thumbH = Math.max(40, (clientHeight / scrollHeight) * trackH);
    const maxThumbTop = trackH - thumbH;
    const thumbTop = 4 + (scrollTop / (scrollHeight - clientHeight)) * maxThumbTop;
    scrollThumb.style.height = thumbH + 'px';
    scrollThumb.style.top = thumbTop + 'px';
}

// Drag support (mouse + touch)
function onDragStart(e) {
    e.preventDefault();
    scrollDragging = true;
    scrollThumb.classList.add('dragging');
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    scrollDragStartY = y;
    scrollDragStartTop = parseFloat(scrollThumb.style.top) || 0;
}
function onDragMove(e) {
    if (!scrollDragging) return;
    e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const delta = y - scrollDragStartY;
    const viewport = terminalContainer.querySelector('.xterm-viewport');
    if (!viewport) return;
    const trackH = scrollbar.clientHeight - 8;
    const thumbH = scrollThumb.clientHeight;
    const maxThumbTop = trackH - thumbH;
    const rawTop = scrollDragStartTop + delta - 4;
    const newTop = Math.max(0, Math.min(maxThumbTop, rawTop));
    const scrollRatio = maxThumbTop > 0 ? newTop / maxThumbTop : 0;
    viewport.scrollTop = scrollRatio * (viewport.scrollHeight - viewport.clientHeight);
}
function onDragEnd() {
    scrollDragging = false;
    scrollThumb.classList.remove('dragging');
}
scrollThumb.addEventListener('mousedown', onDragStart);
scrollThumb.addEventListener('touchstart', onDragStart, { passive: false });
document.addEventListener('mousemove', onDragMove);
document.addEventListener('touchmove', onDragMove, { passive: false });
document.addEventListener('mouseup', onDragEnd);
document.addEventListener('touchend', onDragEnd);

// Click on track to jump
scrollbar.addEventListener('click', (e) => {
    if (e.target === scrollThumb) return;
    const viewport = terminalContainer.querySelector('.xterm-viewport');
    if (!viewport) return;
    const rect = scrollbar.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    viewport.scrollTop = clickRatio * (viewport.scrollHeight - viewport.clientHeight);
});

// Update scrollbar on scroll and content changes
setInterval(updateScrollbar, 200);

// ========== iOS KEYBOARD FIX ==========

function pinBodyScroll() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    // Restore terminal scroll to bottom after layout shift
    if (currentTerm) {
        const vp = terminalContainer.querySelector('.xterm-viewport');
        if (vp) setTimeout(() => { vp.scrollTop = vp.scrollHeight; }, 50);
    }
    // Restore chat scroll to bottom
    if (chatMode) setTimeout(scrollChatToBottom, 50);
}
if (window.visualViewport) {
    const vv = window.visualViewport;
    vv.addEventListener('resize', pinBodyScroll);
    vv.addEventListener('scroll', pinBodyScroll);
}
document.querySelectorAll('input, textarea').forEach(el => {
    el.addEventListener('focus', () => setTimeout(pinBodyScroll, 300));
});

// ========== INIT ==========

// Sidebar toggle
mobileToggle.addEventListener('click', () => {
    if (isMobile) {
        termSidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    } else {
        termSidebar.classList.contains('collapsed') ? openSidebar() : closeSidebar();
    }
});
mobileOverlay.addEventListener('click', closeSidebar);

// Back button
backBtn.addEventListener('click', () => {
    window.location.href = (BASE || '') + '/files';
});

// Create new terminal
newTermBtn.addEventListener('click', async () => {
    const result = await showConfigModal(null);
    if (result === null) return;  // cancelled

    try {
        const xsrf = getXsrf();
        const res = await fetch(JUPYTER + '/api/terminals', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': xsrf,
            },
            credentials: 'same-origin',
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(res.status + ' ' + body);
        }
        const data = await res.json();
        await loadTerminals();

        // If name given, save to config (persistent terminal)
        const isPersistent = !!result.name;
        if (isPersistent) {
            // Rebuild slot map with the new terminal included
            slotMap = buildSlotMap(Object.values(terminalData));
            const slot = slotMap[data.name];
            if (slot) {
                await setServerSlot(slot, result.name, result.command);
            }
        }
        // No name -> temporary terminal (not saved, disappears on restart)

        connectTerminal(data.name);
        closeSidebar();

        // Execute startup command via WebSocket after connection
        if (result.command && result.command.trim()) {
            // Wait for WS to open then send commands
            const waitAndSend = () => {
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    setTimeout(() => sendMultilineCommand(currentWs, result.command), 500);
                } else {
                    setTimeout(waitAndSend, 200);
                }
            };
            waitAndSend();
        }
    } catch (e) {
        alert('Failed to create terminal: ' + e.message);
    }
});

// Reconnect button
reconnectBtn.addEventListener('click', () => {
    if (currentName) connectTerminal(currentName);
});

// Shutdown button in toolbar
shutdownBtn.addEventListener('click', () => {
    if (!currentName) return;
    if (confirm('Shutdown Terminal ' + currentName + '?')) {
        deleteTerminal(currentName);
    }
});

// Rename button in toolbar
renameBtn.addEventListener('click', async () => {
    if (!currentName) return;
    const result = await showConfigModal(currentName);
    if (result === null) return;
    const finalName = result.name || currentDisplayName;
    await renameTerminal(currentName, finalName, result.command);
});

loadTerminals();
setInterval(loadTerminals, 10000);

})();
