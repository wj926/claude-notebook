/* === Claude Notebook App — Finder + File Management ===
 *
 * Entry point. Modularization is in progress (see .agent/REFACTOR.md):
 * Phase 1 extracted pure helpers / API wrappers into `core/`.
 * Subsequent phases will peel off feature areas (sidebar, finder, editor,
 * CSV, calendar) into their own modules. Until then this file is the
 * orchestrator that wires DOM lookups, app state, and event listeners.
 */

import {
    BASE,
    XSRF,
    fetchOpts,
    mutFetchOpts,
    apiRawUrl,
    fetchTreeLevel,
} from './core/api.js';
import {
    escHtml,
    IMAGE_EXTS,
    AUDIO_EXTS,
    VIDEO_EXTS,
    getFileIcon,
    fileTypeLabel,
    resolveRelPath,
    rewriteRelativeMediaUrls,
    isMobile,
    formatFileSize,
    formatSize,
    formatByteSize,
    formatMtime,
} from './core/utils.js';
import { initSidebar } from './ui/sidebar.js';
import { initTree, loadTree } from './ui/tree.js';
import {
    downloadFile,
    downloadPaths,
    deleteItem as deleteItemApi,
    deletePaths,
    renameItem as renameItemApi,
    initFileOpsButtons,
} from './ui/file-ops.js';
import {
    BLOCK_TAGS,
    closestBlock,
    placeCaretAtStart,
    mediaTagToHtml,
    inlineToMd,
    listToMd,
    tableToMd,
    blockToMd,
    domToMarkdown,
    sanitizePastedHtml,
} from './editor/markdown.js';
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
import { initHistoryModal } from './ui/history-modal.js';
import {
    CSV_EXTS,
    initCsv,
    loadCsvConfig,
    renderCsvViewer,
    renderCsvEditor,
    csvTableToString,
    hasCsvRows,
} from './views/csv.js';

