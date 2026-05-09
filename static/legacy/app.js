/* === Claude Notebook App — Entry point ===
 *
 * Thin shell that wires all feature modules together. After the Phase 1–13
 * refactor (see .agent/REFACTOR.md) this file is the orchestrator:
 *   - grabs top-level DOM elements the preview-overlay machinery owns
 *   - holds the cross-cutting `currentFileData` state
 *   - init()s the feature modules (sidebar, tree, finder, upload, csv,
 *     calendar, notion editor, auto-save, history modal, keyboard-help)
 *   - dispatches renderPreviewMode() / loadPreviewContent() based on file ext
 *   - handles the URL-hash back/forward integration
 */

import { BASE, XSRF, fetchOpts } from './core/api.js';
import { escHtml, rewriteRelativeMediaUrls, formatSize } from './core/utils.js';
import { initSidebar } from './ui/sidebar.js';
import { initTree, loadTree } from './ui/tree.js';
import { downloadFile, initFileOpsButtons } from './ui/file-ops.js';
import {
    initAutoSave,
    setSaveStatus,
    scheduleSave,
    flushSave,
    cancelPendingSave,
    resetAutoSave,
    getSavedBaseline,
    setSavedBaseline,
} from './editor/auto-save.js';
import { initKeyboardHelp } from './editor/keyboard-help.js';
import { rehydrateMathBlocks } from './editor/math.js';
import { rehydrateTOCBlocks } from './editor/toc.js';
import {
    initNotion,
    setupNotionEditor,
    rehydrateTaskCheckboxes,
} from './editor/notion.js';
import { domToMarkdown } from './editor/markdown.js';
import { initHistoryModal } from './ui/history-modal.js';
import { initUpload } from './ui/upload.js';
import { initFinder, loadFinderGrid, getCurrentDir as getFinderDir } from './ui/finder.js';
import {
    CSV_EXTS,
    initCsv,
    loadCsvConfig,
    renderCsvViewer,
} from './views/csv.js';
import {
    TIMETABLE_EXTS,
    DATETABLE_EXTS,
    renderTimetable,
    renderDatetable,
} from './views/calendar.js';
import { XLSX_EXTS, renderXlsxViewer } from './views/xlsx.js';

// Browser-rendered binary previews — handled directly in loadPreviewContent
// before the JSON /api/file roundtrip (server returns bytes for these).
const PDF_EXTS = ['.pdf'];

// Still used by getCurrentContent dispatcher
import { hasCsvRows, csvTableToString } from './views/csv.js';
import { getTimetableJson, getDatetableJson } from './views/calendar.js';

// Used by attachClickToEdit / inline-text-edit textarea in loadPreviewContent
import { IMAGE_EXTS } from './core/utils.js';