const contentEl = document.getElementById('content');
    const finder = document.getElementById('finder');
    const finderGrid = document.getElementById('finderGrid');
    const finderBreadcrumb = document.getElementById('finderBreadcrumb');
    const finderEmpty = document.getElementById('finderEmpty');
    const finderUpload = document.getElementById('finderUpload');
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
    const helpOverlay = document.getElementById('helpOverlay');

    let currentFinderPath = '';
    let currentPreviewPath = '';
    let isInlineEditing = false;           // true when md/txt/code textarea is shown
    let currentFileData = null;            // { path, content, extension }
    // Markdown preview view mode: 'rendered' (Notion editor) | 'text' (raw <pre>)
    let _mdViewMode = 'rendered';

    initSidebar();
    initCsv({ getFilePath: () => currentFileData ? currentFileData.path : '' });

    // Configure marked
    marked.setOptions({ gfm: true, breaks: true });

    /** Return the workspace dir containing the currently-open file. */
    function currentFileDir() {
        if (!currentFileData || !currentFileData.path) return '';
        const p = currentFileData.path;
        const i = p.lastIndexOf('/');
        return i === -1 ? '' : p.slice(0, i);
    }

    // === Multi-select state ===
    let selectedPaths = new Set();
    let lastClickedIndex = -1;
    let currentItems = [];
    let _rubberBandUsed = false; // set true when rubber-band drag selects items

    // === View mode state ===
    let viewMode = localStorage.getItem('finderViewMode') || 'grid'; // 'grid' | 'detail'
    let detailSortKey = 'name'; // 'name' | 'mtime' | 'size' | 'type'
    let detailSortDesc = false;

    function clearSelection() {
        selectedPaths.clear();
        lastClickedIndex = -1;
        finderGrid.querySelectorAll('.finder-item.selected').forEach(el => el.classList.remove('selected'));
        updateSelectionBar();
    }

    function updateSelectionBar() {
        let bar = document.getElementById('selectionBar');
        if (selectedPaths.size === 0) {
            if (bar) bar.style.display = 'none';
            return;
        }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'selectionBar';
            bar.className = 'selection-bar';
            const finder = document.getElementById('finder');
            finder.insertBefore(bar, finderGrid);
        }
        bar.style.display = '';
        bar.innerHTML = `
            <span class="selection-bar-count">${selectedPaths.size} selected</span>
            <div class="selection-bar-actions">
                <button class="selection-bar-btn" id="selDownloadBtn" title="Download selected">📥 Download</button>
                <button class="selection-bar-btn danger" id="selDeleteBtn" title="Delete selected">🗑 Delete</button>
                <button class="selection-bar-btn" id="selCancelBtn" title="Clear selection">✕</button>
            </div>`;
        document.getElementById('selCancelBtn').addEventListener('click', clearSelection);
        document.getElementById('selDeleteBtn').addEventListener('click', deleteSelected);
        document.getElementById('selDownloadBtn').addEventListener('click', downloadSelected);
    }

    function refreshWorkspaceViews() {
        loadFinderGrid(currentFinderPath);
        loadTree();
    }

    async function deleteSelected() {
        const ok = await deletePaths([...selectedPaths], refreshWorkspaceViews);
        if (ok) clearSelection();
    }

    function downloadSelected() {
        return downloadPaths([...selectedPaths]);
    }

    function deleteItem(item) {
        return deleteItemApi(item, refreshWorkspaceViews);
    }

    function renameItem(item) {
        return renameItemApi(item, refreshWorkspaceViews);
    }

    // === Finder Grid/Detail view ===
    function sortItems(items) {
        const dirFirst = (a, b) => (a.type !== b.type) ? (a.type === 'directory' ? -1 : 1) : 0;
        items.sort((a, b) => {
            const d = dirFirst(a, b);
            if (d !== 0) return d;
            let cmp = 0;
            if (detailSortKey === 'name') cmp = a.name.localeCompare(b.name);
            else if (detailSortKey === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0);
            else if (detailSortKey === 'size') cmp = (a.size || 0) - (b.size || 0);
            else if (detailSortKey === 'type') cmp = fileTypeLabel(a).localeCompare(fileTypeLabel(b));
            return detailSortDesc ? -cmp : cmp;
        });
    }

    function attachItemEvents(el, item, idx) {
        el.addEventListener('click', (e) => {
            if (_rubberBandUsed) return;
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                if (selectedPaths.has(item.path)) {
                    selectedPaths.delete(item.path);
                    el.classList.remove('selected');
                } else {
                    selectedPaths.add(item.path);
                    el.classList.add('selected');
                }
                lastClickedIndex = idx;
                updateSelectionBar();
            } else if (e.shiftKey && lastClickedIndex >= 0) {
                e.preventDefault();
                const start = Math.min(lastClickedIndex, idx);
                const end = Math.max(lastClickedIndex, idx);
                const rows = finderGrid.children;
                for (let i = start; i <= end; i++) {
                    selectedPaths.add(currentItems[i].path);
                    if (rows[i]) rows[i].classList.add('selected');
                }
                updateSelectionBar();
            } else {
                if (selectedPaths.size > 0) { clearSelection(); return; }
                if (item.type === 'directory') loadFinderGrid(item.path);
                else openPreview(item.path);
            }
        });
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (selectedPaths.size > 1 && selectedPaths.has(item.path)) {
                showMultiContextMenu(e.clientX, e.clientY);
            } else {
                clearSelection();
                showContextMenu(e.clientX, e.clientY, item);
            }
        });
    }

    function renderGridView(items) {
        finderGrid.className = 'finder-grid';
        finderGrid.innerHTML = '';
        items.forEach((item, idx) => {
            const el = document.createElement('div');
            el.className = 'finder-item';
            el.dataset.path = item.path;
            el.dataset.type = item.type;
            el.dataset.name = item.name;
            el.dataset.index = idx;
            const icon = item.type === 'directory' ? '📁' : getFileIcon(item.name);
            el.innerHTML = `<div class="finder-item-icon">${icon}</div><div class="finder-item-name">${escHtml(item.name)}</div>`;
            attachItemEvents(el, item, idx);
            finderGrid.appendChild(el);
        });
    }

    function renderDetailView(items) {
        finderGrid.className = 'finder-detail';
        const arrow = (key) => detailSortKey === key ? (detailSortDesc ? ' ▼' : ' ▲') : '';
        let html = `<div class="finder-detail-header">
            <div class="fd-col fd-col-name" data-sort="name">이름${arrow('name')}</div>
            <div class="fd-col fd-col-mtime" data-sort="mtime">수정한 날짜${arrow('mtime')}</div>
            <div class="fd-col fd-col-type" data-sort="type">유형${arrow('type')}</div>
            <div class="fd-col fd-col-size" data-sort="size">크기${arrow('size')}</div>
        </div>`;
        finderGrid.innerHTML = html;
        items.forEach((item, idx) => {
            const row = document.createElement('div');
            row.className = 'finder-item finder-detail-row';
            row.dataset.path = item.path;
            row.dataset.type = item.type;
            row.dataset.name = item.name;
            row.dataset.index = idx;
            const icon = item.type === 'directory' ? '📁' : getFileIcon(item.name);
            row.innerHTML = `
                <div class="fd-col fd-col-name"><span class="fd-icon">${icon}</span><span class="fd-name">${escHtml(item.name)}</span></div>
                <div class="fd-col fd-col-mtime">${formatMtime(item.mtime)}</div>
                <div class="fd-col fd-col-type">${fileTypeLabel(item)}</div>
                <div class="fd-col fd-col-size">${item.type === 'directory' ? '' : formatFileSize(item.size)}</div>
            `;
            attachItemEvents(row, item, idx);
            finderGrid.appendChild(row);
        });
        // Header sort click
        finderGrid.querySelectorAll('.finder-detail-header .fd-col[data-sort]').forEach(col => {
            col.addEventListener('click', () => {
                const key = col.dataset.sort;
                if (detailSortKey === key) detailSortDesc = !detailSortDesc;
                else { detailSortKey = key; detailSortDesc = false; }
                loadFinderGrid(currentFinderPath);
            });
        });
    }

    async function loadFinderGrid(dirPath) {
        currentFinderPath = dirPath || '';
        selectedPaths.clear();
        updateSelectionBar();
        try {
            const items = await fetchTreeLevel(dirPath);
            currentItems = items;
            sortItems(items);
            if (items.length === 0) {
                finderEmpty.style.display = '';
                finderGrid.style.display = 'none';
                finderGrid.innerHTML = '';
            } else {
                finderEmpty.style.display = 'none';
                finderGrid.style.display = '';
                if (viewMode === 'detail') renderDetailView(items);
                else renderGridView(items);
            }
            updateFinderBreadcrumb(dirPath);
        } catch (err) {
            finderGrid.innerHTML = `<div style="padding:20px;color:var(--text-secondary);">Error: ${escHtml(err.message)}</div>`;
        }
    }

    // View toggle button
    (function setupViewToggle() {
        const btn = document.getElementById('viewToggleBtn');
        if (!btn) return;
        const iconGrid = document.getElementById('viewToggleIconGrid');
        const iconList = document.getElementById('viewToggleIconList');
        function updateIcon() {
            // Show the icon that represents what you'll SWITCH TO
            if (viewMode === 'grid') { iconGrid.style.display = 'none'; iconList.style.display = ''; btn.title = '자세히 보기'; }
            else { iconGrid.style.display = ''; iconList.style.display = 'none'; btn.title = '큰 아이콘 보기'; }
        }
        updateIcon();
        btn.addEventListener('click', () => {
            viewMode = viewMode === 'grid' ? 'detail' : 'grid';
            localStorage.setItem('finderViewMode', viewMode);
            updateIcon();
            loadFinderGrid(currentFinderPath);
        });
    })();

    function updateFinderBreadcrumb(dirPath) {
        const parts = dirPath ? dirPath.split('/') : [];
        let html = '<span data-path="">Workspace</span>';
        let accumulated = '';
        parts.forEach((p) => {
            accumulated += (accumulated ? '/' : '') + p;
            html += `<span class="sep">/</span><span data-path="${escHtml(accumulated)}">${escHtml(p)}</span>`;
        });
        finderBreadcrumb.innerHTML = html;
        finderBreadcrumb.querySelectorAll('span[data-path]').forEach((el) => {
            el.addEventListener('click', () => loadFinderGrid(el.dataset.path));
        });
    }

    // === Rubber-band drag selection (Windows-style) ===
    (function setupRubberBand() {
        let rbEl = null;     // the visual rectangle element
        let rbActive = false;
        let rbStartX = 0, rbStartY = 0;
        const finder = document.getElementById('finder');

        // Create rubber-band element once
        rbEl = document.createElement('div');
        rbEl.className = 'rubber-band';
        rbEl.style.display = 'none';
        finder.style.position = 'relative';
        finder.appendChild(rbEl);

        function rectsIntersect(a, b) {
            return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        }

        finder.addEventListener('mousedown', (e) => {
            // Only start on empty space (not on items, buttons, inputs)
            if (e.target.closest('.finder-item, .finder-btn, .finder-toolbar, .selection-bar, label, input, button')) return;
            if (e.button !== 0) return;
            rbActive = true;
            _rubberBandUsed = false;
            const finderRect = finder.getBoundingClientRect();
            rbStartX = e.clientX - finderRect.left + finder.scrollLeft;
            rbStartY = e.clientY - finderRect.top + finder.scrollTop;
            rbEl.style.left = rbStartX + 'px';
            rbEl.style.top = rbStartY + 'px';
            rbEl.style.width = '0';
            rbEl.style.height = '0';
            rbEl.style.display = 'block';
            // Clear previous selection unless Ctrl held
            if (!e.ctrlKey && !e.metaKey) clearSelection();
        });

        document.addEventListener('mousemove', (e) => {
            if (!rbActive) return;
            const finderRect = finder.getBoundingClientRect();
            const curX = e.clientX - finderRect.left + finder.scrollLeft;
            const curY = e.clientY - finderRect.top + finder.scrollTop;
            const x = Math.min(rbStartX, curX);
            const y = Math.min(rbStartY, curY);
            const w = Math.abs(curX - rbStartX);
            const h = Math.abs(curY - rbStartY);
            rbEl.style.left = x + 'px';
            rbEl.style.top = y + 'px';
            rbEl.style.width = w + 'px';
            rbEl.style.height = h + 'px';

            // Hit-test items against rubber-band rect
            if (w > 4 || h > 4) {
                _rubberBandUsed = true;
                const bandRect = { left: x + finderRect.left - finder.scrollLeft, top: y + finderRect.top - finder.scrollTop, right: x + w + finderRect.left - finder.scrollLeft, bottom: y + h + finderRect.top - finder.scrollTop };
                selectedPaths.clear();
                finderGrid.querySelectorAll('.finder-item').forEach((el) => {
                    const itemRect = el.getBoundingClientRect();
                    if (rectsIntersect(bandRect, itemRect)) {
                        selectedPaths.add(el.dataset.path);
                        el.classList.add('selected');
                    } else {
                        el.classList.remove('selected');
                    }
                });
                updateSelectionBar();
            }
        });

        document.addEventListener('mouseup', () => {
            if (!rbActive) return;
            rbActive = false;
            rbEl.style.display = 'none';
            // Reset flag after a tick so click handler can check it
            if (_rubberBandUsed) setTimeout(() => { _rubberBandUsed = false; }, 10);
        });
    })();

    // === Context Menu ===
    let contextEl = null;
    function showContextMenu(x, y, item) {
        hideContextMenu();
        contextEl = document.createElement('div');
        contextEl.className = 'finder-context';
        contextEl.style.left = x + 'px';
        contextEl.style.top = y + 'px';
        const actions = [];
        actions.push({ label: '✏️ Rename', action: () => renameItem(item) });
        actions.push({ label: '📥 Download', action: () => downloadFile(item.path) });
        actions.push({ label: '🗑 Delete', cls: 'danger', action: () => deleteItem(item) });
        actions.forEach(({ label, cls, action }) => {
            const el = document.createElement('div');
            el.className = 'finder-context-item' + (cls ? ' ' + cls : '');
            el.textContent = label;
            el.addEventListener('click', () => { hideContextMenu(); action(); });
            contextEl.appendChild(el);
        });
        document.body.appendChild(contextEl);
        // Adjust if off-screen
        const rect = contextEl.getBoundingClientRect();
        if (rect.right > window.innerWidth) contextEl.style.left = (x - rect.width) + 'px';
        if (rect.bottom > window.innerHeight) contextEl.style.top = (y - rect.height) + 'px';
    }
    function showMultiContextMenu(x, y) {
        hideContextMenu();
        contextEl = document.createElement('div');
        contextEl.className = 'finder-context';
        contextEl.style.left = x + 'px';
        contextEl.style.top = y + 'px';
        const count = selectedPaths.size;
        const actions = [
            { label: `📥 Download ${count} items`, action: () => downloadSelected() },
            { label: `🗑 Delete ${count} items`, cls: 'danger', action: () => deleteSelected() },
        ];
        actions.forEach(({ label, cls, action }) => {
            const el = document.createElement('div');
            el.className = 'finder-context-item' + (cls ? ' ' + cls : '');
            el.textContent = label;
            el.addEventListener('click', () => { hideContextMenu(); action(); });
            contextEl.appendChild(el);
        });
        document.body.appendChild(contextEl);
        const rect = contextEl.getBoundingClientRect();
        if (rect.right > window.innerWidth) contextEl.style.left = (x - rect.width) + 'px';
        if (rect.bottom > window.innerHeight) contextEl.style.top = (y - rect.height) + 'px';
    }

    function hideContextMenu() {
        if (contextEl) { contextEl.remove(); contextEl = null; }
    }
    document.addEventListener('click', hideContextMenu);

    initFileOpsButtons({
        getCurrentDir: () => currentFinderPath,
        onChanged: refreshWorkspaceViews,
    });

    // === Upload ===
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB per chunk
    const CHUNKED_THRESHOLD = 50 * 1024 * 1024; // Use chunked for files > 50 MB
    const CHUNK_MAX_RETRIES = 3;
    const MAX_UPLOAD_FILES = 100000; // Max files per upload to prevent browser crash

    // Progress bar container (appended to finder)
    const uploadProgressBar = document.createElement('div');
    uploadProgressBar.className = 'upload-progress-bar';
    uploadProgressBar.innerHTML = `
        <div class="upload-progress-info">
            <span class="upload-progress-label"></span>
            <span class="upload-progress-pct"></span>
            <button class="upload-cancel-btn" title="Cancel">&times;</button>
        </div>
        <div class="upload-progress-track"><div class="upload-progress-fill"></div></div>
    `;
    uploadProgressBar.style.display = 'none';
    finder.appendChild(uploadProgressBar);

    const uploadLabel = uploadProgressBar.querySelector('.upload-progress-label');
    const uploadPct = uploadProgressBar.querySelector('.upload-progress-pct');
    const uploadFill = uploadProgressBar.querySelector('.upload-progress-fill');
    const uploadCancelBtn = uploadProgressBar.querySelector('.upload-cancel-btn');

    let uploadAborted = false;
    let activeUploadId = null; // current chunked upload_id for cancel cleanup
    let activeXhr = null; // current XHR for non-chunked cancel

    uploadCancelBtn.addEventListener('click', () => {
        uploadAborted = true;
        if (activeXhr) { activeXhr.abort(); activeXhr = null; }
    });

    function showUploadProgress(label, pct) {
        uploadProgressBar.style.display = '';
        uploadLabel.textContent = label;
        uploadPct.textContent = pct < 100 ? `${pct}%` : 'Done';
        uploadFill.style.width = pct + '%';
        uploadCancelBtn.style.display = pct < 100 ? '' : 'none';
    }
    function hideUploadProgress() {
        uploadProgressBar.style.display = 'none';
        uploadFill.style.width = '0%';
        activeUploadId = null;
        activeXhr = null;
    }

    finderUpload.addEventListener('change', async () => {
        const files = finderUpload.files;
        if (!files.length) return;
        const wrapped = Array.from(files).map((f) => ({ file: f, relativePath: f.name }));
        await uploadFiles(wrapped, currentFinderPath);
        finderUpload.value = '';
    });

    async function sendChunkWithRetry(url, opts, retries) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await fetch(url, opts);
                if (res.ok) return res;
                if (attempt === retries) throw new Error(await res.text());
            } catch (err) {
                if (attempt === retries) throw err;
            }
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }

    async function uploadFileChunked(file, filename, targetDir, onProgress) {
        // 1. Init
        const initRes = await fetch(`${BASE}/api/upload-chunk`, mutFetchOpts({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
            body: JSON.stringify({ filename, dir: targetDir || '', size: file.size }),
        }));
        if (!initRes.ok) throw new Error(await initRes.text());
        const { upload_id } = await initRes.json();
        activeUploadId = upload_id;

        // 2. Send chunks with retry
        let offset = 0;
        while (offset < file.size) {
            if (uploadAborted) {
                // Cancel on server — delete incomplete file
                await fetch(`${BASE}/api/upload-chunk?id=${encodeURIComponent(upload_id)}&cancel=1`, mutFetchOpts({ method: 'DELETE' })).catch(() => {});
                throw new Error('Upload cancelled');
            }
            const end = Math.min(offset + CHUNK_SIZE, file.size);
            const chunk = file.slice(offset, end);
            await sendChunkWithRetry(
                `${BASE}/api/upload-chunk?id=${encodeURIComponent(upload_id)}`,
                mutFetchOpts({ method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-XSRFToken': XSRF }, body: chunk }),
                CHUNK_MAX_RETRIES,
            );
            offset = end;
            if (onProgress) onProgress(offset);
        }

        // 3. Finalize
        activeUploadId = null;
        const finRes = await fetch(`${BASE}/api/upload-chunk?id=${encodeURIComponent(upload_id)}`, mutFetchOpts({ method: 'DELETE' }));
        if (!finRes.ok) throw new Error(await finRes.text());
    }

    async function uploadFiles(filesWithPaths, targetDir) {
        // Separate empty-folder placeholders (file === null) from real files
        const emptyDirs = filesWithPaths.filter(f => f.file === null);
        const realFiles = filesWithPaths.filter(f => f.file !== null);

        const totalSize = realFiles.reduce((s, f) => s + f.file.size, 0);
        const useChunked = realFiles.some(f => f.file.size > CHUNKED_THRESHOLD);
        uploadAborted = false;

        try {
            // Create empty directories first
            for (const { relativePath } of emptyDirs) {
                const dirPath = (targetDir ? targetDir + '/' : '') + relativePath.replace(/\/$/, '');
                await fetch(`${BASE}/api/mkdir`, mutFetchOpts({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: dirPath }),
                })).catch(() => {}); // ignore if already exists
            }

            if (realFiles.length === 0) {
                // Only empty dirs, nothing else to upload
                loadFinderGrid(currentFinderPath);
                loadTree();
                return;
            }

            if (useChunked) {
                let bytesSent = 0;
                for (const { file, relativePath } of realFiles) {
                    if (uploadAborted) throw new Error('Upload cancelled');
                    const fname = relativePath || file.name;
                    if (file.size > CHUNKED_THRESHOLD) {
                        const baseBytes = bytesSent;
                        await uploadFileChunked(file, fname, targetDir, (fileOffset) => {
                            const current = baseBytes + fileOffset;
                            const pct = Math.round((current / totalSize) * 100);
                            showUploadProgress(`${fname} (${formatSize(current)} / ${formatSize(totalSize)})`, pct);
                        });
                        bytesSent += file.size;
                    } else {
                        const form = new FormData();
                        form.append('file', file, fname);
                        const res = await fetch(`${BASE}/api/upload?dir=${encodeURIComponent(targetDir || '')}`, mutFetchOpts({ method: 'POST', body: form }));
                        if (!res.ok) throw new Error(await res.text());
                        bytesSent += file.size;
                    }
                    showUploadProgress(`${fname} (${formatSize(bytesSent)} / ${formatSize(totalSize)})`, Math.round((bytesSent / totalSize) * 100));
                }
            } else {
                // Small files: single request with XHR for progress
                const form = new FormData();
                for (const { file, relativePath } of realFiles) {
                    form.append('file', file, relativePath || file.name);
                }
                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    activeXhr = xhr;
                    xhr.open('POST', `${BASE}/api/upload?dir=${encodeURIComponent(targetDir || '')}`);
                    xhr.withCredentials = true;
                    xhr.setRequestHeader('X-XSRFToken', XSRF);
                    xhr.setRequestHeader('ngrok-skip-browser-warning', '1');
                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable) {
                            const pct = Math.round((e.loaded / e.total) * 100);
                            showUploadProgress(`${formatSize(e.loaded)} / ${formatSize(e.total)}`, pct);
                        }
                    };
                    xhr.onload = () => { activeXhr = null; xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText)); };
                    xhr.onerror = () => { activeXhr = null; reject(new Error('Network error')); };
                    xhr.onabort = () => { activeXhr = null; reject(new Error('Upload cancelled')); };
                    xhr.send(form);
                });
            }
            loadFinderGrid(currentFinderPath);
            loadTree();
        } catch (err) {
            if (err.message !== 'Upload cancelled') alert('Upload failed: ' + err.message);
        } finally {
            setTimeout(hideUploadProgress, 1500);
        }
    }

    // Recursively collect files from a DataTransferItem entry
    function readEntryRecursive(entry, counter) {
        return new Promise((resolve) => {
            if (counter.count > MAX_UPLOAD_FILES) return resolve([]);
            if (entry.isFile) {
                counter.count++;
                entry.file(
                    (f) => resolve([{ file: f, relativePath: entry.fullPath.replace(/^\//, '') }]),
                    () => resolve([]) // error: skip unreadable file
                );
            } else if (entry.isDirectory) {
                const dirPath = entry.fullPath.replace(/^\//, '');
                const reader = entry.createReader();
                const allEntries = [];
                const readBatch = () => {
                    reader.readEntries(
                        async (entries) => {
                            if (entries.length === 0) {
                                const results = [];
                                for (const e of allEntries) {
                                    if (counter.count > MAX_UPLOAD_FILES) break;
                                    results.push(...await readEntryRecursive(e, counter));
                                }
                                // If empty folder, add placeholder so server creates the directory
                                if (results.length === 0) {
                                    results.push({ file: null, relativePath: dirPath + '/' });
                                }
                                resolve(results);
                            } else {
                                allEntries.push(...entries);
                                readBatch(); // readEntries may return partial results
                            }
                        },
                        () => resolve([]) // error: skip unreadable directory
                    );
                };
                readBatch();
            } else {
                resolve([]);
            }
        });
    }

    async function collectDroppedFiles(dataTransfer) {
        const items = dataTransfer.items;
        if (items && items.length && items[0].webkitGetAsEntry) {
            const allFiles = [];
            const counter = { count: 0 };
            for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry();
                if (entry) allFiles.push(...await readEntryRecursive(entry, counter));
                if (counter.count > MAX_UPLOAD_FILES) {
                    alert(`파일 수가 ${counter.count.toLocaleString()}개를 초과했습니다.\n브라우저 업로드는 최대 ${MAX_UPLOAD_FILES.toLocaleString()}개까지 지원됩니다.\n대용량 폴더는 서버에서 직접 복사해주세요.`);
                    return [];
                }
            }
            return allFiles;
        }
        // Fallback: plain files (no folder support)
        const result = [];
        for (const f of dataTransfer.files) {
            result.push({ file: f, relativePath: f.name });
        }
        return result;
    }

    // === Prevent browser from opening dropped files ===
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    // === Drag & Drop upload on finder area ===
    finder.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); finder.classList.add('dragover'); });
    finder.addEventListener('dragleave', (e) => {
        // Only remove highlight when leaving the finder element itself
        if (!finder.contains(e.relatedTarget)) finder.classList.remove('dragover');
    });
    finder.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        finder.classList.remove('dragover');
        const files = await collectDroppedFiles(e.dataTransfer);
        if (files.length) {
            await uploadFiles(files, currentFinderPath);
        }
    });

    // === Preview Overlay ===
    const EDITABLE_EXTS = ['.md', '.markdown', '.csv', '.txt', '.py', '.js', '.json', '.yaml', '.yml', '.html', '.css', '.sh', '.toml', '.cfg', '.ini', '.xml', '.timetable', '.datetable'];
    const MD_EXTS = ['.md', '.markdown'];
    const TIMETABLE_EXTS = ['.timetable'];
    const DATETABLE_EXTS = ['.datetable'];
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
        if (previewViewToggle) {
            previewViewToggle.style.display = 'none';
            previewViewToggle.textContent = 'Text';
            previewViewToggle.title = 'Switch to plain text view';
        }
        _mdViewMode = 'rendered';
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
        _mdViewMode = 'rendered';
        previewColorRules.style.display = 'none';
        setSaveStatus('idle');
        updateHash(currentFinderPath);
        const folderName = currentFinderPath.split('/').pop() || 'Workspace';
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
        if (TIMETABLE_EXTS.includes(ext)) return JSON.stringify(_timetableData, null, 2);
        if (DATETABLE_EXTS.includes(ext)) return JSON.stringify(_datetableData, null, 2);
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

    // ========================================================================
    // Notion-style markdown editor
    // ========================================================================
    // The rendered .markdown-body IS the editor. Clicking anywhere puts the
    // caret there. Typing "works", including Notion's markdown shortcuts
    // (`#`, `##`, `-`, `1.`, `>`, `---`, `[]` + space) which transform the
    // current block in place. Auto-save reads the DOM through the HTML →
    // Markdown serializer in editor/markdown.js — there is no mode switch
    // and no rendered ↔ source asymmetry.
    //
    // DOM ↔ Markdown conversion moved to editor/markdown.js:
    //   BLOCK_TAGS, closestBlock, placeCaretAtStart, mediaTagToHtml,
    //   inlineToMd, listToMd, tableToMd, blockToMd, domToMarkdown.

    // ---- Markdown shortcut detection ----
    // Patterns are matched against the block's leading text content when the
    // user types a space. If any matches, we transform the block in place
    // and strip the shortcut characters.
    function detectBlockShortcut(text) {
        if (text === '# ') return { tag: 'h1' };
        if (text === '## ') return { tag: 'h2' };
        if (text === '### ') return { tag: 'h3' };
        if (text === '#### ') return { tag: 'h4' };
        if (text === '##### ') return { tag: 'h5' };
        if (text === '###### ') return { tag: 'h6' };
        if (text === '- ' || text === '* ' || text === '+ ') return { list: 'ul' };
        if (/^\d+\. $/.test(text)) return { list: 'ol' };
        if (text === '> ' || text === '" ') return { tag: 'blockquote' };
        if (text === '[] ' || text === '[ ] ') return { list: 'ul', task: false };
        if (text === '[x] ' || text === '[X] ') return { list: 'ul', task: true };
        if (text === '``` ') return { tag: 'pre' };
        return null;
    }

    /** Try to convert the current block based on its leading shortcut chars.
     *  Returns true if a transformation happened. */
    function tryMarkdownShortcut(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount || !sel.isCollapsed) return false;
        const range = sel.getRangeAt(0);
        const block = closestBlock(range.startContainer, editor);
        if (!block) return false;
        // Only trigger for top-level paragraphs that the user just typed into
        if (block.tagName.toLowerCase() !== 'p') return false;
        const text = block.textContent;
        const match = detectBlockShortcut(text);
        if (!match) return false;

        if (match.list) {
            const list = document.createElement(match.list);
            const li = document.createElement('li');
            if (match.task !== undefined) {
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                if (match.task) cb.checked = true;
                li.appendChild(cb);
                li.appendChild(document.createTextNode(' '));
            }
            list.appendChild(li);
            block.replaceWith(list);
            placeCaretAtStart(li);
        } else if (match.tag === 'pre') {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            pre.appendChild(code);
            block.replaceWith(pre);
            placeCaretAtStart(code);
        } else if (match.tag === 'blockquote') {
            const bq = document.createElement('blockquote');
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            bq.appendChild(p);
            block.replaceWith(bq);
            placeCaretAtStart(p);
        } else {
            const el = document.createElement(match.tag);
            block.replaceWith(el);
            placeCaretAtStart(el);
        }
        return true;
    }

    /** Handle `---` + Enter → horizontal rule, and Enter inside a heading
     *  creates a fresh paragraph below rather than a duplicate heading. */
    function tryEnterBehavior(editor, e) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return false;
        const range = sel.getRangeAt(0);
        const block = closestBlock(range.startContainer, editor);
        if (!block) return false;

        // --- → <hr>
        if (block.tagName.toLowerCase() === 'p' && block.textContent === '---') {
            e.preventDefault();
            const hr = document.createElement('hr');
            const after = document.createElement('p');
            after.appendChild(document.createElement('br'));
            block.replaceWith(hr);
            hr.after(after);
            placeCaretAtStart(after);
            return true;
        }

        // Enter inside a heading → new <p> below
        const tag = block.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
            // If caret is at the end of the heading, create a p instead of splitting
            const atEnd = range.endOffset === (range.endContainer.nodeType === Node.TEXT_NODE
                ? range.endContainer.length
                : range.endContainer.childNodes.length);
            if (atEnd) {
                e.preventDefault();
                const p = document.createElement('p');
                p.appendChild(document.createElement('br'));
                block.after(p);
                placeCaretAtStart(p);
                return true;
            }
        }
        return false;
    }

    function wrapSelectionWithTag(tagName) {
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const el = document.createElement(tagName);
        try {
            el.appendChild(range.extractContents());
            range.insertNode(el);
            sel.removeAllRanges();
            const r = document.createRange();
            r.selectNodeContents(el);
            sel.addRange(r);
        } catch { /* range crossed block boundaries — ignore */ }
    }

    // ========================================================================
    // Notion parity Phase 1
    //   • Slash menu (/)  — caret-based block picker
    //   • Selection toolbar — floating format bar on text selection
    //   • Block menu (Cmd+/, right-click) — caret/mouse-driven block ops
    //   • Link input (Cmd+K) — floating URL input
    //   • Cmd+Option+0..8 — quick block type shortcuts
    //   • Cmd+U / Cmd+Shift+S — underline / strikethrough
    //   • Cmd+D / Cmd+Shift+↑↓ — duplicate / move block
    // ------------------------------------------------------------------------
    // Everything is single-contenteditable friendly: no per-block hover
    // overlays, no drag handles. All floating UI is positioned from caret or
    // selection rects and tracks no block DOM structure.
    // ========================================================================

    /** Turn the given top-level block element into a different block type.
     *  Preserves content where possible. */
    function convertBlockTo(editor, block, kind) {
        if (!block) return;
        const inner = block.innerHTML || '<br>';
        const text = block.textContent || '';

        // Special kinds that aren't single-tag swaps
        if (kind === 'ul' || kind === 'ol') {
            const list = document.createElement(kind);
            const li = document.createElement('li');
            li.innerHTML = inner === '<br>' ? '' : inner;
            list.appendChild(li);
            block.replaceWith(list);
            placeCaretAtStart(li);
            return list;
        }
        if (kind === 'todo') {
            const list = document.createElement('ul');
            const li = document.createElement('li');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            li.appendChild(cb);
            li.appendChild(document.createTextNode(' '));
            const span = document.createElement('span');
            span.innerHTML = inner === '<br>' ? '' : inner;
            li.appendChild(span);
            list.appendChild(li);
            block.replaceWith(list);
            placeCaretAtStart(span);
            return list;
        }
        if (kind === 'toggle') {
            const details = document.createElement('details');
            details.open = true;
            const summary = document.createElement('summary');
            summary.innerHTML = inner === '<br>' ? '' : inner;
            details.appendChild(summary);
            const body = document.createElement('p');
            body.appendChild(document.createElement('br'));
            details.appendChild(body);
            block.replaceWith(details);
            placeCaretAtStart(summary);
            return details;
        }
        if (kind === 'callout') {
            const callout = document.createElement('div');
            callout.className = 'callout';
            callout.setAttribute('data-icon', '💡');
            const icon = document.createElement('span');
            icon.className = 'callout-icon';
            icon.setAttribute('contenteditable', 'false');
            icon.textContent = '💡';
            const content = document.createElement('div');
            content.className = 'callout-content';
            const inside = document.createElement('p');
            inside.innerHTML = inner === '<br>' ? '<br>' : inner;
            content.appendChild(inside);
            callout.appendChild(icon);
            callout.appendChild(content);
            block.replaceWith(callout);
            placeCaretAtStart(inside);
            return callout;
        }
        if (kind === 'pre') {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = text;
            pre.appendChild(code);
            block.replaceWith(pre);
            placeCaretAtStart(code);
            return pre;
        }
        if (kind === 'hr') {
            const hr = document.createElement('hr');
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            block.replaceWith(hr);
            hr.after(p);
            placeCaretAtStart(p);
            return hr;
        }
        if (kind === 'math') {
            // Special: ask for LaTeX and render via KaTeX
            insertMathBlock(editor);
            return null;
        }
        if (kind === 'toc') {
            insertTOC(editor);
            return null;
        }
        // Simple tag swap (p, h1-h6, blockquote)
        const el = document.createElement(kind);
        el.innerHTML = inner === '<br>' ? '<br>' : inner;
        block.replaceWith(el);
        placeCaretAtStart(el);
        return el;
    }

    /** Convert the block the caret is currently inside. */
    function convertCurrentBlock(editor, kind) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
        if (block) convertBlockTo(editor, block, kind);
    }

    // ==================== Inline live markdown ====================
    // When the user types the CLOSING marker of an inline markdown pattern,
    // detect the pair and swap it for the corresponding element. Runs only
    // after non-IME single-character insertions so Korean composition isn't
    // disrupted.
    //
    // Triggers (after typing the last character):
    //   **text**   →  <strong>text</strong>
    //   *text*     →  <em>text</em>          (not inside **...**)
    //   `text`     →  <code>text</code>
    //   ~~text~~   →  <del>text</del>

    function isInsideTag(node, tagName) {
        let n = node;
        while (n) {
            if (n.nodeType === Node.ELEMENT_NODE && n.tagName && n.tagName.toLowerCase() === tagName) return true;
            n = n.parentNode;
        }
        return false;
    }

    /** Attempt inline markdown conversion at the current caret.
     *  Returns true if something was converted (and scheduleSave should fire). */
    function tryInlineMarkdown(editor, lastChar) {
        if (!editor) return false;
        if (lastChar !== '*' && lastChar !== '`' && lastChar !== '~') return false;
        const sel = window.getSelection();
        if (!sel.rangeCount || !sel.isCollapsed) return false;
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) return false;
        // Don't trigger inside code/pre
        if (isInsideTag(node, 'code') || isInsideTag(node, 'pre')) return false;

        const text = node.textContent;
        const offset = range.startOffset;
        if (offset === 0) return false;

        // Patterns, ordered so longer-marker variants win
        const patterns = [
            { close: '**', open: '**', tag: 'strong' },
            { close: '~~', open: '~~', tag: 'del' },
            { close: '`',  open: '`',  tag: 'code' },
            { close: '*',  open: '*',  tag: 'em' },
        ];

        for (const p of patterns) {
            const cl = p.close.length;
            if (offset < cl + 1) continue; // need at least "X*"
            if (text.slice(offset - cl, offset) !== p.close) continue;
            // Find the opening marker BEFORE the text body
            const searchEnd = offset - cl;
            let openIdx = -1;
            // Scan backwards
            for (let i = searchEnd - 1; i >= 0; i--) {
                if (text.slice(i, i + p.open.length) === p.open) {
                    // Reject degenerate case: adjacent markers (e.g. "****")
                    if (i + p.open.length >= searchEnd) continue;
                    // Reject `*` matching middle of `**` (em inside strong)
                    if (p.tag === 'em') {
                        if (text[i - 1] === '*' || text[i + 1] === '*') continue;
                        if (text[searchEnd - 1] === '*' || text[searchEnd] === '*') continue;
                    }
                    openIdx = i;
                    break;
                }
            }
            if (openIdx === -1) continue;
            const bodyStart = openIdx + p.open.length;
            const bodyEnd = searchEnd;
            const body = text.slice(bodyStart, bodyEnd);
            if (!body) continue;
            if (body.startsWith(' ') || body.endsWith(' ')) continue; // whitespace edges kill the match

            // Build: before + <tag>body</tag> + after
            const before = text.slice(0, openIdx);
            const after = text.slice(offset);
            const parent = node.parentNode;

            const el = document.createElement(p.tag);
            el.textContent = body;
            const afterNode = document.createTextNode(after);

            // Replace the original text node with: before text + el + after text
            if (before) {
                node.textContent = before;
                parent.insertBefore(el, node.nextSibling);
                parent.insertBefore(afterNode, el.nextSibling);
            } else {
                parent.insertBefore(el, node);
                parent.insertBefore(afterNode, el.nextSibling);
                parent.removeChild(node);
            }

            // Place caret after the new element (inside `afterNode` at 0)
            const r = document.createRange();
            r.setStart(afterNode, 0);
            r.collapse(true);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
            return true;
        }
        return false;
    }

    // ==================== Nested list Tab / Shift+Tab ====================
    /** Indent the current <li> by moving it into a sublist of the
     *  previous <li>. Returns true if handled. */
    function tryIndentListItem(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return false;
        let node = sel.getRangeAt(0).startContainer;
        while (node && node !== editor) {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') break;
            node = node.parentNode;
        }
        if (!node || node === editor || node.tagName !== 'LI') return false;
        const li = node;
        const prev = li.previousElementSibling;
        if (!prev || prev.tagName !== 'LI') return false; // nothing to nest under
        const parentList = li.parentNode; // <ul> or <ol>
        const listTag = parentList.tagName.toLowerCase();
        // Existing sublist on previous li? append to it. Otherwise create new.
        let sublist = Array.from(prev.children).find(c => c.tagName === 'UL' || c.tagName === 'OL');
        if (!sublist) {
            sublist = document.createElement(listTag);
            prev.appendChild(sublist);
        }
        sublist.appendChild(li);
        placeCaretAtStart(li);
        return true;
    }

    /** Outdent the current <li> — if it's inside a sublist, move it out
     *  after the parent <li>. Returns true if handled. */
    function tryOutdentListItem(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return false;
        let node = sel.getRangeAt(0).startContainer;
        while (node && node !== editor) {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') break;
            node = node.parentNode;
        }
        if (!node || node === editor || node.tagName !== 'LI') return false;
        const li = node;
        const parentList = li.parentNode;
        if (!parentList || (parentList.tagName !== 'UL' && parentList.tagName !== 'OL')) return false;
        const grandLi = parentList.parentNode;
        // Only outdent if we're actually in a nested list
        if (!grandLi || grandLi.tagName !== 'LI') return false;
        const grandList = grandLi.parentNode;
        if (!grandList || (grandList.tagName !== 'UL' && grandList.tagName !== 'OL')) return false;
        // Move any later siblings into a fresh sublist that travels with the li
        const laterSiblings = [];
        let sibling = li.nextElementSibling;
        while (sibling) {
            const next = sibling.nextElementSibling;
            laterSiblings.push(sibling);
            sibling = next;
        }
        if (laterSiblings.length) {
            const newSub = document.createElement(parentList.tagName);
            laterSiblings.forEach(s => newSub.appendChild(s));
            li.appendChild(newSub);
        }
        parentList.removeChild(li);
        // If the original parentList is now empty, remove it
        if (!parentList.firstElementChild) parentList.remove();
        // Insert li after grandLi
        grandLi.parentNode.insertBefore(li, grandLi.nextSibling);
        placeCaretAtStart(li);
        return true;
    }

    // ==================== Text / background colors ====================
    // Notion's 10-color palette. text + highlight variants each map to a
    // CSS custom property set on the editor root (defined in style.css).
    const NOTION_COLORS = [
        { key: 'default', label: '기본',    textVar: '',                 bgVar: '' },
        { key: 'gray',    label: '회색',    textVar: '#9b9a97',          bgVar: '#f1f1ef' },
        { key: 'brown',   label: '갈색',    textVar: '#64473a',          bgVar: '#f4eeee' },
        { key: 'orange',  label: '주황',    textVar: '#d9730d',          bgVar: '#faebdd' },
        { key: 'yellow',  label: '노랑',    textVar: '#dfab01',          bgVar: '#fbf3db' },
        { key: 'green',   label: '초록',    textVar: '#0f7b6c',          bgVar: '#ddedea' },
        { key: 'blue',    label: '파랑',    textVar: '#0b6e99',          bgVar: '#ddebf1' },
        { key: 'purple',  label: '보라',    textVar: '#6940a5',          bgVar: '#eae4f2' },
        { key: 'pink',    label: '분홍',    textVar: '#ad1a72',          bgVar: '#f4dfeb' },
        { key: 'red',     label: '빨강',    textVar: '#e03e3e',          bgVar: '#fbe4e4' },
    ];
    let _lastColor = null; // { mode: 'text'|'bg', color: colorKey }

    function applyColorToSelection(mode, colorKey) {
        const def = NOTION_COLORS.find(c => c.key === colorKey);
        if (!def) return;
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);

        // Default = strip color — unwrap any style spans in the range
        if (colorKey === 'default') {
            // execCommand removeFormat clears inline styles
            document.execCommand('removeFormat');
            scheduleSave();
            return;
        }

        const el = document.createElement('span');
        if (mode === 'text') el.style.color = def.textVar;
        else el.style.backgroundColor = def.bgVar;
        try {
            el.appendChild(range.extractContents());
            range.insertNode(el);
            // Re-select the content
            const s = window.getSelection();
            s.removeAllRanges();
            const r = document.createRange();
            r.selectNodeContents(el);
            s.addRange(r);
            _lastColor = { mode, colorKey };
            scheduleSave();
        } catch { /* range across blocks — skip */ }
    }

    function applyLastColor() {
        if (!_lastColor) return;
        applyColorToSelection(_lastColor.mode, _lastColor.colorKey);
    }

    let _colorPickerEl = null;
    function closeColorPicker() {
        if (_colorPickerEl) _colorPickerEl.remove();
        _colorPickerEl = null;
    }
    function openColorPicker(anchorRect) {
        closeColorPicker();
        const el = document.createElement('div');
        el.className = 'color-picker';
        el.style.position = 'fixed';
        el.style.left = Math.round(anchorRect.left) + 'px';
        el.style.top = Math.round(anchorRect.bottom + 6) + 'px';
        el.style.zIndex = '5300';
        const section = (title, mode) => {
            let html = `<div class="cp-section-title">${title}</div><div class="cp-swatches">`;
            NOTION_COLORS.forEach(c => {
                const style = mode === 'text'
                    ? (c.textVar ? `color:${c.textVar};` : '')
                    : (c.bgVar ? `background:${c.bgVar};` : '');
                html += `<div class="cp-swatch" data-mode="${mode}" data-key="${c.key}" title="${c.label}">
                    <span class="cp-sample" style="${style}">A</span>
                    <span class="cp-label">${c.label}</span>
                </div>`;
            });
            html += '</div>';
            return html;
        };
        el.innerHTML = section('글자 색', 'text') + section('배경 색', 'bg');
        document.body.appendChild(el);
        // Clamp to viewport
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) {
            el.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
        }
        if (r.bottom > window.innerHeight - 8) {
            el.style.top = Math.round(anchorRect.top - r.height - 6) + 'px';
        }
        el.addEventListener('mousedown', (e) => {
            const sw = e.target.closest('.cp-swatch');
            if (!sw) return;
            e.preventDefault();
            applyColorToSelection(sw.dataset.mode, sw.dataset.key);
            closeColorPicker();
        });
        _colorPickerEl = el;
        const outside = (e) => {
            if (!el.contains(e.target)) {
                closeColorPicker();
                document.removeEventListener('mousedown', outside, true);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    }

    // ==================== Cmd+A two-stage select ====================
    /** First press selects the current block's contents. Second press
     *  (when the current block is already fully selected) extends to the
     *  whole editor. */
    function twoStageSelectAll(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        const block = closestBlock(range.startContainer, editor);
        if (!block) {
            // Fall back to full editor
            const r = document.createRange();
            r.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(r);
            return;
        }
        // Is the current block already fully selected?
        const fullBlockRange = document.createRange();
        fullBlockRange.selectNodeContents(block);
        const already =
            range.startContainer === fullBlockRange.startContainer &&
            range.startOffset === fullBlockRange.startOffset &&
            range.endContainer === fullBlockRange.endContainer &&
            range.endOffset === fullBlockRange.endOffset;
        // Loose check: compare string lengths (selection spans block contents)
        const selectedText = sel.toString();
        const blockText = block.textContent;
        const looseFull = selectedText.length > 0 && selectedText.length >= blockText.length;
        if (already || looseFull) {
            // Second press → select all blocks
            const r = document.createRange();
            r.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(r);
            return;
        }
        // First press → select just the block
        sel.removeAllRanges();
        sel.addRange(fullBlockRange);
    }

    // ==================== Block selection mode (Esc) ====================
    // Pressing Esc puts the editor in "block selected" state — the current
    // block gets a visual outline, arrow keys navigate between blocks,
    // Backspace/Delete removes the selected block, Enter returns to text
    // editing, another Esc blurs.
    let _selectedBlock = null;

    function clearBlockSelection() {
        if (_selectedBlock) {
            _selectedBlock.classList.remove('block-selected');
            _selectedBlock = null;
        }
    }
    function selectBlock(block) {
        clearBlockSelection();
        if (!block) return;
        block.classList.add('block-selected');
        _selectedBlock = block;
        // Collapse text selection so only the block outline is visible
        const sel = window.getSelection();
        sel.removeAllRanges();
    }
    function enterBlockSelectionFromCaret(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return false;
        const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
        if (!block) return false;
        selectBlock(block);
        return true;
    }
    /** Handle keydown while in block selection mode. Returns true if
     *  consumed. */
    function handleBlockSelectionKey(editor, e) {
        if (!_selectedBlock) return false;
        if (e.key === 'Escape') {
            e.preventDefault();
            clearBlockSelection();
            editor.blur();
            return true;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            const next = _selectedBlock.nextElementSibling;
            if (next && BLOCK_TAGS.has(next.tagName.toLowerCase())) selectBlock(next);
            return true;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const prev = _selectedBlock.previousElementSibling;
            if (prev && BLOCK_TAGS.has(prev.tagName.toLowerCase())) selectBlock(prev);
            return true;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            const target = _selectedBlock;
            const next = target.nextElementSibling || target.previousElementSibling;
            target.remove();
            clearBlockSelection();
            if (next) placeCaretAtStart(next);
            scheduleSave();
            return true;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const target = _selectedBlock;
            clearBlockSelection();
            placeCaretAtStart(target);
            return true;
        }
        // Any other key → exit block selection and let the key reach the editor
        clearBlockSelection();
        return false;
    }

    // ==================== Smart paste ====================
    const URL_RE = /^https?:\/\/[^\s]+$/i;

    /** Handle paste event. Returns true if we handled it (so the default
     *  paste should be suppressed). */
    function handlePaste(editor, e) {
        const cd = e.clipboardData || window.clipboardData;
        if (!cd) return false;
        const html = cd.getData('text/html');
        const text = cd.getData('text/plain');

        // 1. Pasting a bare URL into a non-collapsed selection → link it
        if (text && URL_RE.test(text.trim())) {
            const sel = window.getSelection();
            if (sel.rangeCount && !sel.isCollapsed) {
                e.preventDefault();
                document.execCommand('createLink', false, text.trim());
                return true;
            }
            // Collapsed caret + URL → insert a clickable link
            if (sel.rangeCount && sel.isCollapsed) {
                e.preventDefault();
                const a = document.createElement('a');
                a.href = text.trim();
                a.textContent = text.trim();
                sel.getRangeAt(0).insertNode(a);
                // Move caret after the link
                const r = document.createRange();
                r.setStartAfter(a);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
                return true;
            }
        }
        // 2. Rich HTML → sanitize and insert. We keep structural tags but
        //    strip all inline styles and dangerous attributes.
        if (html) {
            e.preventDefault();
            const sanitized = sanitizePastedHtml(html);
            if (sanitized) {
                document.execCommand('insertHTML', false, sanitized);
                return true;
            }
        }
        // 3. Fall through to plain text insert (existing behavior)
        if (text) {
            e.preventDefault();
            document.execCommand('insertText', false, text);
            return true;
        }
        return false;
    }

    // sanitizePastedHtml moved to editor/markdown.js

    // ==================== Code block language picker ====================
    // Shown contextually: absolutely-positioned above the current <pre>
    // code block whenever the caret is inside it. Single overlay tracked
    // in module state so it always corresponds to exactly one block.
    const CODE_LANGS = [
        { id: '',           label: 'Plain' },
        { id: 'javascript', label: 'JavaScript' },
        { id: 'typescript', label: 'TypeScript' },
        { id: 'python',     label: 'Python' },
        { id: 'bash',       label: 'Bash' },
        { id: 'json',       label: 'JSON' },
        { id: 'yaml',       label: 'YAML' },
        { id: 'html',       label: 'HTML' },
        { id: 'css',        label: 'CSS' },
        { id: 'sql',        label: 'SQL' },
        { id: 'markdown',   label: 'Markdown' },
        { id: 'rust',       label: 'Rust' },
        { id: 'go',         label: 'Go' },
        { id: 'java',       label: 'Java' },
        { id: 'c',          label: 'C' },
        { id: 'cpp',        label: 'C++' },
        { id: 'ruby',       label: 'Ruby' },
        { id: 'php',        label: 'PHP' },
        { id: 'swift',      label: 'Swift' },
        { id: 'kotlin',     label: 'Kotlin' },
    ];
    let _codeLangEl = null;
    let _codeLangBlock = null;

    function closeCodeLangPicker() {
        if (_codeLangEl) _codeLangEl.remove();
        _codeLangEl = null;
        _codeLangBlock = null;
    }
    function currentCodeBlockLang(pre) {
        const code = pre && pre.querySelector('code');
        if (!code) return '';
        const m = code.className.match(/language-([\w-]+)/);
        return m ? m[1] : '';
    }
    function setCodeBlockLang(pre, lang) {
        const code = pre.querySelector('code');
        if (!code) return;
        // Strip existing language + hljs classes
        code.className = code.className
            .split(/\s+/)
            .filter(c => !c.startsWith('language-') && !c.startsWith('hljs'))
            .join(' ')
            .trim();
        if (lang) code.classList.add('language-' + lang);
        if (typeof hljs !== 'undefined' && lang) {
            try { hljs.highlightElement(code); } catch {}
        }
        scheduleSave();
    }
    function updateCodeLangIndicator(editor) {
        // Show the indicator iff the caret is inside a <pre> inside the
        // editor. Position it at the top-right of the block.
        const sel = window.getSelection();
        if (!sel.rangeCount) { closeCodeLangPicker(); return; }
        let n = sel.getRangeAt(0).startContainer;
        let pre = null;
        while (n && n !== editor) {
            if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'PRE') { pre = n; break; }
            n = n.parentNode;
        }
        if (!pre) { closeCodeLangPicker(); return; }
        if (_codeLangBlock === pre && _codeLangEl) {
            // Already showing for this block — just reposition in case the
            // page scrolled.
            const rect = pre.getBoundingClientRect();
            _codeLangEl.style.top = Math.round(rect.top + 6) + 'px';
            _codeLangEl.style.left = Math.round(rect.right - _codeLangEl.offsetWidth - 10) + 'px';
            return;
        }
        closeCodeLangPicker();
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'code-lang-indicator';
        const lang = currentCodeBlockLang(pre);
        el.textContent = (CODE_LANGS.find(l => l.id === lang)?.label || lang || 'Plain') + ' ▾';
        el.style.position = 'fixed';
        el.style.zIndex = '4900';
        document.body.appendChild(el);
        const rect = pre.getBoundingClientRect();
        el.style.top = Math.round(rect.top + 6) + 'px';
        el.style.left = Math.round(rect.right - el.offsetWidth - 10) + 'px';
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openCodeLangDropdown(pre, el.getBoundingClientRect());
        });
        _codeLangEl = el;
        _codeLangBlock = pre;
    }
    function openCodeLangDropdown(pre, anchorRect) {
        const dd = document.createElement('div');
        dd.className = 'code-lang-dropdown';
        dd.style.position = 'fixed';
        dd.style.zIndex = '5400';
        const cur = currentCodeBlockLang(pre);
        dd.innerHTML = CODE_LANGS.map(l => `
            <div class="cl-item ${l.id === cur ? 'active' : ''}" data-id="${l.id}">${escHtml(l.label)}</div>
        `).join('');
        document.body.appendChild(dd);
        dd.style.left = Math.round(anchorRect.right - dd.offsetWidth) + 'px';
        dd.style.top = Math.round(anchorRect.bottom + 4) + 'px';
        const r = dd.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) {
            dd.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
        }
        if (r.right > window.innerWidth - 8) {
            dd.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
        }
        dd.addEventListener('mousedown', (e) => {
            const item = e.target.closest('.cl-item');
            if (!item) return;
            e.preventDefault();
            setCodeBlockLang(pre, item.dataset.id);
            dd.remove();
            // Refresh indicator label
            closeCodeLangPicker();
        });
        const outside = (e) => {
            if (!dd.contains(e.target)) {
                dd.remove();
                document.removeEventListener('mousedown', outside, true);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    }

    // ==================== Math block (KaTeX, lazy-loaded) ====================
    let _katexLoading = null;
    function loadKatex() {
        if (typeof window.katex !== 'undefined') return Promise.resolve();
        if (_katexLoading) return _katexLoading;
        _katexLoading = new Promise((resolve) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
            document.head.appendChild(css);
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
            script.onload = () => resolve();
            script.onerror = () => resolve(); // fail gracefully
            document.head.appendChild(script);
        });
        return _katexLoading;
    }

    async function insertMathBlock(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
        if (!block) return;
        const tex = prompt('LaTeX 수식을 입력하세요:', '');
        if (tex == null) return;
        await loadKatex();
        const wrap = document.createElement('div');
        wrap.className = 'math-block';
        wrap.setAttribute('contenteditable', 'false');
        wrap.setAttribute('data-tex', tex);
        renderMathBlock(wrap);
        wrap.addEventListener('click', () => {
            const next = prompt('LaTeX 수식 수정:', wrap.getAttribute('data-tex') || '');
            if (next != null) {
                wrap.setAttribute('data-tex', next);
                renderMathBlock(wrap);
                scheduleSave();
            }
        });
        block.replaceWith(wrap);
        // Ensure a paragraph after so the user can keep typing
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        wrap.after(p);
        placeCaretAtStart(p);
        scheduleSave();
    }
    function renderMathBlock(wrap) {
        const tex = wrap.getAttribute('data-tex') || '';
        if (typeof window.katex !== 'undefined') {
            try {
                wrap.innerHTML = '';
                window.katex.render(tex, wrap, { throwOnError: false, displayMode: true });
                return;
            } catch {}
        }
        // KaTeX not available — fall back to monospace TeX
        wrap.textContent = '$$ ' + tex + ' $$';
    }
    /** Find unrendered math-block divs and render them (called after
     *  file load so the HTML that came from the save file picks up a
     *  proper KaTeX render). */
    async function rehydrateMathBlocks(editor) {
        const blocks = editor.querySelectorAll('.math-block[data-tex]');
        const inlines = editor.querySelectorAll('.math-inline[data-tex]');
        if (blocks.length === 0 && inlines.length === 0) return;
        await loadKatex();
        blocks.forEach(b => {
            if (!b.getAttribute('contenteditable')) b.setAttribute('contenteditable', 'false');
            renderMathBlock(b);
            b.addEventListener('click', () => {
                const next = prompt('LaTeX 수식 수정:', b.getAttribute('data-tex') || '');
                if (next != null) {
                    b.setAttribute('data-tex', next);
                    renderMathBlock(b);
                    scheduleSave();
                }
            });
        });
        inlines.forEach(sp => {
            if (!sp.getAttribute('contenteditable')) sp.setAttribute('contenteditable', 'false');
            const tex = sp.getAttribute('data-tex') || '';
            try {
                sp.innerHTML = '';
                window.katex.render(tex, sp, { throwOnError: false, displayMode: false });
            } catch { sp.textContent = '$' + tex + '$'; }
        });
    }

    // ==================== Table of Contents ====================
    function insertTOC(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
        if (!block) return;
        const toc = buildTOCElement(editor);
        block.replaceWith(toc);
        // Add a blank paragraph after for further typing
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        toc.after(p);
        placeCaretAtStart(p);
        scheduleSave();
    }
    function buildTOCElement(editor) {
        const wrap = document.createElement('div');
        wrap.className = 'toc-block';
        wrap.setAttribute('contenteditable', 'false');
        const title = document.createElement('div');
        title.className = 'toc-title';
        title.textContent = '목차';
        wrap.appendChild(title);
        const list = document.createElement('ul');
        list.className = 'toc-list';
        const headings = editor.querySelectorAll('h1, h2, h3');
        headings.forEach((h, i) => {
            const id = h.id || ('toc-h-' + i);
            h.id = id;
            const li = document.createElement('li');
            li.className = 'toc-level-' + h.tagName.toLowerCase();
            const a = document.createElement('a');
            a.textContent = h.textContent || '(제목 없음)';
            a.href = '#' + id;
            a.addEventListener('click', (e) => {
                e.preventDefault();
                h.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            li.appendChild(a);
            list.appendChild(li);
        });
        if (headings.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'toc-empty';
            empty.textContent = '제목이 없습니다. H1~H3 헤딩을 추가한 뒤 /toc 를 다시 실행하세요.';
            wrap.appendChild(empty);
        } else {
            wrap.appendChild(list);
        }
        return wrap;
    }
    /** On file load, re-bind click handlers for any TOC blocks that came
     *  from the saved file (since event listeners aren't serialized). */
    function rehydrateTOCBlocks(editor) {
        const blocks = editor.querySelectorAll('.toc-block');
        blocks.forEach(b => {
            if (!b.getAttribute('contenteditable')) b.setAttribute('contenteditable', 'false');
            b.querySelectorAll('a[href^="#"]').forEach(a => {
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    const id = a.getAttribute('href').slice(1);
                    const target = editor.querySelector('#' + CSS.escape(id));
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            });
        });
    }

    // ==================== Auto-link on typing ====================
    // When the user types a space or enter right after a URL, wrap the URL
    // in an <a>. Pattern matches http(s)://, ftp://, www., and bare
    // foo.bar.com style URLs when the whole "word" looks like a hostname.
    const AUTO_URL_RE = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)$/i;

    function tryAutoLink(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount || !sel.isCollapsed) return false;
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) return false;
        // Don't trigger inside a link, code, or pre
        if (isInsideTag(node, 'a') || isInsideTag(node, 'code') || isInsideTag(node, 'pre')) return false;

        const text = node.textContent;
        const offset = range.startOffset;
        // Look at the characters just before the caret (up to the last space)
        const head = text.slice(0, offset);
        const match = head.match(AUTO_URL_RE);
        if (!match) return false;
        const url = match[1];
        // Avoid double-trigger on URLs already ending with punctuation that
        // shouldn't be part of the link (e.g. "see https://x.com.")
        const cleaned = url.replace(/[.,;:!?)\]}'"]+$/, '');
        if (!cleaned) return false;
        const start = head.length - url.length;
        const end = start + cleaned.length;

        // Build: [head-before][link][rest]
        const before = text.slice(0, start);
        const after = text.slice(end);
        const parent = node.parentNode;
        const a = document.createElement('a');
        a.href = cleaned.startsWith('www.') ? 'https://' + cleaned : cleaned;
        a.textContent = cleaned;

        const afterNode = document.createTextNode(after);
        if (before) {
            node.textContent = before;
            parent.insertBefore(a, node.nextSibling);
            parent.insertBefore(afterNode, a.nextSibling);
        } else {
            parent.insertBefore(a, node);
            parent.insertBefore(afterNode, a.nextSibling);
            parent.removeChild(node);
        }
        // Restore caret just after the link (before any trailing punctuation)
        const r = document.createRange();
        r.setStart(afterNode, 0);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return true;
    }

    // ==================== Emoji shortcode ====================
    // Type `:` to open a picker; filter by typing the emoji name.
    // Subset of common emojis — ~150 entries, keyed by :name:
    const EMOJIS = [
        { k: 'smile', c: '😊' }, { k: 'smiley', c: '😃' }, { k: 'laughing', c: '😆' },
        { k: 'grin', c: '😁' }, { k: 'wink', c: '😉' }, { k: 'heart_eyes', c: '😍' },
        { k: 'joy', c: '😂' }, { k: 'rofl', c: '🤣' }, { k: 'thinking', c: '🤔' },
        { k: 'neutral', c: '😐' }, { k: 'expressionless', c: '😑' }, { k: 'sleepy', c: '😪' },
        { k: 'sob', c: '😭' }, { k: 'cry', c: '😢' }, { k: 'angry', c: '😠' },
        { k: 'rage', c: '😡' }, { k: 'scream', c: '😱' }, { k: 'fear', c: '😨' },
        { k: 'sweat', c: '😓' }, { k: 'relieved', c: '😌' }, { k: 'tired', c: '😫' },
        { k: 'yawning', c: '🥱' }, { k: 'sunglasses', c: '😎' }, { k: 'nerd', c: '🤓' },
        { k: 'cool', c: '🆒' }, { k: 'heart', c: '❤️' }, { k: 'heart_red', c: '❤️' },
        { k: 'blue_heart', c: '💙' }, { k: 'green_heart', c: '💚' }, { k: 'yellow_heart', c: '💛' },
        { k: 'purple_heart', c: '💜' }, { k: 'orange_heart', c: '🧡' }, { k: 'black_heart', c: '🖤' },
        { k: 'sparkling_heart', c: '💖' }, { k: 'heartbeat', c: '💓' }, { k: 'broken_heart', c: '💔' },
        { k: 'thumbs_up', c: '👍' }, { k: '+1', c: '👍' }, { k: 'thumbs_down', c: '👎' },
        { k: '-1', c: '👎' }, { k: 'ok_hand', c: '👌' }, { k: 'clap', c: '👏' },
        { k: 'wave', c: '👋' }, { k: 'pray', c: '🙏' }, { k: 'muscle', c: '💪' },
        { k: 'fire', c: '🔥' }, { k: 'star', c: '⭐' }, { k: 'sparkles', c: '✨' },
        { k: 'zap', c: '⚡' }, { k: 'sun', c: '☀️' }, { k: 'cloud', c: '☁️' },
        { k: 'rain', c: '🌧️' }, { k: 'snowflake', c: '❄️' }, { k: 'rainbow', c: '🌈' },
        { k: 'moon', c: '🌙' }, { k: 'earth', c: '🌍' }, { k: 'rocket', c: '🚀' },
        { k: 'airplane', c: '✈️' }, { k: 'car', c: '🚗' }, { k: 'bike', c: '🚴' },
        { k: 'walk', c: '🚶' }, { k: 'run', c: '🏃' }, { k: 'house', c: '🏠' },
        { k: 'office', c: '🏢' }, { k: 'school', c: '🏫' }, { k: 'hospital', c: '🏥' },
        { k: 'bank', c: '🏦' }, { k: 'shop', c: '🏪' }, { k: 'phone', c: '📞' },
        { k: 'iphone', c: '📱' }, { k: 'computer', c: '💻' }, { k: 'desktop', c: '🖥️' },
        { k: 'keyboard', c: '⌨️' }, { k: 'mouse', c: '🖱️' }, { k: 'printer', c: '🖨️' },
        { k: 'camera', c: '📷' }, { k: 'video_camera', c: '📹' }, { k: 'tv', c: '📺' },
        { k: 'book', c: '📖' }, { k: 'books', c: '📚' }, { k: 'notebook', c: '📓' },
        { k: 'pencil', c: '✏️' }, { k: 'pen', c: '🖊️' }, { k: 'memo', c: '📝' },
        { k: 'page', c: '📄' }, { k: 'clipboard', c: '📋' }, { k: 'folder', c: '📁' },
        { k: 'file', c: '📃' }, { k: 'mailbox', c: '📬' }, { k: 'email', c: '📧' },
        { k: 'envelope', c: '✉️' }, { k: 'package', c: '📦' }, { k: 'lock', c: '🔒' },
        { k: 'unlock', c: '🔓' }, { k: 'key', c: '🔑' }, { k: 'bell', c: '🔔' },
        { k: 'mute', c: '🔕' }, { k: 'speaker', c: '🔊' }, { k: 'headphones', c: '🎧' },
        { k: 'microphone', c: '🎤' }, { k: 'music', c: '🎵' }, { k: 'guitar', c: '🎸' },
        { k: 'piano', c: '🎹' }, { k: 'drum', c: '🥁' }, { k: 'art', c: '🎨' },
        { k: 'clapper', c: '🎬' }, { k: 'game', c: '🎮' }, { k: 'dart', c: '🎯' },
        { k: 'trophy', c: '🏆' }, { k: 'medal', c: '🏅' }, { k: 'gold', c: '🥇' },
        { k: 'silver', c: '🥈' }, { k: 'bronze', c: '🥉' }, { k: 'soccer', c: '⚽' },
        { k: 'basketball', c: '🏀' }, { k: 'baseball', c: '⚾' }, { k: 'tennis', c: '🎾' },
        { k: 'coffee', c: '☕' }, { k: 'tea', c: '🍵' }, { k: 'beer', c: '🍺' },
        { k: 'wine', c: '🍷' }, { k: 'cocktail', c: '🍸' }, { k: 'pizza', c: '🍕' },
        { k: 'burger', c: '🍔' }, { k: 'fries', c: '🍟' }, { k: 'hotdog', c: '🌭' },
        { k: 'sushi', c: '🍣' }, { k: 'rice', c: '🍚' }, { k: 'ramen', c: '🍜' },
        { k: 'bread', c: '🍞' }, { k: 'cake', c: '🎂' }, { k: 'cookie', c: '🍪' },
        { k: 'apple', c: '🍎' }, { k: 'banana', c: '🍌' }, { k: 'grapes', c: '🍇' },
        { k: 'orange', c: '🍊' }, { k: 'strawberry', c: '🍓' }, { k: 'watermelon', c: '🍉' },
        { k: 'dog', c: '🐶' }, { k: 'cat', c: '🐱' }, { k: 'mouse_animal', c: '🐭' },
        { k: 'bear', c: '🐻' }, { k: 'panda', c: '🐼' }, { k: 'koala', c: '🐨' },
        { k: 'lion', c: '🦁' }, { k: 'tiger', c: '🐯' }, { k: 'cow', c: '🐮' },
        { k: 'pig', c: '🐷' }, { k: 'horse', c: '🐴' }, { k: 'fish', c: '🐟' },
        { k: 'check', c: '✅' }, { k: 'cross', c: '❌' }, { k: 'warning', c: '⚠️' },
        { k: 'info', c: 'ℹ️' }, { k: 'question', c: '❓' }, { k: 'exclamation', c: '❗' },
        { k: 'bulb', c: '💡' }, { k: 'hundred', c: '💯' }, { k: 'eyes', c: '👀' },
        { k: 'tada', c: '🎉' }, { k: 'gift', c: '🎁' }, { k: 'balloon', c: '🎈' },
    ];

    let _emojiState = null; // { editor, block, anchorOffset, el, filter, index }

    function openEmojiPicker(editor) {
        closeEmojiPicker();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'emoji-picker';
        el.style.position = 'fixed';
        el.style.left = Math.round(rect.left) + 'px';
        el.style.top = Math.round(rect.bottom + 6) + 'px';
        el.style.zIndex = '5000';
        document.body.appendChild(el);
        _emojiState = { editor, el, filter: '', index: 0 };
        renderEmojiPicker();
        const r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) {
            el.style.top = Math.round(rect.top - r.height - 6) + 'px';
        }
    }
    function closeEmojiPicker() {
        if (_emojiState && _emojiState.el) _emojiState.el.remove();
        _emojiState = null;
    }
    function emojiFiltered() {
        if (!_emojiState) return [];
        const f = _emojiState.filter.toLowerCase();
        if (!f) return EMOJIS.slice(0, 20);
        return EMOJIS.filter(e => e.k.includes(f)).slice(0, 30);
    }
    function renderEmojiPicker() {
        if (!_emojiState) return;
        const items = emojiFiltered();
        if (_emojiState.index >= items.length) _emojiState.index = 0;
        _emojiState.el.innerHTML = items.length === 0
            ? '<div class="ep-empty">일치하는 이모지 없음</div>'
            : `<div class="ep-header">이모지${_emojiState.filter ? ' :' + escHtml(_emojiState.filter) : ''}</div>` +
              items.map((e, i) => `
                <div class="ep-item ${i === _emojiState.index ? 'active' : ''}" data-char="${escHtml(e.c)}">
                    <span class="ep-char">${e.c}</span>
                    <span class="ep-label">:${escHtml(e.k)}:</span>
                </div>
              `).join('');
        _emojiState.el.querySelectorAll('.ep-item').forEach((el, i) => {
            el.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                _emojiState.index = i;
                commitEmojiPicker();
            });
            el.addEventListener('mouseenter', () => {
                _emojiState.index = i;
                _emojiState.el.querySelectorAll('.ep-item').forEach(x => x.classList.remove('active'));
                el.classList.add('active');
            });
        });
    }
    function commitEmojiPicker() {
        if (!_emojiState) return;
        const items = emojiFiltered();
        const item = items[_emojiState.index];
        if (!item) { closeEmojiPicker(); return; }
        // Strip ":filter" from the block and insert the emoji
        const filter = _emojiState.filter;
        stripColonQueryFromCaret(filter);
        closeEmojiPicker();
        document.execCommand('insertText', false, item.c);
        scheduleSave();
    }
    function stripColonQueryFromCaret(filter) {
        // Delete the `:` + filter text that's immediately before the caret
        const toDelete = filter.length + 1;
        for (let i = 0; i < toDelete; i++) {
            document.execCommand('delete');
        }
    }
    function handleEmojiPickerKey(e) {
        if (!_emojiState) return false;
        if (e.key === 'Escape') { e.preventDefault(); closeEmojiPicker(); return true; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const items = emojiFiltered();
            _emojiState.index = (_emojiState.index + 1) % Math.max(1, items.length);
            renderEmojiPicker();
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const items = emojiFiltered();
            _emojiState.index = (_emojiState.index - 1 + items.length) % Math.max(1, items.length);
            renderEmojiPicker();
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            commitEmojiPicker();
            return true;
        }
        return false;
    }
    function updateEmojiPickerFilter(editor) {
        if (!_emojiState) return;
        const sel = window.getSelection();
        if (!sel.rangeCount) { closeEmojiPicker(); return; }
        const node = sel.getRangeAt(0).startContainer;
        if (node.nodeType !== Node.TEXT_NODE) { closeEmojiPicker(); return; }
        const head = node.textContent.slice(0, sel.getRangeAt(0).startOffset);
        const colonIdx = head.lastIndexOf(':');
        if (colonIdx === -1) { closeEmojiPicker(); return; }
        const after = head.slice(colonIdx + 1);
        if (after.includes(' ') || after.includes(':')) { closeEmojiPicker(); return; }
        if (after.length > 20) { closeEmojiPicker(); return; }
        _emojiState.filter = after;
        _emojiState.index = 0;
        renderEmojiPicker();
    }

    // ==================== @ file reference picker ====================
    // Typing `@` in the markdown editor opens a picker listing files from the
    // same folder as the currently-open file. Selecting one inserts:
    //   • Image: `![name](filename)` — rendered inline via rewriteRelativeMediaUrls.
    //   • Video: `<video src="filename" controls width="100%"></video>`.
    //   • Audio: `<audio src="filename" controls></audio>`.
    //   • Other: `[name](filename)` — a regular markdown link.
    // The path stored in the .md source is the clean relative form (just the
    // filename, since we only list same-folder files); rewriteRelativeMediaUrls
    // resolves it to `/api/file?raw=1` at preview time.

    function mentionCategoryFor(ext) {
        if (IMAGE_EXTS.includes(ext)) return 'image';
        if (VIDEO_EXTS.includes(ext)) return 'video';
        if (AUDIO_EXTS.includes(ext)) return 'audio';
        return 'other';
    }
    function mentionIconFor(cat) {
        if (cat === 'image') return '🖼';
        if (cat === 'video') return '🎬';
        if (cat === 'audio') return '🎵';
        return '📄';
    }
    function mentionInsertFor(cat, nameNoPath) {
        // nameNoPath is the filename only (same folder). Display label for
        // markdown links strips the extension to keep the source tidy.
        const label = nameNoPath.replace(/\.[^.]+$/, '') || nameNoPath;
        if (cat === 'image') return `![${label}](${nameNoPath})`;
        if (cat === 'video') return `<video src="${nameNoPath}" controls width="100%"></video>`;
        if (cat === 'audio') return `<audio src="${nameNoPath}" controls></audio>`;
        return `[${label}](${nameNoPath})`;
    }

    let _mentionState = null;
    async function openMentionPicker(editor) {
        closeMentionPicker();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'mention-picker';
        el.style.position = 'fixed';
        el.style.left = Math.round(rect.left) + 'px';
        el.style.top = Math.round(rect.bottom + 6) + 'px';
        el.style.zIndex = '5000';
        document.body.appendChild(el);
        _mentionState = { editor, el, filter: '', index: 0, files: null, loading: true };
        renderMentionPicker();
        // Load the sibling files in the current folder. Deliberately scoped to
        // the same directory so the picker stays fast and the inserted path
        // stays a clean one-level reference.
        try {
            const dir = currentFileDir();
            const items = await fetchTreeLevel(dir);
            // Skip the current file itself; only show files (not folders).
            const curName = currentFileData && currentFileData.path
                ? currentFileData.path.split('/').pop()
                : '';
            const files = items
                .filter((it) => it.type === 'file' && it.name !== curName)
                .map((it) => {
                    const ext = '.' + (it.name.split('.').pop() || '').toLowerCase();
                    return { name: it.name, ext, category: mentionCategoryFor(ext) };
                });
            // Sort: media first (so the main use case surfaces), then alpha.
            const rank = { image: 0, video: 0, audio: 0, other: 1 };
            files.sort((a, b) => (rank[a.category] - rank[b.category]) || a.name.localeCompare(b.name));
            if (!_mentionState) return; // picker was closed while loading
            _mentionState.files = files;
            _mentionState.loading = false;
            renderMentionPicker();
        } catch (err) {
            if (!_mentionState) return;
            _mentionState.files = [];
            _mentionState.loading = false;
            _mentionState.error = err.message || '로드 실패';
            renderMentionPicker();
        }
        // Re-clamp in case the loaded list grew past the viewport.
        const r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) {
            el.style.top = Math.round(rect.top - r.height - 6) + 'px';
        }
    }
    function closeMentionPicker() {
        if (_mentionState && _mentionState.el) _mentionState.el.remove();
        _mentionState = null;
    }
    function mentionFiltered() {
        if (!_mentionState || !_mentionState.files) return [];
        const f = _mentionState.filter.toLowerCase();
        if (!f) return _mentionState.files;
        return _mentionState.files.filter((it) => it.name.toLowerCase().includes(f));
    }
    function renderMentionPicker() {
        if (!_mentionState) return;
        if (_mentionState.loading) {
            _mentionState.el.innerHTML = '<div class="mp-empty">불러오는 중…</div>';
            return;
        }
        if (_mentionState.error) {
            _mentionState.el.innerHTML = `<div class="mp-empty">오류: ${escHtml(_mentionState.error)}</div>`;
            return;
        }
        const items = mentionFiltered();
        if (_mentionState.index >= items.length) _mentionState.index = 0;
        _mentionState.el.innerHTML = items.length === 0
            ? '<div class="mp-empty">일치하는 파일 없음</div>'
            : `<div class="mp-header">파일 참조${_mentionState.filter ? ' @' + escHtml(_mentionState.filter) : ''}</div>` +
              items.slice(0, 50).map((it, i) => `
                <div class="mp-item ${i === _mentionState.index ? 'active' : ''}" data-k="${escHtml(it.name)}">
                    <span class="mp-icon">${mentionIconFor(it.category)}</span>
                    <span class="mp-label">${escHtml(it.name)}</span>
                    <span class="mp-preview">${escHtml(it.ext.replace(/^\./, ''))}</span>
                </div>
              `).join('');
        _mentionState.el.querySelectorAll('.mp-item').forEach((el, i) => {
            el.addEventListener('pointerdown', (ev) => {
                ev.preventDefault();
                _mentionState.index = i;
                commitMentionPicker();
            });
            el.addEventListener('mouseenter', () => {
                _mentionState.index = i;
                _mentionState.el.querySelectorAll('.mp-item').forEach(x => x.classList.remove('active'));
                el.classList.add('active');
            });
        });
    }
    function commitMentionPicker() {
        if (!_mentionState) return;
        const items = mentionFiltered();
        const item = items[_mentionState.index];
        if (!item) { closeMentionPicker(); return; }
        // Strip the typed "@filter" first so the insertion replaces it.
        const filter = _mentionState.filter;
        const toDelete = filter.length + 1; // include the @
        for (let i = 0; i < toDelete; i++) document.execCommand('delete');
        const editorEl = _mentionState.editor;
        const fileDir = currentFileDir();
        closeMentionPicker();
        const mdSnippet = mentionInsertFor(item.category, item.name);
        if (item.category === 'image') {
            // Markdown image — convert to an <img> node so it renders right
            // now (marked would also produce this but doing it inline lets us
            // pre-apply the API URL, so no flicker).
            const img = document.createElement('img');
            img.setAttribute('alt', item.name.replace(/\.[^.]+$/, ''));
            img.setAttribute('data-src-original', item.name);
            const resolved = resolveRelPath(item.name, fileDir);
            img.setAttribute('src', resolved != null ? apiRawUrl(resolved) : item.name);
            insertNodeAtCaret(img, editorEl);
        } else if (item.category === 'audio' || item.category === 'video') {
            const tag = item.category;
            const media = document.createElement(tag);
            media.setAttribute('controls', '');
            if (tag === 'video') media.setAttribute('width', '100%');
            media.setAttribute('data-src-original', item.name);
            const resolved = resolveRelPath(item.name, fileDir);
            media.setAttribute('src', resolved != null ? apiRawUrl(resolved) : item.name);
            insertNodeAtCaret(media, editorEl);
        } else {
            // Plain file — insert a regular markdown link via execCommand so it
            // slots into whatever text/block the caret is in.
            document.execCommand('insertText', false, mdSnippet);
        }
        scheduleSave();
    }
    /** Insert a DOM node at the current caret and leave the caret just after
     *  it. Used for @-picker media insertions where the node is the payload. */
    function insertNodeAtCaret(node, editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) { editor.appendChild(node); return; }
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(node);
        // Move caret after the inserted node
        range.setStartAfter(node);
        range.setEndAfter(node);
        sel.removeAllRanges();
        sel.addRange(range);
    }
    function handleMentionPickerKey(e) {
        if (!_mentionState) return false;
        if (e.key === 'Escape') { e.preventDefault(); closeMentionPicker(); return true; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const items = mentionFiltered();
            _mentionState.index = (_mentionState.index + 1) % Math.max(1, items.length);
            renderMentionPicker();
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const items = mentionFiltered();
            _mentionState.index = (_mentionState.index - 1 + items.length) % Math.max(1, items.length);
            renderMentionPicker();
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            commitMentionPicker();
            return true;
        }
        return false;
    }
    function updateMentionPickerFilter(editor) {
        if (!_mentionState) return;
        const sel = window.getSelection();
        if (!sel.rangeCount) { closeMentionPicker(); return; }
        const node = sel.getRangeAt(0).startContainer;
        if (node.nodeType !== Node.TEXT_NODE) { closeMentionPicker(); return; }
        const head = node.textContent.slice(0, sel.getRangeAt(0).startOffset);
        const atIdx = head.lastIndexOf('@');
        if (atIdx === -1) { closeMentionPicker(); return; }
        const after = head.slice(atIdx + 1);
        // Allow spaces in filenames — only close on explicit cancel (Escape,
        // another @, or an absurdly long query).
        if (after.includes('@')) { closeMentionPicker(); return; }
        if (after.length > 40) { closeMentionPicker(); return; }
        _mentionState.filter = after;
        _mentionState.index = 0;
        renderMentionPicker();
    }

    // ==================== Inline math ($...$) ====================
    async function tryInlineMath(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount || !sel.isCollapsed) return false;
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) return false;
        if (isInsideTag(node, 'code') || isInsideTag(node, 'pre')) return false;
        const text = node.textContent;
        const offset = range.startOffset;
        // Text must end with the closing `$` just typed
        if (offset === 0 || text[offset - 1] !== '$') return false;
        // Find the opening `$`
        const searchEnd = offset - 1;
        const openIdx = text.lastIndexOf('$', searchEnd - 1);
        if (openIdx === -1) return false;
        // Skip if the inner is empty or surrounds `$$` (display math)
        if (text[openIdx - 1] === '$' || text[openIdx + 1] === '$') return false;
        const tex = text.slice(openIdx + 1, searchEnd);
        if (!tex.trim()) return false;

        await loadKatex();
        const before = text.slice(0, openIdx);
        const after = text.slice(offset);
        const parent = node.parentNode;

        const span = document.createElement('span');
        span.className = 'math-inline';
        span.setAttribute('contenteditable', 'false');
        span.setAttribute('data-tex', tex);
        if (typeof window.katex !== 'undefined') {
            try {
                window.katex.render(tex, span, { throwOnError: false, displayMode: false });
            } catch { span.textContent = '$' + tex + '$'; }
        } else {
            span.textContent = '$' + tex + '$';
        }
        const afterNode = document.createTextNode(after);
        if (before) {
            node.textContent = before;
            parent.insertBefore(span, node.nextSibling);
            parent.insertBefore(afterNode, span.nextSibling);
        } else {
            parent.insertBefore(span, node);
            parent.insertBefore(afterNode, span.nextSibling);
            parent.removeChild(node);
        }
        const r = document.createRange();
        r.setStart(afterNode, 0);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return true;
    }

    // ==================== Callout block ====================
    function insertCallout(editor) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
        if (!block) return;
        const callout = document.createElement('div');
        callout.className = 'callout';
        callout.setAttribute('data-icon', '💡');
        const icon = document.createElement('span');
        icon.className = 'callout-icon';
        icon.setAttribute('contenteditable', 'false');
        icon.textContent = '💡';
        icon.addEventListener('click', (e) => {
            e.preventDefault();
            const next = prompt('아이콘 입력 (이모지 하나):', callout.getAttribute('data-icon') || '💡');
            if (next && next.length <= 4) {
                callout.setAttribute('data-icon', next);
                icon.textContent = next;
                scheduleSave();
            }
        });
        const content = document.createElement('div');
        content.className = 'callout-content';
        content.innerHTML = block.innerHTML || '<p><br></p>';
        callout.appendChild(icon);
        callout.appendChild(content);
        block.replaceWith(callout);
        // Caret into first child of content
        const first = content.firstElementChild || content;
        placeCaretAtStart(first);
    }

    // Block type definitions shared by slash menu, Cmd+Option+N, and block menu
    const NOTION_BLOCKS = [
        { key: 'text',   label: '텍스트',     aliases: ['text', 'p', 'plain', 'para'],           icon: '📝', shortcut: '⌘⌥0', kind: 'p' },
        { key: 'h1',     label: '제목 1',     aliases: ['h1', 'heading1', 'title', '#'],         icon: 'H1', shortcut: '⌘⌥1', kind: 'h1' },
        { key: 'h2',     label: '제목 2',     aliases: ['h2', 'heading2', '##'],                 icon: 'H2', shortcut: '⌘⌥2', kind: 'h2' },
        { key: 'h3',     label: '제목 3',     aliases: ['h3', 'heading3', '###'],                icon: 'H3', shortcut: '⌘⌥3', kind: 'h3' },
        { key: 'todo',   label: '할 일 목록', aliases: ['todo', 'task', 'check', '[]'],          icon: '☑',  shortcut: '⌘⌥4', kind: 'todo' },
        { key: 'ul',     label: '글머리 기호', aliases: ['bullet', 'ul', 'list', 'unordered'],   icon: '•',  shortcut: '⌘⌥5', kind: 'ul' },
        { key: 'ol',     label: '번호 매기기', aliases: ['number', 'ol', 'ordered'],             icon: '1.', shortcut: '⌘⌥6', kind: 'ol' },
        { key: 'toggle', label: '토글',        aliases: ['toggle', 'details', 'collapse'],       icon: '▸',  shortcut: '⌘⌥7', kind: 'toggle' },
        { key: 'callout',label: '콜아웃',      aliases: ['callout', 'note', 'tip', 'info'],      icon: '💡', shortcut: '',    kind: 'callout' },
        { key: 'quote',  label: '인용',        aliases: ['quote', 'blockquote', '"'],            icon: '❝',  shortcut: '',    kind: 'blockquote' },
        { key: 'code',   label: '코드',        aliases: ['code', 'pre', '```'],                  icon: '⟨⟩', shortcut: '⌘⌥8', kind: 'pre' },
        { key: 'math',   label: '수식',        aliases: ['math', 'latex', 'tex', 'equation'],    icon: 'Σ',  shortcut: '',    kind: 'math' },
        { key: 'toc',    label: '목차',        aliases: ['toc', 'contents', 'table'],            icon: '☰',  shortcut: '',    kind: 'toc' },
        { key: 'hr',     label: '구분선',      aliases: ['divider', 'hr', '---'],                icon: '—',  shortcut: '',    kind: 'hr' },
    ];
    // Cmd+Option+0..8 map
    const BLOCK_KEY_SHORTCUTS = {
        '0': 'p', '1': 'h1', '2': 'h2', '3': 'h3',
        '4': 'todo', '5': 'ul', '6': 'ol', '7': 'toggle', '8': 'pre',
    };

    // ==================== Focus mode ====================
    let _focusMode = localStorage.getItem('notionFocusMode') === '1';
    function applyFocusMode(editor) {
        if (!editor) return;
        editor.classList.toggle('focus-mode', _focusMode);
    }
    function toggleFocusMode(editor) {
        _focusMode = !_focusMode;
        localStorage.setItem('notionFocusMode', _focusMode ? '1' : '0');
        applyFocusMode(editor);
    }
    /** Tag the block the caret is currently in so focus mode can dim the rest. */
    function updateFocusedBlock(editor) {
        const sel = window.getSelection();
        editor.querySelectorAll('.has-caret').forEach(b => b.classList.remove('has-caret'));
        if (!sel.rangeCount) return;
        const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
        if (block) block.classList.add('has-caret');
    }

    // ==================== Markdown view mode (rendered ↔ text) ====================
    // 'rendered' = Notion-like editor (default). 'text' = raw markdown source as <pre>.
    // `_mdViewMode` is declared at the top of the IIFE alongside other preview state.

    function setMarkdownViewMode(mode) {
        if (!currentFileData || !MD_EXTS.includes(currentFileData.extension)) return;
        if (mode === _mdViewMode) return;
        if (mode === 'text') {
            // Capture any unsaved edits from the live editor before swapping out.
            const editor = previewBody.querySelector('.notion-editor');
            if (editor) currentFileData.content = domToMarkdown(editor);
            previewBody.innerHTML =
                `<textarea class="edit-textarea md-source-edit" spellcheck="false"></textarea>`;
            const ta = previewBody.querySelector('.md-source-edit');
            ta.value = currentFileData.content || '';
            wireMdSourceTextarea(ta);
            requestAnimationFrame(() => {
                ta.style.height = 'auto';
                ta.style.height = Math.max(ta.scrollHeight, previewBody.clientHeight - 40) + 'px';
                try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
            });
            _mdViewMode = 'text';
            if (previewViewToggle) {
                previewViewToggle.textContent = 'Markdown';
                previewViewToggle.title = 'Switch to rendered Markdown view';
            }
        } else {
            // Coming back from text mode: pull the latest textarea value into
            // currentFileData.content so the re-render uses the freshest edits.
            const ta = previewBody.querySelector('.md-source-edit');
            if (ta) currentFileData.content = ta.value;
            previewBody.innerHTML = `<div class="markdown-body notion-editor">${marked.parse(currentFileData.content)}</div>`;
            if (typeof hljs !== 'undefined') {
                previewBody.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
            }
            const editor = previewBody.querySelector('.notion-editor');
            rewriteRelativeMediaUrls(editor, currentFileDir());
            rehydrateTaskCheckboxes(editor);
            setupNotionEditor(editor);
            rehydrateMathBlocks(editor);
            rehydrateTOCBlocks(editor);
            // Re-baseline the saved content against the round-tripped form so a no-op
            // toggle doesn't dirty the file.
            setSavedBaseline(domToMarkdown(editor));
            _mdViewMode = 'rendered';
            if (previewViewToggle) {
                previewViewToggle.textContent = 'Text';
                previewViewToggle.title = 'Switch to plain text view';
            }
        }
    }

    /** Wire up auto-save / Tab / Ctrl+S behavior on the markdown-source
     *  textarea used by the Text view toggle. Mirrors enterInlineEdit's
     *  textarea, without the one-shot Escape-to-revert (we want the toggle
     *  to persist edits, not throw them away). */
    function wireMdSourceTextarea(ta) {
        ta.addEventListener('input', () => {
            ta.style.height = 'auto';
            ta.style.height = Math.max(ta.scrollHeight, previewBody.clientHeight - 40) + 'px';
            scheduleSave();
        });
        ta.addEventListener('blur', () => { flushSave(); });
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = ta.selectionStart;
                ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(ta.selectionEnd);
                ta.selectionStart = ta.selectionEnd = start + 4;
                scheduleSave();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                flushSave();
            }
        });
    }

    /** Strip marked's default `disabled` attribute on task-list checkboxes
     *  and make them contenteditable-transparent so a tap/click actually
     *  toggles them on both desktop and mobile. See bug note in the change
     *  log — marked v4 hardcodes `<input disabled type="checkbox">` in the
     *  gfm renderer, so without this pass nothing is clickable anywhere. */
    function rehydrateTaskCheckboxes(editor) {
        if (!editor) return;
        editor.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.removeAttribute('disabled');
            // iOS Safari tends to swallow taps on form controls inside a
            // contenteditable host unless the control opts out.
            cb.setAttribute('contenteditable', 'false');
        });
    }

    if (previewViewToggle) {
        previewViewToggle.addEventListener('click', () => {
            setMarkdownViewMode(_mdViewMode === 'rendered' ? 'text' : 'rendered');
        });
    }

    // ==================== Keyboard help modal ====================
    const HELP_SECTIONS = [
        {
            title: '서식 (선택 후)',
            items: [
                ['⌘ B', '굵게'],
                ['⌘ I', '기울임'],
                ['⌘ U', '밑줄'],
                ['⌘ ⇧ S', '취소선'],
                ['⌘ E', '인라인 코드'],
                ['⌘ K', '링크'],
                ['⌘ ⇧ H', '마지막 색상 재적용'],
            ],
        },
        {
            title: '블록 타입 변환',
            items: [
                ['⌘ ⌥ 0', '텍스트'],
                ['⌘ ⌥ 1 / 2 / 3', '제목 1 / 2 / 3'],
                ['⌘ ⌥ 4', '할 일 목록'],
                ['⌘ ⌥ 5', '글머리 목록'],
                ['⌘ ⌥ 6', '번호 목록'],
                ['⌘ ⌥ 7', '토글'],
                ['⌘ ⌥ 8', '코드 블록'],
            ],
        },
        {
            title: '블록 조작',
            items: [
                ['⌘ D', '현재 블록 복제'],
                ['⌘ ⇧ ↑ / ↓', '블록 위/아래로 이동'],
                ['Tab / ⇧ Tab', '리스트 중첩 / 해제'],
                ['Esc', '블록 선택 모드'],
                ['⌘ A', '블록 전체 → 에디터 전체'],
                ['⌘ /', '블록 메뉴'],
                ['우클릭', '블록 메뉴'],
            ],
        },
        {
            title: '인라인 / 타이핑',
            items: [
                ['**굵게**', '굵게 (닫는 `**` 입력 시)'],
                ['*기울임*', '기울임'],
                ['`코드`', '인라인 코드'],
                ['~~취소~~', '취소선'],
                ['$수식$', '인라인 LaTeX'],
                ['URL + space', '자동 링크'],
            ],
        },
        {
            title: '블록 단축키 (줄 시작)',
            items: [
                ['# / ## / ### + space', '제목 1 / 2 / 3'],
                ['- / * / + + space', '글머리 목록'],
                ['1. + space', '번호 목록'],
                ['> / " + space', '인용'],
                ['[] / [x] + space', '할 일'],
                ['``` + space', '코드 블록'],
                ['--- + Enter', '구분선'],
            ],
        },
        {
            title: '피커',
            items: [
                ['/', '블록 삽입 슬래시 메뉴'],
                [':이름:', '이모지 선택'],
                ['@', '폴더 내 파일 참조 (이미지/비디오/오디오 인라인)'],
                ['⌘ S', '즉시 저장'],
                ['⌘ ⇧ F', '포커스 모드 토글'],
            ],
        },
    ];
    function openHelpModal() {
        closeHelpModal();
        helpOverlay.innerHTML = `
            <div class="help-modal" role="dialog">
                <div class="help-header">
                    <h3>키보드 단축키</h3>
                    <button class="help-close" aria-label="닫기">&times;</button>
                </div>
                <div class="help-body">
                    ${HELP_SECTIONS.map(s => `
                        <div class="help-section">
                            <div class="help-section-title">${escHtml(s.title)}</div>
                            <div class="help-items">
                                ${s.items.map(([k, v]) => `
                                    <div class="help-row">
                                        <span class="help-key">${escHtml(k)}</span>
                                        <span class="help-desc">${escHtml(v)}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        helpOverlay.classList.add('active');
        helpOverlay.querySelector('.help-close').addEventListener('click', closeHelpModal);
        helpOverlay.addEventListener('click', (e) => {
            if (e.target === helpOverlay) closeHelpModal();
        });
    }
    function closeHelpModal() {
        helpOverlay.classList.remove('active');
        helpOverlay.innerHTML = '';
    }
    if (previewHelp) previewHelp.addEventListener('click', openHelpModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && helpOverlay.classList.contains('active')) {
            closeHelpModal();
        }
    });

    // ==================== Slash menu ====================
    let _slashState = null; // { editor, block, anchorOffset, el, filter, index }

    function openSlashMenu(editor) {
        closeSlashMenu();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        const block = closestBlock(range.startContainer, editor);
        if (!block) return;
        const rect = range.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'slash-menu';
        el.style.position = 'fixed';
        el.style.left = Math.round(rect.left) + 'px';
        el.style.top = Math.round(rect.bottom + 6) + 'px';
        el.style.zIndex = '5000';
        document.body.appendChild(el);

        _slashState = { editor, block, el, filter: '', index: 0 };
        renderSlashMenu();
        // If the menu overflows the viewport, nudge up
        const r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) {
            el.style.top = Math.round(rect.top - r.height - 6) + 'px';
        }
    }
    function closeSlashMenu() {
        if (_slashState && _slashState.el) _slashState.el.remove();
        _slashState = null;
    }
    function slashMenuFilteredItems() {
        if (!_slashState) return [];
        const f = _slashState.filter.toLowerCase();
        if (!f) return NOTION_BLOCKS;
        return NOTION_BLOCKS.filter(b =>
            b.label.toLowerCase().includes(f) ||
            b.aliases.some(a => a.startsWith(f))
        );
    }
    function renderSlashMenu() {
        if (!_slashState) return;
        const items = slashMenuFilteredItems();
        if (_slashState.index >= items.length) _slashState.index = 0;
        _slashState.el.innerHTML = items.length === 0
            ? '<div class="sm-empty">일치하는 블록 없음</div>'
            : `<div class="sm-header">블록 선택${_slashState.filter ? ' — /' + escHtml(_slashState.filter) : ''}</div>` +
              items.map((b, i) => `
                <div class="sm-item ${i === _slashState.index ? 'active' : ''}" data-key="${b.key}">
                    <span class="sm-icon">${b.icon}</span>
                    <span class="sm-label">${escHtml(b.label)}</span>
                    ${b.shortcut ? `<span class="sm-shortcut">${escHtml(b.shortcut)}</span>` : ''}
                </div>
              `).join('');
        _slashState.el.querySelectorAll('.sm-item').forEach((el, i) => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                _slashState.index = i;
                commitSlashMenu();
            });
            el.addEventListener('mouseenter', () => {
                _slashState.index = i;
                _slashState.el.querySelectorAll('.sm-item').forEach(x => x.classList.remove('active'));
                el.classList.add('active');
            });
        });
    }
    function commitSlashMenu() {
        if (!_slashState) return;
        const items = slashMenuFilteredItems();
        const item = items[_slashState.index];
        if (!item) { closeSlashMenu(); return; }
        const { editor, block } = _slashState;
        // Strip the "/filter" from the block's text before converting
        stripSlashQueryFromBlock(block, _slashState.filter);
        closeSlashMenu();
        convertBlockTo(editor, block, item.kind);
        scheduleSave();
    }
    function stripSlashQueryFromBlock(block, filter) {
        // Remove the "/" plus the filter text at the end of the block's
        // textContent. We walk text nodes from the end to avoid clobbering
        // inline formatting elsewhere in the block.
        const target = '/' + filter;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        let remaining = target.length;
        for (let i = nodes.length - 1; i >= 0 && remaining > 0; i--) {
            const n = nodes[i];
            const len = n.textContent.length;
            if (len >= remaining) {
                n.textContent = n.textContent.slice(0, len - remaining);
                remaining = 0;
            } else {
                n.textContent = '';
                remaining -= len;
            }
        }
    }

    /** Handle keyboard events while the slash menu is open.
     *  Returns true if the event was consumed. */
    function handleSlashMenuKey(e) {
        if (!_slashState) return false;
        if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return true; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const items = slashMenuFilteredItems();
            _slashState.index = (_slashState.index + 1) % Math.max(1, items.length);
            renderSlashMenu();
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const items = slashMenuFilteredItems();
            _slashState.index = (_slashState.index - 1 + items.length) % Math.max(1, items.length);
            renderSlashMenu();
            return true;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            commitSlashMenu();
            return true;
        }
        return false;
    }

    /** After each input event, refresh the slash menu filter (or close
     *  it if the "/" was deleted). */
    function updateSlashMenuFilter(editor) {
        if (!_slashState) return;
        const sel = window.getSelection();
        if (!sel.rangeCount) { closeSlashMenu(); return; }
        const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
        if (block !== _slashState.block) { closeSlashMenu(); return; }
        const text = block.textContent;
        const slashIdx = text.lastIndexOf('/');
        if (slashIdx === -1) { closeSlashMenu(); return; }
        const after = text.slice(slashIdx + 1);
        // Slash must not contain spaces (to let users type "/ foo" literally if
        // they escape out)
        if (after.includes(' ')) { closeSlashMenu(); return; }
        _slashState.filter = after;
        _slashState.index = 0;
        renderSlashMenu();
    }

    // ==================== Selection toolbar ====================
    let _selToolbarEl = null;

    function ensureSelectionToolbar() {
        if (_selToolbarEl) return _selToolbarEl;
        const el = document.createElement('div');
        el.className = 'selection-toolbar';
        el.innerHTML = `
            <button data-cmd="bold" title="Bold (⌘B)"><b>B</b></button>
            <button data-cmd="italic" title="Italic (⌘I)"><i>I</i></button>
            <button data-cmd="underline" title="Underline (⌘U)"><u>U</u></button>
            <button data-cmd="strike" title="Strike (⌘⇧S)"><s>S</s></button>
            <button data-cmd="code" title="Code (⌘E)">&lt;/&gt;</button>
            <button data-cmd="link" title="Link (⌘K)">🔗</button>
            <button data-cmd="color" title="색상 (⌘⇧H)"><span class="st-color">A</span>▾</button>
        `;
        // Use pointerdown so we can preventDefault before the selection is
        // lost. pointerdown covers mouse, touch, and pen with a single path.
        el.addEventListener('pointerdown', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            e.preventDefault();
            if (btn.dataset.cmd === 'color') {
                const rect = btn.getBoundingClientRect();
                openColorPicker(rect);
                return;
            }
            applyInlineFormat(btn.dataset.cmd);
        });
        el.style.position = 'fixed';
        el.style.zIndex = '5000';
        el.style.display = 'none';
        document.body.appendChild(el);
        _selToolbarEl = el;
        return el;
    }
    function hideSelectionToolbar() {
        if (_selToolbarEl) _selToolbarEl.style.display = 'none';
    }
    function updateSelectionToolbar(editor) {
        // On mobile, don't fight the native iOS/Android selection menu.
        // The custom Notion-style toolbar would stack on top of the OS copy/paste
        // UI and race with it. Users keep the standard copy/paste flow; Bold etc.
        // remain desktop-only for now.
        if (isMobile()) { hideSelectionToolbar(); return; }
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) { hideSelectionToolbar(); return; }
        const range = sel.getRangeAt(0);
        if (!editor.contains(range.commonAncestorContainer)) { hideSelectionToolbar(); return; }
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) { hideSelectionToolbar(); return; }
        const tb = ensureSelectionToolbar();
        tb.style.display = 'flex';
        // Measure first so we can center on selection
        const tbRect = tb.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - tbRect.width / 2;
        let top = rect.top - tbRect.height - 8;
        // Keep inside viewport
        if (left < 8) left = 8;
        if (left + tbRect.width > window.innerWidth - 8) {
            left = window.innerWidth - tbRect.width - 8;
        }
        if (top < 8) top = rect.bottom + 8; // flip below selection
        tb.style.left = Math.round(left) + 'px';
        tb.style.top = Math.round(top) + 'px';
    }

    function applyInlineFormat(cmd) {
        switch (cmd) {
            case 'bold':      document.execCommand('bold'); break;
            case 'italic':    document.execCommand('italic'); break;
            case 'underline': document.execCommand('underline'); break;
            case 'strike':    document.execCommand('strikeThrough'); break;
            case 'code':      wrapSelectionWithTag('code'); break;
            case 'link':      openLinkInput(); return; // schedules save itself
        }
        scheduleSave();
    }

    // ==================== Link input (floating) ====================
    function openLinkInput() {
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) return;
        const savedRange = sel.getRangeAt(0).cloneRange();
        const rect = savedRange.getBoundingClientRect();

        // Check if the selection is already inside an existing link
        let existingA = savedRange.startContainer;
        while (existingA && existingA !== document.body) {
            if (existingA.nodeType === Node.ELEMENT_NODE && existingA.tagName === 'A') break;
            existingA = existingA.parentNode;
        }
        const currentUrl = (existingA && existingA.tagName === 'A') ? (existingA.getAttribute('href') || '') : '';

        const overlay = document.createElement('div');
        overlay.className = 'link-input';
        overlay.innerHTML = `
            <input type="url" placeholder="URL을 입력하세요 (예: https://...)" value="${escHtml(currentUrl)}">
            <button type="button" class="li-apply">적용</button>
            ${currentUrl ? '<button type="button" class="li-remove">제거</button>' : ''}
        `;
        overlay.style.position = 'fixed';
        overlay.style.left = Math.round(rect.left) + 'px';
        overlay.style.top = Math.round(rect.bottom + 6) + 'px';
        overlay.style.zIndex = '5100';
        document.body.appendChild(overlay);
        const input = overlay.querySelector('input');
        input.focus();
        input.select();

        const cleanup = () => { overlay.remove(); document.removeEventListener('mousedown', outsideClose, true); };
        const outsideClose = (e) => { if (!overlay.contains(e.target)) cleanup(); };
        const restoreSelection = () => {
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(savedRange);
        };
        const apply = () => {
            const url = input.value.trim();
            if (!url) { cleanup(); return; }
            restoreSelection();
            document.execCommand('createLink', false, url);
            scheduleSave();
            cleanup();
        };
        const remove = () => {
            restoreSelection();
            document.execCommand('unlink');
            scheduleSave();
            cleanup();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); apply(); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
        });
        overlay.querySelector('.li-apply').addEventListener('click', apply);
        const rmBtn = overlay.querySelector('.li-remove');
        if (rmBtn) rmBtn.addEventListener('click', remove);
        // Defer the outside-close listener so the initial click that opened
        // the input doesn't immediately close it.
        setTimeout(() => document.addEventListener('mousedown', outsideClose, true), 0);
    }

    // ==================== Block menu (Cmd+/, right-click) ====================
    let _blockMenuEl = null;

    function closeBlockMenu() {
        if (_blockMenuEl) _blockMenuEl.remove();
        _blockMenuEl = null;
    }

    function openBlockMenu(editor, x, y, targetBlock) {
        closeBlockMenu();
        const el = document.createElement('div');
        el.className = 'block-menu';
        el.style.position = 'fixed';
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.zIndex = '5200';

        const turnIntoItems = NOTION_BLOCKS
            .map(b => `<div class="bm-item" data-act="turn:${b.key}"><span class="bm-icon">${b.icon}</span><span class="bm-label">${escHtml(b.label)}</span>${b.shortcut ? `<span class="bm-shortcut">${escHtml(b.shortcut)}</span>` : ''}</div>`)
            .join('');

        el.innerHTML = `
            <div class="bm-section-title">변환</div>
            ${turnIntoItems}
            <div class="bm-divider"></div>
            <div class="bm-item" data-act="duplicate"><span class="bm-icon">📋</span><span class="bm-label">복제</span><span class="bm-shortcut">⌘D</span></div>
            <div class="bm-item" data-act="move-up"><span class="bm-icon">↑</span><span class="bm-label">위로 이동</span><span class="bm-shortcut">⌘⇧↑</span></div>
            <div class="bm-item" data-act="move-down"><span class="bm-icon">↓</span><span class="bm-label">아래로 이동</span><span class="bm-shortcut">⌘⇧↓</span></div>
            <div class="bm-divider"></div>
            <div class="bm-item danger" data-act="delete"><span class="bm-icon">🗑</span><span class="bm-label">삭제</span></div>
        `;
        document.body.appendChild(el);

        // Clamp to viewport
        const rect = el.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) {
            el.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
        }
        if (rect.bottom > window.innerHeight - 8) {
            el.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
        }

        // pointerdown unifies mouse + touch + pen. On iOS Safari < 13 it may be
        // missing, but the menu is desktop-only anyway now (mobile contextmenu
        // early-returns). Keeping the handler here so any other future entry
        // point still gets a tap response immediately.
        el.addEventListener('pointerdown', (e) => {
            const item = e.target.closest('.bm-item');
            if (!item) return;
            e.preventDefault();
            performBlockAction(editor, targetBlock, item.dataset.act);
            closeBlockMenu();
        });

        // Outside-dismiss: use pointerdown (mouse/touch/pen) AND touchstart as a
        // belt-and-suspenders fallback so the menu never gets stuck — the old
        // code only listened for `mousedown`, which iOS/Android do not reliably
        // synthesize from touches, causing the menu to live forever.
        const outside = (e) => {
            if (!el.contains(e.target)) {
                closeBlockMenu();
                document.removeEventListener('pointerdown', outside, true);
                document.removeEventListener('touchstart', outside, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('pointerdown', outside, true);
            document.addEventListener('touchstart', outside, true);
        }, 0);
    }

    function performBlockAction(editor, block, act) {
        if (!block) return;
        if (act.startsWith('turn:')) {
            const key = act.slice(5);
            const def = NOTION_BLOCKS.find(b => b.key === key);
            if (def) convertBlockTo(editor, block, def.kind);
        } else if (act === 'duplicate') {
            const clone = block.cloneNode(true);
            block.after(clone);
            placeCaretAtStart(clone);
        } else if (act === 'move-up') {
            const prev = block.previousElementSibling;
            if (prev) block.parentNode.insertBefore(block, prev);
        } else if (act === 'move-down') {
            const next = block.nextElementSibling;
            if (next) block.parentNode.insertBefore(next, block);
        } else if (act === 'delete') {
            const next = block.nextElementSibling || block.previousElementSibling;
            block.remove();
            if (next) placeCaretAtStart(next);
        }
        scheduleSave();
    }

    /** Wire a contenteditable markdown editor. */
    function setupNotionEditor(editor) {
        if (!editor) return;
        editor.setAttribute('contenteditable', 'true');
        editor.setAttribute('spellcheck', 'false');

        let _isComposing = false;
        editor.addEventListener('compositionstart', () => { _isComposing = true; });
        editor.addEventListener('compositionend', () => { _isComposing = false; });

        editor.addEventListener('input', (e) => {
            // Opening the slash menu: user just typed "/"
            if (e.inputType === 'insertText' && e.data === '/' && !_slashState) {
                openSlashMenu(editor);
            } else if (_slashState) {
                updateSlashMenuFilter(editor);
            }
            // Emoji picker on ":"
            if (e.inputType === 'insertText' && e.data === ':' && !_emojiState && !_slashState) {
                openEmojiPicker(editor);
            } else if (_emojiState) {
                updateEmojiPickerFilter(editor);
            }
            // Mention picker on "@"
            if (e.inputType === 'insertText' && e.data === '@' && !_mentionState && !_slashState) {
                openMentionPicker(editor);
            } else if (_mentionState) {
                updateMentionPickerFilter(editor);
            }
            // Block-level markdown shortcuts on space
            if (e.inputType === 'insertText' && e.data === ' ') {
                tryMarkdownShortcut(editor);
                // Auto-link: detect URL right before the space
                tryAutoLink(editor);
            }
            // Inline live markdown on a non-IME single character insertion
            if (!_isComposing && e.inputType === 'insertText' && e.data && e.data.length === 1) {
                tryInlineMarkdown(editor, e.data);
                // Inline math on closing $
                if (e.data === '$') tryInlineMath(editor);
            }
            scheduleSave();
        });

        editor.addEventListener('keydown', (e) => {
            // Slash menu / emoji / mention pickers consume keys first
            if (_slashState && handleSlashMenuKey(e)) return;
            if (_emojiState && handleEmojiPickerKey(e)) return;
            if (_mentionState && handleMentionPickerKey(e)) return;
            // Block selection mode intercepts most keys
            if (_selectedBlock && handleBlockSelectionKey(editor, e)) return;

            if (e.key === 'Enter' && !e.shiftKey) {
                if (tryEnterBehavior(editor, e)) return;
            }
            // Tab / Shift+Tab — nested list indent/outdent
            if (e.key === 'Tab') {
                const handled = e.shiftKey
                    ? tryOutdentListItem(editor)
                    : tryIndentListItem(editor);
                if (handled) {
                    e.preventDefault();
                    scheduleSave();
                    return;
                }
            }
            if (e.key === 'Escape') {
                if (_blockMenuEl) { e.preventDefault(); closeBlockMenu(); return; }
                if (_colorPickerEl) { e.preventDefault(); closeColorPicker(); return; }
                // Enter block selection mode instead of blurring
                if (!_selectedBlock && enterBlockSelectionFromCaret(editor)) {
                    e.preventDefault();
                    return;
                }
                e.preventDefault();
                editor.blur();
                flushSave();
                return;
            }

            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;
            const k = e.key.toLowerCase();

            // Cmd+Shift+H — apply last used color
            if (k === 'h' && e.shiftKey) {
                e.preventDefault();
                applyLastColor();
                return;
            }
            // Cmd+Shift+F — toggle focus mode
            if (k === 'f' && e.shiftKey) {
                e.preventDefault();
                toggleFocusMode(editor);
                return;
            }
            // Cmd+A — two-stage select (block → all)
            if (k === 'a' && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                twoStageSelectAll(editor);
                return;
            }

            // Block type shortcuts: Cmd+Option+0..8
            if (e.altKey && BLOCK_KEY_SHORTCUTS[e.key] !== undefined) {
                e.preventDefault();
                convertCurrentBlock(editor, BLOCK_KEY_SHORTCUTS[e.key]);
                scheduleSave();
                return;
            }
            // Block menu: Cmd+/
            if (k === '/') {
                e.preventDefault();
                const sel = window.getSelection();
                if (!sel.rangeCount) return;
                const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
                if (!block) return;
                const rect = sel.getRangeAt(0).getBoundingClientRect();
                openBlockMenu(editor, rect.left, rect.bottom + 6, block);
                return;
            }
            // Cmd+D — duplicate current block
            if (k === 'd' && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                const sel = window.getSelection();
                if (sel.rangeCount) {
                    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
                    if (block) {
                        const clone = block.cloneNode(true);
                        block.after(clone);
                        placeCaretAtStart(clone);
                        scheduleSave();
                    }
                }
                return;
            }
            // Cmd+Shift+Up / Cmd+Shift+Down — move block
            if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                const sel = window.getSelection();
                if (!sel.rangeCount) return;
                const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
                if (!block) return;
                e.preventDefault();
                if (e.key === 'ArrowUp') {
                    const prev = block.previousElementSibling;
                    if (prev) block.parentNode.insertBefore(block, prev);
                } else {
                    const next = block.nextElementSibling;
                    if (next) block.parentNode.insertBefore(next, block);
                }
                placeCaretAtStart(block);
                scheduleSave();
                return;
            }
            // Cmd+K — link
            if (k === 'k') {
                e.preventDefault();
                openLinkInput();
                return;
            }
            // Cmd+U — underline
            if (k === 'u' && !e.shiftKey) {
                e.preventDefault();
                document.execCommand('underline');
                scheduleSave();
                return;
            }
            // Cmd+Shift+S — strikethrough
            if (k === 's' && e.shiftKey) {
                e.preventDefault();
                document.execCommand('strikeThrough');
                scheduleSave();
                return;
            }
            if (k === 'b') {
                e.preventDefault();
                document.execCommand('bold');
                scheduleSave();
            } else if (k === 'i') {
                e.preventDefault();
                document.execCommand('italic');
                scheduleSave();
            } else if (k === 'e') {
                e.preventDefault();
                wrapSelectionWithTag('code');
                scheduleSave();
            } else if (k === 's' && !e.shiftKey) {
                e.preventDefault();
                flushSave();
            }
        });

        // Selection toolbar — track selection changes inside this editor
        const selectionHandler = () => {
            if (document.activeElement !== editor && !editor.contains(document.activeElement)) {
                hideSelectionToolbar();
                closeCodeLangPicker();
                return;
            }
            updateSelectionToolbar(editor);
            updateCodeLangIndicator(editor);
            updateFocusedBlock(editor);
        };
        document.addEventListener('selectionchange', selectionHandler);
        applyFocusMode(editor);
        // Reposition the code language indicator on scroll/resize
        window.addEventListener('scroll', () => updateCodeLangIndicator(editor), true);
        window.addEventListener('resize', () => updateCodeLangIndicator(editor));

        // Right-click → block menu.
        // On mobile, `contextmenu` is synthesized by long-press, which is also
        // how the user invokes the native copy/paste menu. Intercepting it here
        // would open our "변환" menu AND prevent the OS menu — and because the
        // block menu's outside-dismiss relied on mousedown (which touch does
        // not reliably synthesize), it could also get stuck. Desktop keeps the
        // right-click behaviour; mobile gets the native selection UI back.
        editor.addEventListener('contextmenu', (e) => {
            if (isMobile()) return;
            const block = closestBlock(e.target, editor);
            if (!block) return;
            e.preventDefault();
            openBlockMenu(editor, e.clientX, e.clientY, block);
        });

        // Save on blur too (belt and suspenders)
        editor.addEventListener('blur', () => {
            hideSelectionToolbar();
            flushSave();
        });

        // Smart paste: URL → link, rich HTML → sanitized insert, plain
        // text → literal. Replaces the previous "always plain text" behavior.
        editor.addEventListener('paste', (e) => {
            handlePaste(editor, e);
            scheduleSave();
        });

        // Clicking anywhere in the editor clears block selection mode
        editor.addEventListener('mousedown', () => {
            if (_selectedBlock) clearBlockSelection();
        });

        // Task-list checkbox toggling. We intentionally manage the toggle
        // manually instead of trusting the browser's native click → toggle,
        // because iOS Safari inside a contenteditable host often swallows
        // the tap for caret placement, leaving the checkbox in its stale
        // state. Handling it here makes desktop + mobile behave identically
        // and wires the change to scheduleSave so the markdown source stays
        // in sync (`[x]` vs `[ ]`).
        editor.addEventListener('click', (e) => {
            const cb = e.target.closest('input[type="checkbox"]');
            if (!cb || !editor.contains(cb)) return;
            // Only task-list checkboxes live inside <li> — leave any other
            // stray checkbox alone (there shouldn't be any today, but be safe).
            if (!cb.closest('li')) return;
            e.preventDefault();
            cb.checked = !cb.checked;
            // Reflect the new state on the attribute too so serialization and
            // any attribute-based CSS stay consistent.
            if (cb.checked) cb.setAttribute('checked', '');
            else cb.removeAttribute('checked');
            scheduleSave();
        });
    }

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
            _mdViewMode = 'rendered';
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

    // =========================================================================
    // Timetable (.timetable) — Weekly schedule with people columns
    // =========================================================================
    let _timetableData = null;
    const TT_DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
    const TT_DAY_LABELS = ['월','화','수','목','금','토','일'];
    const TT_COLORS = ['#4A90D9','#E67E73','#61BD4F','#F5A623','#8E6EC8','#00BCD4','#FF7043','#AED581','#CE93D8','#FFD54F'];

    function ttTimeSlots() {
        const slots = [];
        for (let h = 9; h <= 22; h++) {
            slots.push(`${String(h).padStart(2,'0')}:00`);
            slots.push(`${String(h).padStart(2,'0')}:30`);
        }
        return slots; // 09:00 ~ 22:30, 28 slots
    }

    function ttSlotIndex(time) { return ttTimeSlots().indexOf(time); }

    function renderTimetable(content, filePath, opts) {
        const initial = opts && opts.initial;
        try { _timetableData = JSON.parse(content); } catch { _timetableData = { people: [], schedule: {} }; }
        if (!_timetableData.people) _timetableData.people = [];
        if (!_timetableData.schedule) _timetableData.schedule = {};
        TT_DAYS.forEach(d => { if (!_timetableData.schedule[d]) _timetableData.schedule[d] = {}; });
        // Any re-render triggered by a mutation in the UI means the data
        // diverged from disk — schedule a save. The first render after
        // loading the file passes { initial: true } to skip this.
        if (!initial && typeof scheduleSave === 'function') scheduleSave();

        const people = _timetableData.people;
        const schedule = _timetableData.schedule;
        const slots = ttTimeSlots();

        // Assign colors
        people.forEach((p, i) => { if (!p.color) p.color = TT_COLORS[i % TT_COLORS.length]; });

        let html = '<div class="tt-container">';
        // Toolbar: manage people
        html += '<div class="tt-toolbar">';
        html += '<span class="tt-toolbar-label">인원:</span>';
        people.forEach((p, i) => {
            html += `<span class="tt-person-tag" style="background:${p.color}" data-idx="${i}">${escHtml(p.name)} <span class="tt-person-remove" data-idx="${i}">&times;</span></span>`;
        });
        html += `<button class="tt-add-person-btn" id="ttAddPerson">+ 추가</button>`;
        html += '</div>';

        // Table
        html += '<div class="tt-scroll"><table class="tt-table">';
        // Header row 1: days
        html += '<thead><tr><th class="tt-day-header tt-corner">시간</th>';
        TT_DAY_LABELS.forEach(d => {
            html += `<th colspan="${people.length || 1}" class="tt-day-header">${d}</th>`;
        });
        html += '</tr>';
        // Header row 2: people per day
        html += '<tr><th class="tt-person-header tt-corner"></th>';
        TT_DAYS.forEach(d => {
            if (people.length === 0) {
                html += '<th class="tt-person-header">-</th>';
            } else {
                people.forEach(p => {
                    html += `<th class="tt-person-header" style="color:${p.color}">${escHtml(p.name)}</th>`;
                });
            }
        });
        html += '</tr></thead>';

        // Body
        html += '<tbody>';
        slots.forEach((slot, si) => {
            html += '<tr>';
            html += `<td class="tt-time-cell">${slot}</td>`;
            TT_DAYS.forEach((day, di) => {
                if (people.length === 0) {
                    html += '<td class="tt-cell tt-empty"></td>';
                } else {
                    people.forEach((p, pi) => {
                        const blocks = schedule[day]?.[p.name] || [];
                        const block = blocks.find(b => {
                            const s = ttSlotIndex(b.start), e = ttSlotIndex(b.end);
                            return si >= s && si < e;
                        });
                        if (block) {
                            const s = ttSlotIndex(block.start);
                            if (si === s) {
                                const span = ttSlotIndex(block.end) - s;
                                html += `<td class="tt-cell tt-block" rowspan="${span}" style="background:${p.color}20;border-left:3px solid ${p.color}" data-day="${day}" data-person="${p.name}" data-start="${block.start}" data-end="${block.end}"><span class="tt-block-label">${escHtml(block.label || '')}</span></td>`;
                            }
                            // Other slots in block: skip (rowspan covers them)
                        } else {
                            // Check if this cell is covered by a rowspan above
                            const covered = blocks.some(b => {
                                const s = ttSlotIndex(b.start), e = ttSlotIndex(b.end);
                                return si > s && si < e;
                            });
                            if (!covered) {
                                html += `<td class="tt-cell" data-day="${day}" data-person="${p.name}" data-slot="${slot}"></td>`;
                            }
                        }
                    });
                }
            });
            html += '</tr>';
        });
        html += '</tbody></table></div></div>';
        previewBody.innerHTML = html;

        // === Event bindings ===
        // Add person
        const addBtn = previewBody.querySelector('#ttAddPerson');
        if (addBtn) addBtn.addEventListener('click', () => {
            const name = prompt('인원 이름을 입력하세요:');
            if (!name || !name.trim()) return;
            const trimmed = name.trim();
            if (people.some(p => p.name === trimmed)) { alert('이미 존재하는 이름입니다.'); return; }
            people.push({ name: trimmed, color: TT_COLORS[people.length % TT_COLORS.length] });
            renderTimetable(JSON.stringify(_timetableData), filePath);
        });

        // Remove person
        previewBody.querySelectorAll('.tt-person-remove').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(el.dataset.idx);
                const pName = people[idx].name;
                if (!confirm(`"${pName}"을(를) 삭제하시겠습니까?`)) return;
                // Remove from schedule
                TT_DAYS.forEach(d => { delete schedule[d]?.[pName]; });
                people.splice(idx, 1);
                renderTimetable(JSON.stringify(_timetableData), filePath);
            });
        });

        // Click empty cell: add block
        previewBody.querySelectorAll('.tt-cell[data-slot]').forEach(td => {
            td.addEventListener('click', () => {
                const day = td.dataset.day, person = td.dataset.person, slot = td.dataset.slot;
                const label = prompt(`${TT_DAY_LABELS[TT_DAYS.indexOf(day)]} ${slot} - ${person}\n일정명을 입력하세요:`);
                if (label === null) return;
                // Ask for end time
                const si = ttSlotIndex(slot);
                const slots2 = ttTimeSlots();
                const endOptions = slots2.slice(si + 1).concat(['23:00']);
                const endTime = prompt(`종료 시간을 입력하세요 (예: ${slots2[Math.min(si+2, slots2.length-1)] || '23:00'}):`, slots2[Math.min(si + 2, slots2.length - 1)] || '23:00');
                if (!endTime) return;
                if (!schedule[day]) schedule[day] = {};
                if (!schedule[day][person]) schedule[day][person] = [];
                schedule[day][person].push({ start: slot, end: endTime, label: label.trim() });
                // Sort blocks
                schedule[day][person].sort((a, b) => ttSlotIndex(a.start) - ttSlotIndex(b.start));
                renderTimetable(JSON.stringify(_timetableData), filePath);
            });
        });

        // Click block: edit/delete
        previewBody.querySelectorAll('.tt-block').forEach(td => {
            td.addEventListener('click', () => {
                const day = td.dataset.day, person = td.dataset.person;
                const start = td.dataset.start, end = td.dataset.end;
                const blocks = schedule[day]?.[person] || [];
                const block = blocks.find(b => b.start === start && b.end === end);
                if (!block) return;
                const action = prompt(`"${block.label}" (${start}~${end})\n수정: 새 이름 입력\n삭제: "delete" 입력`, block.label);
                if (action === null) return;
                if (action.toLowerCase() === 'delete') {
                    schedule[day][person] = blocks.filter(b => b !== block);
                } else {
                    block.label = action.trim();
                }
                renderTimetable(JSON.stringify(_timetableData), filePath);
            });
        });

        // Drag selection
        let dragStart = null;
        previewBody.querySelectorAll('.tt-cell[data-slot]').forEach(td => {
            td.addEventListener('mousedown', (e) => {
                e.preventDefault();
                dragStart = { day: td.dataset.day, person: td.dataset.person, slot: td.dataset.slot, el: td };
                td.classList.add('tt-drag-active');
            });
            td.addEventListener('mouseenter', () => {
                if (!dragStart) return;
                if (td.dataset.day !== dragStart.day || td.dataset.person !== dragStart.person) return;
                // Highlight range
                previewBody.querySelectorAll('.tt-drag-active').forEach(el => el.classList.remove('tt-drag-active'));
                const s = Math.min(ttSlotIndex(dragStart.slot), ttSlotIndex(td.dataset.slot));
                const e2 = Math.max(ttSlotIndex(dragStart.slot), ttSlotIndex(td.dataset.slot));
                const slots2 = ttTimeSlots();
                previewBody.querySelectorAll(`.tt-cell[data-day="${dragStart.day}"][data-person="${dragStart.person}"]`).forEach(c => {
                    const ci = ttSlotIndex(c.dataset.slot);
                    if (ci >= s && ci <= e2) c.classList.add('tt-drag-active');
                });
            });
        });
        document.addEventListener('mouseup', () => {
            if (!dragStart) return;
            const activeCells = previewBody.querySelectorAll('.tt-drag-active');
            if (activeCells.length > 1) {
                const slotsArr = Array.from(activeCells).map(c => c.dataset.slot).sort();
                const startSlot = slotsArr[0];
                const endIdx = ttSlotIndex(slotsArr[slotsArr.length - 1]) + 1;
                const allSlots = ttTimeSlots();
                const endSlot = endIdx < allSlots.length ? allSlots[endIdx] : '23:00';
                const day = dragStart.day, person = dragStart.person;
                const label = prompt(`${TT_DAY_LABELS[TT_DAYS.indexOf(day)]} ${startSlot}~${endSlot} - ${person}\n일정명을 입력하세요:`);
                if (label !== null && label.trim()) {
                    if (!schedule[day]) schedule[day] = {};
                    if (!schedule[day][person]) schedule[day][person] = [];
                    schedule[day][person].push({ start: startSlot, end: endSlot, label: label.trim() });
                    schedule[day][person].sort((a, b) => ttSlotIndex(a.start) - ttSlotIndex(b.start));
                    renderTimetable(JSON.stringify(_timetableData), filePath);
                }
            }
            activeCells.forEach(c => c.classList.remove('tt-drag-active'));
            dragStart = null;
        });
    }

    // =========================================================================
    // Datetable (.datetable) — Monthly calendar with people events
    // =========================================================================
    let _datetableData = null;
    let _dtCurrentMonth = null; // { year, month } for navigation

    function renderDatetable(content, filePath, opts) {
        const initial = opts && opts.initial;
        try { _datetableData = JSON.parse(content); } catch { _datetableData = { people: [], events: {} }; }
        if (!_datetableData.people) _datetableData.people = [];
        if (!_datetableData.events) _datetableData.events = {};
        // Mutation-triggered re-render → save. Initial load passes { initial: true }.
        if (!initial && typeof scheduleSave === 'function') scheduleSave();

        const people = _datetableData.people;
        people.forEach((p, i) => { if (!p.color) p.color = TT_COLORS[i % TT_COLORS.length]; });

        const today = new Date();
        if (!_dtCurrentMonth) _dtCurrentMonth = { year: today.getFullYear(), month: today.getMonth() };
        const { year, month } = _dtCurrentMonth;

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDow = firstDay.getDay(); // 0=Sun
        const daysInMonth = lastDay.getDate();

        const monthNames = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

        let html = '<div class="dt-container">';
        // Toolbar: people management
        html += '<div class="dt-toolbar">';
        html += '<span class="tt-toolbar-label">인원:</span>';
        people.forEach((p, i) => {
            html += `<span class="tt-person-tag" style="background:${p.color}" data-idx="${i}">${escHtml(p.name)} <span class="dt-person-remove" data-idx="${i}">&times;</span></span>`;
        });
        html += `<button class="tt-add-person-btn" id="dtAddPerson">+ 추가</button>`;
        html += '</div>';

        // Direct input form
        html += '<div class="dt-input-form">';
        html += '<span class="tt-toolbar-label">일정 추가:</span>';
        html += `<input type="date" id="dtInputDate" class="dt-input" value="${year}-${String(month+1).padStart(2,'0')}-01">`;
        html += '<span class="dt-input-sep">~</span>';
        html += `<input type="date" id="dtInputDateEnd" class="dt-input">`;
        html += `<select id="dtInputPerson" class="dt-input"><option value="">인원 선택</option>`;
        people.forEach((p, i) => { html += `<option value="${i}">${escHtml(p.name)}</option>`; });
        html += '</select>';
        html += `<input type="text" id="dtInputReason" class="dt-input dt-input-reason" placeholder="사유 입력">`;
        html += `<button class="dt-input-btn" id="dtInputAdd">추가</button>`;
        html += '</div>';

        // Month navigation
        html += '<div class="dt-nav">';
        html += `<button class="dt-nav-btn" id="dtPrev">◀</button>`;
        html += `<span class="dt-nav-title">${year}년 ${monthNames[month]}</span>`;
        html += `<button class="dt-nav-btn" id="dtNext">▶</button>`;
        html += '</div>';

        // Drag hint
        html += '<div class="dt-drag-hint" id="dtDragHint" style="display:none;"></div>';

        // Calendar grid
        html += '<div class="dt-grid">';
        const dowLabels = ['일','월','화','수','목','금','토'];
        dowLabels.forEach((d, i) => {
            const cls = i === 0 ? 'dt-dow dt-sun' : i === 6 ? 'dt-dow dt-sat' : 'dt-dow';
            html += `<div class="${cls}">${d}</div>`;
        });

        // Pre-process: detect consecutive event runs
        // A run = same person + same reason on consecutive days
        function dtMakeDateStr(d) {
            return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
        // Build a map: dateStr → [{person, reason, runPos, runStart, runEnd}]
        // runPos: 'single' | 'start' | 'mid' | 'end'
        const dtRunMap = {};
        // Collect all unique (person, reason) pairs across the month
        const seenPairs = new Set();
        for (let d = 1; d <= daysInMonth; d++) {
            const ds = dtMakeDateStr(d);
            (_datetableData.events[ds] || []).forEach(ev => seenPairs.add(ev.person + '|||' + ev.reason));
        }
        // For each pair, find consecutive runs
        seenPairs.forEach(pairKey => {
            const [person, reason] = pairKey.split('|||');
            let runStartDay = null;
            for (let d = 1; d <= daysInMonth + 1; d++) {
                const ds = d <= daysInMonth ? dtMakeDateStr(d) : null;
                const hasEvent = ds && (_datetableData.events[ds] || []).some(ev => ev.person === person && ev.reason === reason);
                if (hasEvent) {
                    if (runStartDay === null) runStartDay = d;
                } else {
                    if (runStartDay !== null) {
                        const runEndDay = d - 1;
                        const runLen = runEndDay - runStartDay + 1;
                        for (let rd = runStartDay; rd <= runEndDay; rd++) {
                            const rds = dtMakeDateStr(rd);
                            if (!dtRunMap[rds]) dtRunMap[rds] = [];
                            let pos = 'single';
                            if (runLen > 1) {
                                if (rd === runStartDay) pos = 'start';
                                else if (rd === runEndDay) pos = 'end';
                                else pos = 'mid';
                            }
                            // Check week boundaries: if start of week (Sun) and not run start → treat as 'start' visually
                            const dow = (startDow + rd - 1) % 7;
                            const nextDow = rd < runEndDay ? (startDow + rd) % 7 : -1;
                            let visualPos = pos;
                            if (pos === 'mid' && dow === 0) visualPos = 'week-start';
                            else if (pos === 'mid' && dow === 6) visualPos = 'week-end';
                            else if (pos === 'start' && dow === 6) visualPos = 'start-end-row';
                            else if (pos === 'end' && dow === 0) visualPos = 'start-end-row';
                            dtRunMap[rds].push({ person, reason, pos, visualPos, runLen, runStart: runStartDay, runEnd: runEndDay });
                        }
                        runStartDay = null;
                    }
                }
            }
        });

        // Empty cells before first day
        for (let i = 0; i < startDow; i++) html += '<div class="dt-cell dt-empty"></div>';

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = dtMakeDateStr(d);
            const dow = (startDow + d - 1) % 7;
            const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
            let cls = 'dt-cell';
            if (dow === 0) cls += ' dt-sun';
            if (dow === 6) cls += ' dt-sat';
            if (isToday) cls += ' dt-today';

            const events = _datetableData.events[dateStr] || [];
            html += `<div class="${cls}" data-date="${dateStr}" data-day="${d}">`;
            html += `<div class="dt-date-num">${d}</div>`;
            html += '<div class="dt-events">';

            // Render events with run-awareness
            const rendered = new Set(); // track rendered (person|||reason) to avoid duplicates from run processing
            events.forEach((ev, ei) => {
                const pairKey = ev.person + '|||' + ev.reason;
                if (rendered.has(pairKey)) return;
                rendered.add(pairKey);
                const person = people.find(p => p.name === ev.person);
                const color = person ? person.color : '#999';
                const runInfo = (dtRunMap[dateStr] || []).find(r => r.person === ev.person && r.reason === ev.reason);
                let evCls = 'dt-event';
                let showLabel = true;
                if (runInfo && runInfo.runLen > 1) {
                    const vp = runInfo.visualPos;
                    const pos = runInfo.pos;
                    if (pos === 'start') {
                        evCls += dow === 6 ? ' dt-ev-single' : ' dt-ev-start';
                    } else if (pos === 'end') {
                        evCls += dow === 0 ? ' dt-ev-single' : ' dt-ev-end';
                        showLabel = dow === 0; // show label at row start
                    } else if (pos === 'mid') {
                        if (dow === 0) { evCls += ' dt-ev-start'; showLabel = true; }
                        else if (dow === 6) { evCls += ' dt-ev-end'; showLabel = false; }
                        else { evCls += ' dt-ev-mid'; showLabel = false; }
                    }
                }
                const label = showLabel ? `${escHtml(ev.person)}(${escHtml(ev.reason)})` : '';
                html += `<div class="${evCls}" style="background:${color}20;border-color:${color}" data-date="${dateStr}" data-eidx="${ei}">${label}</div>`;
            });
            html += '</div></div>';
        }

        // Fill remaining cells
        const totalCells = startDow + daysInMonth;
        const remaining = (7 - totalCells % 7) % 7;
        for (let i = 0; i < remaining; i++) html += '<div class="dt-cell dt-empty"></div>';

        html += '</div>';

        // === Person summary section ===
        if (people.length > 0) {
            html += '<div class="dt-summary">';
            html += '<div class="dt-summary-title">인원별 일정</div>';
            people.forEach(p => {
                // Collect events per day for this person
                const personEvents = [];
                for (let d = 1; d <= daysInMonth; d++) {
                    const dateStr = dtMakeDateStr(d);
                    const evts = (_datetableData.events[dateStr] || []).filter(ev => ev.person === p.name);
                    evts.forEach(ev => personEvents.push({ day: d, reason: ev.reason }));
                }
                // Group consecutive days with same reason into runs
                const runs = [];
                let curRun = null;
                personEvents.forEach(ev => {
                    if (curRun && ev.reason === curRun.reason && ev.day === curRun.endDay + 1) {
                        curRun.endDay = ev.day;
                        curRun.count++;
                    } else {
                        if (curRun) runs.push(curRun);
                        curRun = { startDay: ev.day, endDay: ev.day, reason: ev.reason, count: 1 };
                    }
                });
                if (curRun) runs.push(curRun);
                const totalDays = personEvents.length;
                html += `<div class="dt-summary-person">`;
                html += `<div class="dt-summary-name" style="border-left:4px solid ${p.color};padding-left:8px;">${escHtml(p.name)} <span class="dt-summary-count">(${totalDays}일)</span></div>`;
                if (runs.length === 0) {
                    html += `<div class="dt-summary-empty">이번 달 일정 없음</div>`;
                } else {
                    html += '<div class="dt-summary-list">';
                    runs.forEach(r => {
                        const dateLabel = r.startDay === r.endDay ? `${r.startDay}일` : `${r.startDay}~${r.endDay}일`;
                        html += `<div class="dt-summary-item"><span class="dt-summary-date">${dateLabel}</span> ${escHtml(r.reason || '-')}</div>`;
                    });
                    html += '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        }

        html += '</div>';
        previewBody.innerHTML = html;

        // === Event bindings ===
        // Add person
        const addBtn = previewBody.querySelector('#dtAddPerson');
        if (addBtn) addBtn.addEventListener('click', () => {
            const name = prompt('인원 이름을 입력하세요:');
            if (!name || !name.trim()) return;
            const trimmed = name.trim();
            if (people.some(p => p.name === trimmed)) { alert('이미 존재하는 이름입니다.'); return; }
            people.push({ name: trimmed, color: TT_COLORS[people.length % TT_COLORS.length] });
            renderDatetable(JSON.stringify(_datetableData), filePath);
        });

        // Remove person
        previewBody.querySelectorAll('.dt-person-remove').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(el.dataset.idx);
                const pName = people[idx].name;
                if (!confirm(`"${pName}"을(를) 삭제하시겠습니까?`)) return;
                for (const date in _datetableData.events) {
                    _datetableData.events[date] = _datetableData.events[date].filter(ev => ev.person !== pName);
                    if (_datetableData.events[date].length === 0) delete _datetableData.events[date];
                }
                people.splice(idx, 1);
                renderDatetable(JSON.stringify(_datetableData), filePath);
            });
        });

        // Month navigation
        previewBody.querySelector('#dtPrev')?.addEventListener('click', () => {
            _dtCurrentMonth.month--;
            if (_dtCurrentMonth.month < 0) { _dtCurrentMonth.month = 11; _dtCurrentMonth.year--; }
            renderDatetable(JSON.stringify(_datetableData), filePath);
        });
        previewBody.querySelector('#dtNext')?.addEventListener('click', () => {
            _dtCurrentMonth.month++;
            if (_dtCurrentMonth.month > 11) { _dtCurrentMonth.month = 0; _dtCurrentMonth.year++; }
            renderDatetable(JSON.stringify(_datetableData), filePath);
        });

        // Mobile swipe: swipe left → next month, swipe right → previous month
        const dtContainerEl = previewBody.querySelector('.dt-container');
        if (dtContainerEl) {
            let dtTouchStartX = 0, dtTouchStartY = 0, dtTouchActive = false, dtSwiped = false;
            dtContainerEl.addEventListener('touchstart', (e) => {
                if (e.touches.length !== 1) { dtTouchActive = false; return; }
                dtTouchStartX = e.touches[0].clientX;
                dtTouchStartY = e.touches[0].clientY;
                dtTouchActive = true;
                dtSwiped = false;
            }, { passive: true });
            dtContainerEl.addEventListener('touchmove', (e) => {
                if (!dtTouchActive || e.touches.length !== 1) return;
                const dx = e.touches[0].clientX - dtTouchStartX;
                const dy = e.touches[0].clientY - dtTouchStartY;
                // Once clearly horizontal, mark swiped so touchend skips the tap behavior
                if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                    dtSwiped = true;
                }
            }, { passive: true });
            dtContainerEl.addEventListener('touchend', (e) => {
                if (!dtTouchActive) return;
                dtTouchActive = false;
                const t = e.changedTouches[0];
                const dx = t.clientX - dtTouchStartX;
                const dy = t.clientY - dtTouchStartY;
                if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                    // Horizontal swipe → prevent synthetic mouse/click events, then change month
                    if (e.cancelable) e.preventDefault();
                    if (dx < 0) {
                        _dtCurrentMonth.month++;
                        if (_dtCurrentMonth.month > 11) { _dtCurrentMonth.month = 0; _dtCurrentMonth.year++; }
                    } else {
                        _dtCurrentMonth.month--;
                        if (_dtCurrentMonth.month < 0) { _dtCurrentMonth.month = 11; _dtCurrentMonth.year--; }
                    }
                    renderDatetable(JSON.stringify(_datetableData), filePath);
                }
            });
        }

        // Direct input form
        previewBody.querySelector('#dtInputAdd')?.addEventListener('click', () => {
            const dateStart = previewBody.querySelector('#dtInputDate').value;
            const dateEnd = previewBody.querySelector('#dtInputDateEnd').value;
            const personIdx = previewBody.querySelector('#dtInputPerson').value;
            const reason = previewBody.querySelector('#dtInputReason').value;
            if (!dateStart || personIdx === '') { alert('날짜와 인원을 선택하세요.'); return; }
            const idx = parseInt(personIdx);
            const pName = people[idx].name;
            // Generate date range
            const start = new Date(dateStart);
            const end = dateEnd ? new Date(dateEnd) : start;
            if (end < start) { alert('종료일이 시작일보다 빠릅니다.'); return; }
            for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
                const ds = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
                if (!_datetableData.events[ds]) _datetableData.events[ds] = [];
                _datetableData.events[ds].push({ person: pName, reason: reason.trim() || '' });
            }
            renderDatetable(JSON.stringify(_datetableData), filePath);
        });

        // Drag selection on calendar cells
        let dtDragStart = null;
        let dtDragCells = new Set();
        const dragHint = previewBody.querySelector('#dtDragHint');

        function dtClearDragHighlight() {
            previewBody.querySelectorAll('.dt-cell.dt-drag-selected').forEach(c => c.classList.remove('dt-drag-selected'));
            dtDragCells.clear();
        }

        function dtGetDateRange(startDate, endDate) {
            const s = Math.min(parseInt(startDate), parseInt(endDate));
            const e = Math.max(parseInt(startDate), parseInt(endDate));
            return { start: s, end: e };
        }

        previewBody.querySelectorAll('.dt-cell[data-date]').forEach(cell => {
            cell.addEventListener('mousedown', (e) => {
                if (e.target.closest('.dt-event')) return;
                e.preventDefault();
                dtDragStart = cell.dataset.day;
                dtClearDragHighlight();
                cell.classList.add('dt-drag-selected');
                dtDragCells.add(cell.dataset.day);
            });
            cell.addEventListener('mouseenter', () => {
                if (!dtDragStart) return;
                dtClearDragHighlight();
                const { start, end } = dtGetDateRange(dtDragStart, cell.dataset.day);
                previewBody.querySelectorAll('.dt-cell[data-day]').forEach(c => {
                    const d = parseInt(c.dataset.day);
                    if (d >= start && d <= end) {
                        c.classList.add('dt-drag-selected');
                        dtDragCells.add(c.dataset.day);
                    }
                });
                if (dtDragCells.size > 1) {
                    dragHint.style.display = '';
                    dragHint.textContent = `${start}일 ~ ${end}일 (${dtDragCells.size}일간)`;
                } else {
                    dragHint.style.display = 'none';
                }
            });
        });

        const dtMouseUp = () => {
            if (!dtDragStart) return;
            if (dtDragCells.size > 1) {
                // Multi-day drag complete → ask for event
                if (people.length === 0) { alert('먼저 인원을 추가하세요.'); dtDragStart = null; dtClearDragHighlight(); dragHint.style.display = 'none'; return; }
                const personList = people.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
                const days = Array.from(dtDragCells).map(Number).sort((a, b) => a - b);
                const choice = prompt(`${days[0]}일 ~ ${days[days.length-1]}일\n인원 번호를 선택하세요:\n${personList}`);
                if (choice) {
                    const idx = parseInt(choice) - 1;
                    if (idx >= 0 && idx < people.length) {
                        const reason = prompt(`${people[idx].name}의 사유를 입력하세요:`);
                        if (reason !== null) {
                            days.forEach(d => {
                                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                                if (!_datetableData.events[dateStr]) _datetableData.events[dateStr] = [];
                                _datetableData.events[dateStr].push({ person: people[idx].name, reason: reason.trim() || '' });
                            });
                            renderDatetable(JSON.stringify(_datetableData), filePath);
                        }
                    }
                }
            } else if (dtDragCells.size === 1) {
                // Single click
                const day = Array.from(dtDragCells)[0];
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(parseInt(day)).padStart(2, '0')}`;
                if (people.length === 0) { alert('먼저 인원을 추가하세요.'); } else {
                    const personList = people.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
                    const choice = prompt(`${dateStr}\n인원 번호를 선택하세요:\n${personList}`);
                    if (choice) {
                        const idx = parseInt(choice) - 1;
                        if (idx >= 0 && idx < people.length) {
                            const reason = prompt(`${people[idx].name}의 사유를 입력하세요:`);
                            if (reason !== null) {
                                if (!_datetableData.events[dateStr]) _datetableData.events[dateStr] = [];
                                _datetableData.events[dateStr].push({ person: people[idx].name, reason: reason.trim() || '' });
                                renderDatetable(JSON.stringify(_datetableData), filePath);
                            }
                        }
                    }
                }
            }
            dtDragStart = null;
            dtClearDragHighlight();
            dragHint.style.display = 'none';
        };
        document.addEventListener('mouseup', dtMouseUp);

        // Click event: edit/delete
        previewBody.querySelectorAll('.dt-event').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const dateStr = el.dataset.date;
                const eidx = parseInt(el.dataset.eidx);
                const ev = _datetableData.events[dateStr]?.[eidx];
                if (!ev) return;
                const action = prompt(`${ev.person}(${ev.reason})\n수정: 새 사유 입력\n삭제: "delete" 입력`, ev.reason);
                if (action === null) return;
                if (action.toLowerCase() === 'delete') {
                    _datetableData.events[dateStr].splice(eidx, 1);
                    if (_datetableData.events[dateStr].length === 0) delete _datetableData.events[dateStr];
                } else {
                    ev.reason = action.trim();
                }
                renderDatetable(JSON.stringify(_datetableData), filePath);
            });
        });
    }

    // Patch loadFinderGrid to update hash and title
    const _origLoadFinderGrid = loadFinderGrid;
    loadFinderGrid = function(dirPath) {
        updateHash(dirPath);
        const folderName = dirPath.split('/').pop() || 'Workspace';
        document.title = folderName + ' - Claude Notebook';
        return _origLoadFinderGrid(dirPath);
    };

    window.addEventListener('hashchange', syncHashToPath);
    window.addEventListener('popstate', syncHashToPath);

    // === Init ===
    initTree({ openFile: openPreview, openDir: loadFinderGrid });
    loadTree();
    syncHashToPath();