const contentEl = document.getElementById('content');
    const finder = document.getElementById('finder');
    const previewOverlay = document.getElementById('previewOverlay');
    const previewBody = document.getElementById('previewBody');
    const previewBreadcrumb = document.getElementById('previewBreadcrumb');
    const previewClose = document.getElementById('previewClose');
    const previewDownload = document.getElementById('previewDownload');
    const previewStatus = document.getElementById('previewStatus');
    const previewViewToggle = document.getElementById('previewViewToggle');
    const previewHistory = document.getElementById('previewHistory');
    const previewHelp = document.getElementById('previewHelp');
    const previewColorRules = document.getElementById('previewColorRules');

    let currentPreviewPath = '';
    let isInlineEditing = false;           // true when md/txt/code textarea is shown
    let currentFileData = null;            // { path, content, extension }

    initSidebar();
    initKeyboardHelp();
    initNotion({
        getFile: () => currentFileData,
        getFileDir: currentFileDir,
    });
    initCsv({ getFilePath: () => currentFileData ? currentFileData.path : '' });
    initFinder({
        openFile: (path) => openPreview(path),
        onNavigate: (dirPath) => {
            updateHash(dirPath);
            const folderName = dirPath.split('/').pop() || 'Workspace';
            document.title = folderName + ' - Claude Notebook';
        },
    });
    initUpload({
        getCurrentDir: getFinderDir,
        onUploaded: () => { loadFinderGrid(getFinderDir()); loadTree(); },
    });

    // Configure marked
    marked.setOptions({ gfm: true, breaks: true });

    /** Return the workspace dir containing the currently-open file. */
    function currentFileDir() {
        if (!currentFileData || !currentFileData.path) return '';
        const p = currentFileData.path;
        const i = p.lastIndexOf('/');
        return i === -1 ? '' : p.slice(0, i);
    }

    function refreshWorkspaceViews() {
        loadFinderGrid(getFinderDir());
        loadTree();
    }


    initFileOpsButtons({
        getCurrentDir: getFinderDir,
        onChanged: refreshWorkspaceViews,
    });


    // === Preview Overlay ===
    const EDITABLE_EXTS = ['.md', '.markdown', '.csv', '.txt', '.py', '.js', '.json', '.yaml', '.yml', '.html', '.css', '.sh', '.toml', '.cfg', '.ini', '.xml', '.timetable', '.datetable'];
    const MD_EXTS = ['.md', '.markdown'];
    const SCHEDULE_EXTS = ['.timetable', '.datetable']; // always-interactive types

    function openPreview(path) {
        currentPreviewPath = path;
        isInlineEditing = false;
        currentFileData = null;
        resetAutoSave();
        setSaveStatus('idle');
        previewOverlay.classList.add('active');
        finder.style.display = 'none';
        previewHistory.style.display = 'none';
        previewHelp.style.display = 'none';
        // outer (multi-tab unified) 페이지에 현재 열린 파일 알림 → tabStore 의
        // 'files' 탭에 currentFile 로 저장 → F5 시 자동 복원 가능.
        try {
            window.parent?.postMessage({ type: 'cn-file-opened', path }, '*');
        } catch (_) {}
        if (previewViewToggle) {
            previewViewToggle.style.display = 'none';
            previewViewToggle.textContent = 'Text';
            previewViewToggle.title = 'Switch to plain text view';
        }
        previewColorRules.style.display = 'none';
        loadPreviewContent(path);
        updateHash(path);
        const fileName = path.split('/').pop() || path;
        document.title = fileName + ' - Claude Notebook';
    }

    async function closePreviewFn() {
        // Flush any pending auto-save before closing so the user never loses
        // work just because they navigated away quickly.
        await flushSave({ silent: true });
        previewOverlay.classList.remove('active');
        previewBody.classList.remove('csv-mode');
        finder.style.display = '';
        previewBody.innerHTML = '';
        currentPreviewPath = '';
        isInlineEditing = false;
        currentFileData = null;
        resetAutoSave();
        previewHistory.style.display = 'none';
        previewHelp.style.display = 'none';
        if (previewViewToggle) {
            previewViewToggle.style.display = 'none';
            previewViewToggle.textContent = 'Text';
            previewViewToggle.title = 'Switch to plain text view';
        }
        previewColorRules.style.display = 'none';
        setSaveStatus('idle');
        updateHash(getFinderDir());
        const folderName = getFinderDir().split('/').pop() || 'Workspace';
        document.title = folderName + ' - Claude Notebook';
    }
    previewClose.addEventListener('click', closePreviewFn);
    previewDownload.addEventListener('click', () => { if (currentPreviewPath) downloadFile(currentPreviewPath); });

    // ========== AUTO-SAVE STATE MACHINE ==========
    // No edit/save buttons. The preview is always ready to become the editor.
    //
    // Flow:
    //   - Opening a file shows a rendered preview (markdown) or raw text view.
    //   - Clicking the rendered preview swaps it for an inline textarea.
    //   - Typing schedules a debounced save (1.5s); blur flushes immediately;
    //     Ctrl/Cmd+S also flushes; Escape reverts.
    //   - CSV / timetable / datetable are always-on editors and schedule save
    //     on every mutation through the same pipeline.
    //   - Status pill in the toolbar shows idle / dirty / saving / saved / error.

    /** Collect the latest content from whichever editor is currently active. */
    function getCurrentContent() {
        if (!currentFileData) return null;
        const ext = currentFileData.extension;
        if (CSV_EXTS.includes(ext)) {
            return hasCsvRows() ? csvTableToString() : currentFileData.content;
        }
        if (TIMETABLE_EXTS.includes(ext)) return getTimetableJson();
        if (DATETABLE_EXTS.includes(ext)) return getDatetableJson();
        // Markdown: when the user has flipped to Text view, read the raw
        // source textarea directly; otherwise serialize the Notion editor.
        if (MD_EXTS.includes(ext)) {
            const sourceTa = previewBody.querySelector('.md-source-edit');
            if (sourceTa) return sourceTa.value;
            const editor = previewBody.querySelector('.notion-editor');
            if (editor) return domToMarkdown(editor);
            return currentFileData.content;
        }
        const ta = previewBody.querySelector('.edit-textarea');
        if (ta) return ta.value;
        return null;
    }

    initAutoSave({
        statusEl: previewStatus,
        getContent: getCurrentContent,
        getPath: () => currentFileData ? currentFileData.path : null,
        onSaved: (content) => { if (currentFileData) currentFileData.content = content; },
    });

    /** Swap the rendered preview for an inline textarea (md / txt / code). */
    function enterInlineEdit(clickY) {
        if (!currentFileData) return;
        if (!EDITABLE_EXTS.includes(currentFileData.extension)) return;
        // Preserve vertical scroll so the switch feels seamless
        const scrollTop = previewBody.scrollTop;
        const ratio = previewBody.scrollHeight > 0
            ? (clickY != null ? clickY : scrollTop) / previewBody.scrollHeight
            : 0;

        isInlineEditing = true;
        previewBody.innerHTML = `<textarea class="edit-textarea" spellcheck="false"></textarea>`;
        const ta = previewBody.querySelector('.edit-textarea');
        ta.value = currentFileData.content || '';

        // Give the browser one frame to compute textarea layout before sizing.
        requestAnimationFrame(() => {
            ta.style.height = 'auto';
            ta.style.height = Math.max(ta.scrollHeight, previewBody.clientHeight - 40) + 'px';
            // Approximate cursor position from where the user clicked
            const totalLen = ta.value.length;
            const approx = Math.round(totalLen * ratio);
            ta.focus({ preventScroll: true });
            try { ta.setSelectionRange(approx, approx); } catch {}
            previewBody.scrollTop = scrollTop;
        });

        ta.addEventListener('input', () => {
            // Re-grow textarea as content changes
            ta.style.height = 'auto';
            ta.style.height = Math.max(ta.scrollHeight, previewBody.clientHeight - 40) + 'px';
            scheduleSave();
        });
        ta.addEventListener('blur', () => { flushSave(); });
        ta.addEventListener('keydown', (e) => {
            // Tab inserts 4 spaces (standard editor affordance)
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = ta.selectionStart;
                ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(ta.selectionEnd);
                ta.selectionStart = ta.selectionEnd = start + 4;
                scheduleSave();
                return;
            }
            // Ctrl/Cmd+S flushes immediately without waiting for debounce
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                flushSave();
                return;
            }
            // Escape reverts to last-saved content and re-renders preview
            if (e.key === 'Escape') {
                e.preventDefault();
                const baseline = getSavedBaseline();
                ta.value = baseline != null ? baseline : (currentFileData.content || '');
                isInlineEditing = false;
                cancelPendingSave();
                setSaveStatus('saved');
                renderPreviewMode(currentFileData);
            }
        });
    }

    // Global Ctrl/Cmd+S handler: works even when focus isn't in the textarea
    // (e.g., user is scrolling the preview but wants to force a save).
    document.addEventListener('keydown', (e) => {
        if (!previewOverlay.classList.contains('active')) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            flushSave();
        }
    });
    // Flush save if the tab is closed / navigated away. fetch(keepalive:true)
    // lets the request finish even after the page unloads.
    window.addEventListener('beforeunload', () => {
        cancelPendingSave();
        if (!currentFileData) return;
        const content = getCurrentContent();
        if (content == null || content === getSavedBaseline()) return;
        try {
            fetch(`${BASE}/api/save`, {
                method: 'PUT',
                credentials: 'same-origin',
                keepalive: true,
                headers: {
                    'Content-Type': 'application/json',
                    'X-XSRFToken': XSRF,
                    'ngrok-skip-browser-warning': '1',
                },
                body: JSON.stringify({ path: currentFileData.path, content }),
            });
        } catch {}
    });

    // Notion editor moved to editor/notion.js

    async function renderPreviewMode(data) {
        isInlineEditing = false;
        const isCsv = CSV_EXTS.includes(data.extension);
        previewBody.classList.toggle('csv-mode', isCsv);
        previewColorRules.style.display = isCsv ? '' : 'none';
        if (isCsv) {
            await loadCsvConfig();
            renderCsvViewer(data.content);
        } else if (TIMETABLE_EXTS.includes(data.extension)) {
            renderTimetable(data.content, data.path, { initial: true });
        } else if (DATETABLE_EXTS.includes(data.extension)) {
            renderDatetable(data.content, data.path, { initial: true });
        } else if (MD_EXTS.includes(data.extension) && typeof marked !== 'undefined') {
            // Rendered markdown IS the editor — no textarea swap, no mode flip
            previewBody.innerHTML = `<div class="markdown-body notion-editor">${marked.parse(data.content)}</div>`;
            if (typeof hljs !== 'undefined') {
                previewBody.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
            }
            const editor = previewBody.querySelector('.notion-editor');
            // Rewrite relative <img>/<audio>/<video>/<a> src so media renders
            // inline from /api/file?raw=1. Must run BEFORE setupNotionEditor so
            // the serialize-for-baseline step uses the data-*-original form.
            rewriteRelativeMediaUrls(editor, currentFileDir());
            // Task-list checkboxes come out of marked with `disabled` set and
            // tend to be swallowed by contenteditable on touch; fix both here
            // before we wire up the editor so the round-trip stays clean.
            rehydrateTaskCheckboxes(editor);
            setupNotionEditor(editor);
            // Rehydrate math blocks (KaTeX re-render) and TOC click handlers
            rehydrateMathBlocks(editor);
            rehydrateTOCBlocks(editor);
            // Show the MD ↔ Text view toggle for markdown files.
            if (previewViewToggle) {
                previewViewToggle.style.display = '';
                previewViewToggle.textContent = 'Text';
                previewViewToggle.title = 'Switch to plain text view';
            }
            // Use the serialized form as baseline so no-op opens don't dirty
            // the file just because the round-trip isn't byte-identical.
            setSavedBaseline(domToMarkdown(editor));
        } else if (EDITABLE_EXTS.includes(data.extension)) {
            previewBody.innerHTML = `<pre class="file-raw editable-hint">${escHtml(data.content)}</pre>`;
            attachClickToEdit(previewBody.querySelector('.file-raw'));
        } else {
            previewBody.innerHTML = `<pre class="file-raw">${escHtml(data.content)}</pre>`;
        }
    }

    /** Attach a single-click listener that swaps the rendered view for the
     *  inline textarea. Used for non-markdown editable file types
     *  (code/text), which don't make sense as a WYSIWYG editor. */
    function attachClickToEdit(el) {
        if (!el) return;
        el.addEventListener('click', (e) => {
            // Don't hijack clicks on links — let them navigate normally
            if (e.target.closest('a')) return;
            const rect = previewBody.getBoundingClientRect();
            const clickY = (e.clientY - rect.top) + previewBody.scrollTop;
            enterInlineEdit(clickY);
        });
    }

    initHistoryModal({
        getFile: () => currentFileData,
        onRestored: () => { if (currentFileData) renderPreviewMode(currentFileData); },
    });

    async function loadPreviewContent(path) {
        try {
            const ext = '.' + path.split('.').pop().toLowerCase();
            const parts = path.split('/');
            previewBreadcrumb.innerHTML = parts
                .map((p, i) => `<span class="bc-part">${escHtml(p)}</span>`)
                .join('<span class="bc-sep"> / </span>');
            previewHistory.style.display = 'none';

            if (IMAGE_EXTS.includes(ext)) {
                const imgUrl = `${BASE}/api/file?path=${encodeURIComponent(path)}`;
                const imgRes = await fetch(imgUrl, fetchOpts);
                if (!imgRes.ok) throw new Error('Image load failed');
                const blob = await imgRes.blob();
                const objectUrl = URL.createObjectURL(blob);
                previewBody.innerHTML = `<div class="image-viewer"><img src="${objectUrl}" alt="${escHtml(parts[parts.length - 1])}"></div>`;
                return;
            }

            if (PDF_EXTS.includes(ext)) {
                // Native browser PDF viewer. <object> has the widest
                // cross-browser support for inline PDFs; on environments
                // that refuse to render inline (some iOS Safari builds),
                // the fallback <a> inside the <object> shows a download
                // link instead of a blank frame.
                // Needs the server to serve `.pdf` with Content-Type:
                // application/pdf — make sure Jupyter has been restarted
                // after the MEDIA_CONTENT_TYPES change or the file will
                // arrive as application/octet-stream and the browser will
                // force-download no matter what tag we use.
                const pdfUrl = `${BASE}/api/file?path=${encodeURIComponent(path)}&raw=1`;
                const fname = parts[parts.length - 1];
                previewBody.innerHTML =
                    `<object class="pdf-frame" data="${pdfUrl}" type="application/pdf">
                        <div class="pdf-fallback">
                            <p><strong>${escHtml(fname)}</strong></p>
                            <p>이 브라우저에서는 인라인 PDF 미리보기를 지원하지 않습니다.</p>
                            <a href="${pdfUrl}" target="_blank" rel="noopener noreferrer">새 창에서 열기</a>
                        </div>
                    </object>`;
                return;
            }

            if (XLSX_EXTS.includes(ext)) {
                await renderXlsxViewer(path);
                return;
            }

            // .html / .htm — sandboxed iframe 으로 inline 렌더링. allow-scripts
            // 없음 (XSS 차단), allow-same-origin 도 X (workspace 자원 격리).
            // Source view 가 필요하면 사용자가 .txt 로 보거나 raw 링크 사용.
            if (ext === '.html' || ext === '.htm') {
                const htmlUrl = `${BASE}/api/file?path=${encodeURIComponent(path)}&raw=1`;
                const fname = parts[parts.length - 1];
                previewBody.innerHTML =
                    `<iframe class="html-frame" src="${htmlUrl}" sandbox=""
                             style="width:100%;height:100%;border:0;background:#fff"
                             title="${escHtml(fname)}"></iframe>
                     <div style="position:absolute;top:8px;right:8px;font-size:12px">
                       <a href="${htmlUrl}" target="_blank" rel="noopener noreferrer"
                          style="background:rgba(0,0,0,0.05);padding:4px 8px;border-radius:4px;color:inherit;text-decoration:none">
                         새 창에서 열기 (스크립트 활성)
                       </a>
                     </div>`;
                return;
            }

            const res = await fetch(`${BASE}/api/file?path=${encodeURIComponent(path)}`, fetchOpts);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            currentFileData = data;
            setSavedBaseline(data.content);

            // File too large for inline preview — offer download
            if (data.too_large) {
                previewBody.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-secondary);">
                    <p style="font-size:48px;margin-bottom:12px;">📦</p>
                    <p><strong>${escHtml(data.name)}</strong></p>
                    <p style="margin:8px 0;">${formatSize(data.size)} — too large to preview</p>
                    <a href="${BASE}/api/download?path=${encodeURIComponent(path)}"
                       style="display:inline-block;margin-top:12px;padding:8px 20px;background:var(--accent);color:#fff;border-radius:6px;text-decoration:none;">Download</a>
                </div>`;
                return;
            }

            // History button only for files that are editable (and therefore
            // may have accumulated snapshots)
            if (EDITABLE_EXTS.includes(data.extension)) {
                previewHistory.style.display = '';
            }
            // Help button for markdown files (where all the shortcuts apply)
            if (MD_EXTS.includes(data.extension)) {
                previewHelp.style.display = '';
            }

            renderPreviewMode(data);
        } catch (err) {
            previewBody.innerHTML = `<p style="padding:20px;color:var(--text-secondary);">Error: ${escHtml(err.message)}</p>`;
        }
    }


    // === URL hash navigation ===
    let navigatingBack = false;
    function syncHashToPath() {
        navigatingBack = true;
        const hash = decodeURIComponent(location.hash.slice(1));
        const previewActive = previewOverlay.classList.contains('active');
        // Hash is either a folder ("" or "notes/sub") or a file ("notes/a.md").
        // Treat anything whose last segment has a dot as a file.
        const lastPart = hash ? hash.split('/').pop() : '';
        const isFileHash = lastPart.includes('.');
        // Empty / folder hash while a preview is open → the user pressed back
        // to close the file. Hide the preview overlay before loading the grid
        // so we actually return to the finder view.
        if (!isFileHash && previewActive) {
            closePreviewFn();
        }
        if (!hash) { loadFinderGrid(''); navigatingBack = false; return; }
        if (isFileHash) {
            const parentPath = hash.includes('/') ? hash.substring(0, hash.lastIndexOf('/')) : '';
            loadFinderGrid(parentPath);
            openPreview(hash);
        } else {
            loadFinderGrid(hash);
        }
        navigatingBack = false;
    }

    let hashInitialized = false;
    function updateHash(path) {
        const newHash = path ? '#' + encodeURIComponent(path) : '';
        if (location.hash !== newHash) {
            if (!hashInitialized || navigatingBack) {
                history.replaceState(null, '', location.pathname + location.search + newHash);
                hashInitialized = true;
            } else {
                history.pushState(null, '', location.pathname + location.search + newHash);
            }
        } else if (!hashInitialized) {
            hashInitialized = true;
        }
    }


    window.addEventListener('hashchange', syncHashToPath);
    window.addEventListener('popstate', syncHashToPath);

    // === Init ===
    initTree({ openFile: openPreview, openDir: loadFinderGrid });
    loadTree();
    syncHashToPath();
    // 외부 (outer multi-tab) 가 __cnOpenFile 호출 시 충돌 회피용 ready 플래그.
    // syncHashToPath 가 끝난 후에만 outer 의 restore 가 실행되도록.
    try { window.__cnReady = true; } catch (_) {}

    // Outer (multi-tab unified) 페이지에서 OUTER 사이드바/finder 클릭 시 이
    // iframe 의 file 미리보기를 직접 띄우도록 노출. hash 기반보다 안전 —
    // hashchange 가 onNavigate 의 updateHash('') 와 충돌해서 hash 가 즉시
    // 비워지는 회귀가 있었음.
    try {
        window.__cnOpenFile = (path) => {
            if (typeof path !== 'string' || !path) return;
            // loadFinderGrid 호출하면 onNavigate → updateHash → hashchange →
            // syncHashToPath 가 preview 를 즉시 closePreviewFn 으로 덮어쓰는
            // 회귀 발견. 외부에서 파일 열기는 openPreview 만으로 충분 (parent
            // finder 표시는 사용자가 다시 보고 싶을 때 finder 열면 됨).
            openPreview(path);
        };
        // outer 페이지가 unsaved 가드 검사할 때 사용
        window.__cnIsDirty = () => {
            try {
                if (!currentFileData) return false;
                const content = getCurrentContent();
                return content != null && content !== getSavedBaseline();
            } catch (_) { return false; }
        };
    } catch (_) {}
