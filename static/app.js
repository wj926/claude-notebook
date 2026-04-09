/* === Claude Notebook App — Finder + File Management === */

(function () {
    const treeEl = document.getElementById('tree');
    const contentEl = document.getElementById('content');
    const sidebar = document.getElementById('sidebar');
    const divider = document.getElementById('divider');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarClose = document.getElementById('sidebarClose');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
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
    const previewHistory = document.getElementById('previewHistory');
    const previewColorRules = document.getElementById('previewColorRules');
    const historyOverlay = document.getElementById('historyOverlay');
    const historyClose = document.getElementById('historyClose');
    const historyList = document.getElementById('historyList');
    const historyPreview = document.getElementById('historyPreview');
    const historyRestore = document.getElementById('historyRestore');

    const BASE = window.__VIEWER_BASE || '';
    const XSRF = window.__XSRF_TOKEN || '';
    const fetchOpts = { headers: { 'ngrok-skip-browser-warning': '1' }, credentials: 'same-origin' };
    // For mutating requests (POST/DELETE), include XSRF token
    function mutFetchOpts(extra) {
        return {
            ...extra,
            credentials: 'same-origin',
            headers: { 'ngrok-skip-browser-warning': '1', 'X-XSRFToken': XSRF, ...(extra && extra.headers) },
        };
    }
    let currentFinderPath = '';
    let currentPreviewPath = '';
    let isInlineEditing = false;           // true when md/txt/code textarea is shown
    let currentFileData = null;            // { path, content, extension }
    // Auto-save state machine
    const AUTO_SAVE_DEBOUNCE_MS = 1500;
    let saveTimer = null;                  // pending debounced save
    let lastSavedContent = null;           // last content confirmed on disk
    let saveInFlight = false;              // a PUT is currently running
    // History modal state
    let currentSnapshots = [];
    let selectedSnapshotTs = null;
    let selectedSnapshotContent = null;

    // === Sidebar toggle ===
    function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
    function openSidebar() {
        sidebar.classList.add('open');
        sidebar.classList.remove('collapsed');
        sidebarOverlay.classList.add('active');
        divider.style.display = '';
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
        if (!isMobile()) {
            sidebar.classList.add('collapsed');
            divider.style.display = 'none';
        }
    }
    sidebarToggle.addEventListener('click', () => {
        if (isMobile()) {
            sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
        } else {
            sidebar.classList.contains('collapsed') ? openSidebar() : closeSidebar();
        }
    });
    sidebarClose.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

    // === Terminal button ===
    document.getElementById('terminalBtn').addEventListener('click', () => {
        window.location.href = (window.__VIEWER_BASE || '/claude-notebook') + '/terminal';
    });

    // Configure marked
    marked.setOptions({ gfm: true, breaks: true });

    // === Sidebar resize ===
    let isResizing = false;
    divider.addEventListener('mousedown', () => { isResizing = true; divider.classList.add('active'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
    document.addEventListener('mousemove', (e) => { if (isResizing) sidebar.style.width = Math.min(Math.max(e.clientX, 200), 480) + 'px'; });
    document.addEventListener('mouseup', () => { if (isResizing) { isResizing = false; divider.classList.remove('active'); document.body.style.cursor = ''; document.body.style.userSelect = ''; } });

    // === Utility ===
    function escHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

    const FILE_ICONS = {
        md: '📄', markdown: '📄', py: '🐍', js: '⚙️', json: '📋', yaml: '📋', yml: '📋',
        html: '🌐', css: '🎨', txt: '📄', sh: '⚙️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️',
        gif: '🖼️', webp: '🖼️', svg: '🖼️', bmp: '🖼️', ico: '🖼️', pdf: '📕',
        zip: '📦', tar: '📦', gz: '📦',
    };
    function getFileIcon(name) { return FILE_ICONS[name.split('.').pop().toLowerCase()] || '📄'; }
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'];

    // === Fetch helpers ===
    // Normalize backslashes to forward slashes (Windows compat)
    function normPath(p) { return p ? p.replace(/\\/g, '/') : p; }

    async function fetchTreeLevel(dirPath) {
        const url = dirPath ? `${BASE}/api/tree?path=${encodeURIComponent(dirPath)}` : `${BASE}/api/tree`;
        const res = await fetch(url, fetchOpts);
        if (!res.ok) throw new Error('Failed to load tree');
        const items = await res.json();
        items.forEach(item => { item.path = normPath(item.path); });
        return items;
    }

    // === Sidebar tree (unchanged logic) ===
    async function loadTree() {
        try {
            const data = await fetchTreeLevel('');
            treeEl.innerHTML = '';
            renderTree(data, treeEl, 0);
        } catch (err) {
            treeEl.innerHTML = '<div class="loading">Error loading files.</div>';
        }
    }

    function renderTree(items, parent, depth) {
        items.forEach((item) => {
            if (item.type === 'directory') {
                const dirEl = document.createElement('div');
                const label = document.createElement('div');
                label.className = 'tree-item';
                label.dataset.depth = depth;
                label.innerHTML = `<span class="icon">&#9654;</span><span class="name">${escHtml(item.name)}</span>`;
                if (item.repo_url) {
                    const repoLink = document.createElement('a');
                    repoLink.href = item.repo_url;
                    repoLink.target = '_blank';
                    repoLink.rel = 'noopener noreferrer';
                    repoLink.className = 'repo-link';
                    repoLink.title = item.repo_url;
                    repoLink.innerHTML = '<svg class="github-icon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
                    repoLink.addEventListener('click', (e) => e.stopPropagation());
                    label.appendChild(repoLink);
                }
                const children = document.createElement('div');
                children.className = 'tree-children';
                let loaded = false;
                label.addEventListener('click', async () => {
                    const isOpen = children.classList.toggle('open');
                    label.querySelector('.icon').innerHTML = isOpen ? '&#9660;' : '&#9654;';
                    if (isOpen && !loaded) {
                        loaded = true;
                        try {
                            const subItems = await fetchTreeLevel(item.path);
                            renderTree(subItems, children, depth + 1);
                        } catch (e) {
                            children.innerHTML = '<div class="tree-item" style="opacity:0.5">Error loading</div>';
                        }
                    }
                    // Also update finder grid
                    if (isOpen) loadFinderGrid(item.path);
                });
                dirEl.appendChild(label);
                dirEl.appendChild(children);
                parent.appendChild(dirEl);
            } else {
                const fileEl = document.createElement('div');
                fileEl.className = 'tree-item';
                fileEl.dataset.depth = depth;
                fileEl.innerHTML = `<span class="icon">${getFileIcon(item.name)}</span><span class="name">${escHtml(item.name)}</span>`;
                fileEl.addEventListener('click', () => {
                    document.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
                    fileEl.classList.add('active');
                    openPreview(item.path);
                    if (isMobile()) closeSidebar();
                });
                parent.appendChild(fileEl);
            }
        });
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

    function formatFileSize(bytes) {
        if (bytes == null) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
    function formatMtime(ts) {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function fileTypeLabel(item) {
        if (item.type === 'directory') return '폴더';
        const ext = item.name.includes('.') ? item.name.split('.').pop().toLowerCase() : '';
        return ext ? ext.toUpperCase() + ' 파일' : '파일';
    }

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

    async function deleteSelected() {
        const paths = Array.from(selectedPaths);
        if (!confirm(`Delete ${paths.length} item(s)?`)) return;
        try {
            const res = await fetch(`${BASE}/api/delete-multi`, mutFetchOpts({
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
                body: JSON.stringify({ paths }),
            }));
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.errors && data.errors.length) {
                alert('Some items failed to delete:\n' + data.errors.map(e => e.path + ': ' + e.error).join('\n'));
            }
            clearSelection();
            loadFinderGrid(currentFinderPath);
            loadTree();
        } catch (err) {
            alert('Delete failed: ' + err.message);
        }
    }

    async function downloadSelected() {
        const paths = Array.from(selectedPaths);
        try {
            const res = await fetch(`${BASE}/api/download-multi`, mutFetchOpts({
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
                body: JSON.stringify({ paths }),
            }));
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = 'selected-files.zip';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(objectUrl);
        } catch (err) {
            alert('Download failed: ' + err.message);
        }
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

    // === File Actions ===
    async function downloadFile(path) {
        try {
            const url = `${BASE}/api/download?path=${encodeURIComponent(path)}`;
            const res = await fetch(url, fetchOpts);
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            let dlName = path.split('/').pop();
            const utf8Match = disposition.match(/filename\*=UTF-8''(.+)/i);
            const plainMatch = disposition.match(/filename="(.+?)"/);
            if (utf8Match) dlName = decodeURIComponent(utf8Match[1]);
            else if (plainMatch) dlName = plainMatch[1];
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = dlName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(objectUrl);
        } catch (err) {
            alert('Download failed: ' + err.message);
        }
    }

    async function deleteItem(item) {
        if (!confirm(`Delete "${item.name}"?`)) return;
        try {
            const res = await fetch(`${BASE}/api/delete?path=${encodeURIComponent(item.path)}`,
                mutFetchOpts({ method: 'DELETE' }));
            if (!res.ok) throw new Error(await res.text());
            loadFinderGrid(currentFinderPath);
            loadTree(); // refresh sidebar
        } catch (err) {
            alert('Delete failed: ' + err.message);
        }
    }

    // === New File ===
    document.getElementById('newFileBtn').addEventListener('click', async () => {
        const name = prompt('New file name (e.g. note.md):');
        if (!name || !name.trim()) return;
        const filePath = currentFinderPath ? currentFinderPath + '/' + name.trim() : name.trim();
        try {
            const res = await fetch(`${BASE}/api/newfile`, mutFetchOpts({
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
                body: JSON.stringify({ path: filePath }),
            }));
            if (!res.ok) throw new Error(await res.text());
            loadFinderGrid(currentFinderPath);
            loadTree();
        } catch (err) {
            alert('Failed to create file: ' + err.message);
        }
    });

    // === New Folder ===
    document.getElementById('newFolderBtn').addEventListener('click', async () => {
        const name = prompt('New folder name:');
        if (!name || !name.trim()) return;
        const folderPath = currentFinderPath ? currentFinderPath + '/' + name.trim() : name.trim();
        try {
            const res = await fetch(`${BASE}/api/mkdir`, mutFetchOpts({
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
                body: JSON.stringify({ path: folderPath }),
            }));
            if (!res.ok) throw new Error(await res.text());
            loadFinderGrid(currentFinderPath);
            loadTree();
        } catch (err) {
            alert('Failed to create folder: ' + err.message);
        }
    });

    // === Rename ===
    async function renameItem(item) {
        const newName = prompt('Rename to:', item.name);
        if (!newName || !newName.trim() || newName.trim() === item.name) return;
        const parentPath = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
        const newPath = parentPath ? parentPath + '/' + newName.trim() : newName.trim();
        try {
            const res = await fetch(`${BASE}/api/rename`, mutFetchOpts({
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
                body: JSON.stringify({ old_path: item.path, new_path: newPath }),
            }));
            if (!res.ok) throw new Error(await res.text());
            loadFinderGrid(currentFinderPath);
            loadTree();
        } catch (err) {
            alert('Rename failed: ' + err.message);
        }
    }

    // === Upload ===
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB per chunk
    const CHUNKED_THRESHOLD = 50 * 1024 * 1024; // Use chunked for files > 50 MB
    const CHUNK_MAX_RETRIES = 3;
    const MAX_UPLOAD_FILES = 100000; // Max files per upload to prevent browser crash

    function formatSize(bytes) {
        if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
        if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
        if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return bytes + ' B';
    }

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
    const CSV_EXTS = ['.csv'];
    const MD_EXTS = ['.md', '.markdown'];
    const TIMETABLE_EXTS = ['.timetable'];
    const DATETABLE_EXTS = ['.datetable'];
    const SCHEDULE_EXTS = ['.timetable', '.datetable']; // always-interactive types

    function openPreview(path) {
        currentPreviewPath = path;
        isInlineEditing = false;
        currentFileData = null;
        lastSavedContent = null;
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        setSaveStatus('idle');
        previewOverlay.classList.add('active');
        finder.style.display = 'none';
        previewHistory.style.display = 'none';
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
        lastSavedContent = null;
        previewHistory.style.display = 'none';
        previewColorRules.style.display = 'none';
        setSaveStatus('idle');
        updateHash(currentPath);
        const folderName = currentPath.split('/').pop() || 'Workspace';
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

    function setSaveStatus(state) {
        if (!previewStatus) return;
        previewStatus.dataset.state = state;
    }

    /** Collect the latest content from whichever editor is currently active. */
    function getCurrentContent() {
        if (!currentFileData) return null;
        const ext = currentFileData.extension;
        if (CSV_EXTS.includes(ext)) {
            // csvEditRows is the single source of truth for CSV — both
            // viewer-checkbox mutations and editor cell edits feed it.
            if (csvEditRows && csvEditRows.length > 0) return csvTableToString();
            return currentFileData.content;
        }
        if (TIMETABLE_EXTS.includes(ext)) return JSON.stringify(_timetableData, null, 2);
        if (DATETABLE_EXTS.includes(ext)) return JSON.stringify(_datetableData, null, 2);
        // Markdown: serialize the contenteditable DOM back to markdown so
        // there's no need to ever swap to a textarea.
        if (MD_EXTS.includes(ext)) {
            const editor = previewBody.querySelector('.notion-editor');
            if (editor) return domToMarkdown(editor);
            return currentFileData.content;
        }
        const ta = previewBody.querySelector('.edit-textarea');
        if (ta) return ta.value;
        return null;
    }

    /** Schedule a debounced save. Called on every user mutation. */
    function scheduleSave() {
        if (!currentFileData) return;
        if (saveTimer) clearTimeout(saveTimer);
        setSaveStatus('dirty');
        saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, AUTO_SAVE_DEBOUNCE_MS);
    }

    /** Write current content to disk immediately, bypassing the debounce. */
    async function flushSave({ silent = false } = {}) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (!currentFileData) return;
        const content = getCurrentContent();
        if (content == null) return;
        if (content === lastSavedContent) {
            if (!silent) setSaveStatus('saved');
            return;
        }
        if (saveInFlight) {
            // Another save is running; re-schedule a short retry so the
            // latest content always gets written.
            saveTimer = setTimeout(() => { saveTimer = null; flushSave({ silent }); }, 200);
            return;
        }
        saveInFlight = true;
        if (!silent) setSaveStatus('saving');
        try {
            const res = await fetch(`${BASE}/api/save`, mutFetchOpts({
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentFileData.path, content }),
            }));
            if (!res.ok) throw new Error(await res.text());
            lastSavedContent = content;
            currentFileData.content = content;
            if (!silent) setSaveStatus('saved');
        } catch (err) {
            console.warn('Auto-save failed:', err);
            if (!silent) setSaveStatus('error');
        } finally {
            saveInFlight = false;
        }
    }

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
                ta.value = lastSavedContent != null ? lastSavedContent : (currentFileData.content || '');
                isInlineEditing = false;
                if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
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
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (!currentFileData) return;
        const content = getCurrentContent();
        if (content == null || content === lastSavedContent) return;
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
    // current block in place. Auto-save reads the DOM through a home-grown
    // HTML→Markdown serializer — there is no mode switch and no rendered ↔
    // source asymmetry.
    //
    // Scope covers the subset marked.js produces: headings h1-h6, p, ul, ol,
    // li (incl. task-list checkbox), blockquote, pre>code, hr, img, tables,
    // and inline strong/em/code/del/a/br. Anything else falls through as
    // textContent.

    const BLOCK_TAGS = new Set([
        'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'pre', 'ul', 'ol', 'li', 'hr', 'table', 'div',
    ]);

    /** Walk up from a node to the enclosing block element inside the editor. */
    function closestBlock(node, editor) {
        let n = node;
        while (n && n !== editor) {
            if (n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.tagName.toLowerCase())) {
                return n;
            }
            n = n.parentNode;
        }
        return null;
    }

    function placeCaretAtStart(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // ---- Inline (recursive) HTML → Markdown ----
    function inlineToMd(el) {
        let out = '';
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                out += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (tag === 'br') { out += '  \n'; continue; }
                if (tag === 'img') {
                    const alt = node.getAttribute('alt') || '';
                    const src = node.getAttribute('src') || '';
                    out += `![${alt}](${src})`;
                    continue;
                }
                const inner = inlineToMd(node);
                switch (tag) {
                    case 'strong': case 'b': out += inner.trim() ? `**${inner}**` : inner; break;
                    case 'em': case 'i': out += inner.trim() ? `*${inner}*` : inner; break;
                    case 'code': out += `\`${inner}\``; break;
                    case 'del': case 's': case 'strike': out += `~~${inner}~~`; break;
                    case 'a': {
                        const href = node.getAttribute('href') || '';
                        out += `[${inner}](${href})`;
                        break;
                    }
                    case 'input':
                        // task-list checkbox — handled by the containing <li>
                        break;
                    default:
                        out += inner;
                }
            }
        }
        return out;
    }

    // ---- List → Markdown (supports nesting + task-list checkboxes) ----
    function listToMd(ul, ordered, depth) {
        const items = Array.from(ul.children).filter(c => c.tagName === 'LI');
        const indent = '    '.repeat(depth); // 4 spaces per level keeps marked.js happy
        return items.map((li, i) => {
            const bullet = ordered ? `${i + 1}. ` : '- ';
            // Task-list checkbox?
            const cb = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
            const task = cb ? (cb.checked ? '[x] ' : '[ ] ') : '';
            // Split li contents: the first paragraph/text is the item text;
            // any nested ul/ol is recursively serialized and indented.
            let textParts = [];
            let nestedParts = [];
            for (const child of li.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    textParts.push(child.textContent);
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    const tag = child.tagName.toLowerCase();
                    if (tag === 'ul') nestedParts.push(listToMd(child, false, depth + 1));
                    else if (tag === 'ol') nestedParts.push(listToMd(child, true, depth + 1));
                    else if (tag === 'input' && child.type === 'checkbox') { /* consumed */ }
                    else if (tag === 'p') textParts.push(inlineToMd(child));
                    else textParts.push(inlineToMd(child));
                }
            }
            const text = textParts.join('').replace(/^\s+|\s+$/g, '');
            let line = indent + bullet + task + text;
            if (nestedParts.length) line += '\n' + nestedParts.join('\n');
            return line;
        }).join('\n');
    }

    // ---- Table → Markdown (pipe table) ----
    function tableToMd(table) {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length === 0) return '';
        const cellsOf = (tr) => Array.from(tr.children)
            .filter(c => c.tagName === 'TH' || c.tagName === 'TD')
            .map(c => inlineToMd(c).replace(/\|/g, '\\|').replace(/\n/g, ' '));
        const header = cellsOf(rows[0]);
        const sep = header.map(() => '---');
        const body = rows.slice(1).map(cellsOf);
        const toRow = (cells) => '| ' + cells.join(' | ') + ' |';
        return [toRow(header), toRow(sep), ...body.map(toRow)].join('\n');
    }

    // ---- Single block → Markdown ----
    function blockToMd(block) {
        const tag = block.tagName.toLowerCase();
        switch (tag) {
            case 'h1': return '# ' + inlineToMd(block);
            case 'h2': return '## ' + inlineToMd(block);
            case 'h3': return '### ' + inlineToMd(block);
            case 'h4': return '#### ' + inlineToMd(block);
            case 'h5': return '##### ' + inlineToMd(block);
            case 'h6': return '###### ' + inlineToMd(block);
            case 'p': {
                const txt = inlineToMd(block);
                return txt;
            }
            case 'blockquote': {
                // Serialize inner blocks then prefix each line with "> "
                const inner = Array.from(block.childNodes)
                    .map(n => {
                        if (n.nodeType === Node.TEXT_NODE) return n.textContent;
                        if (n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.tagName.toLowerCase())) {
                            return blockToMd(n);
                        }
                        return n.nodeType === Node.ELEMENT_NODE ? inlineToMd(n) : '';
                    })
                    .filter(Boolean)
                    .join('\n\n');
                return inner.split('\n').map(l => '> ' + l).join('\n');
            }
            case 'pre': {
                const code = block.querySelector('code');
                const langMatch = code && code.className.match(/language-([\w-]+)/);
                const lang = langMatch ? langMatch[1] : '';
                const text = (code || block).textContent.replace(/\n$/, '');
                return '```' + lang + '\n' + text + '\n```';
            }
            case 'ul': return listToMd(block, false, 0);
            case 'ol': return listToMd(block, true, 0);
            case 'hr': return '---';
            case 'table': return tableToMd(block);
            case 'div': case 'section': {
                // Transparent: recurse
                return Array.from(block.childNodes)
                    .map(n => n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.tagName.toLowerCase())
                        ? blockToMd(n)
                        : (n.nodeType === Node.TEXT_NODE ? n.textContent : (n.nodeType === Node.ELEMENT_NODE ? inlineToMd(n) : '')))
                    .filter(s => s.trim())
                    .join('\n\n');
            }
            default: return inlineToMd(block);
        }
    }

    /** Serialize the whole editor to Markdown. */
    function domToMarkdown(editor) {
        if (!editor) return '';
        const parts = [];
        for (const child of editor.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                const t = child.textContent.replace(/^\s+|\s+$/g, '');
                if (t) parts.push(t);
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                if (BLOCK_TAGS.has(child.tagName.toLowerCase())) {
                    parts.push(blockToMd(child));
                } else {
                    // stray inline at top level — wrap as paragraph
                    const t = inlineToMd(child);
                    if (t.trim()) parts.push(t);
                }
            }
        }
        // Collapse triple-blank-lines, ensure trailing newline
        return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    }

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

    /** Wire a contenteditable markdown editor. */
    function setupNotionEditor(editor) {
        if (!editor) return;
        editor.setAttribute('contenteditable', 'true');
        editor.setAttribute('spellcheck', 'false');

        // Markdown shortcut on space
        editor.addEventListener('input', (e) => {
            if (e.inputType === 'insertText' && e.data === ' ') {
                tryMarkdownShortcut(editor);
            }
            scheduleSave();
        });

        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                if (tryEnterBehavior(editor, e)) return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                editor.blur();
                flushSave();
                return;
            }
            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;
            const k = e.key.toLowerCase();
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
            } else if (k === 's') {
                e.preventDefault();
                flushSave();
            }
        });

        // Save on blur too (belt and suspenders)
        editor.addEventListener('blur', () => { flushSave(); });

        // Paste: strip rich HTML formatting, paste as plain text. Users who
        // paste from Word/Notion/etc. won't inherit wild inline styles.
        editor.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text/plain');
            if (text) document.execCommand('insertText', false, text);
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
            setupNotionEditor(editor);
            // Use the serialized form as baseline so no-op opens don't dirty
            // the file just because the round-trip isn't byte-identical.
            lastSavedContent = domToMarkdown(editor);
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

    // ========== SNAPSHOT HISTORY MODAL ==========
    function formatSnapshotTs(ts) {
        // 20260409-120543-123 → 2026-04-09 12:05:43
        if (!ts || ts.length < 15) return ts;
        const y = ts.slice(0, 4), m = ts.slice(4, 6), d = ts.slice(6, 8);
        const hh = ts.slice(9, 11), mm = ts.slice(11, 13), ss = ts.slice(13, 15);
        return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    }

    function formatByteSize(n) {
        if (n == null) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    async function openHistoryModal() {
        if (!currentFileData) return;
        // Flush pending edits first so they're visible as the newest snapshot
        await flushSave({ silent: true });
        selectedSnapshotTs = null;
        selectedSnapshotContent = null;
        historyRestore.disabled = true;
        historyPreview.innerHTML = '<div class="history-preview-empty">Select a snapshot to preview</div>';
        historyList.innerHTML = '<div class="history-list-empty">Loading…</div>';
        historyOverlay.classList.add('active');
        try {
            const res = await fetch(
                `${BASE}/api/snapshots?path=${encodeURIComponent(currentFileData.path)}`,
                fetchOpts
            );
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            currentSnapshots = data.snapshots || [];
            if (currentSnapshots.length === 0) {
                historyList.innerHTML = '<div class="history-list-empty">No snapshots yet.<br>Make a change to create one.</div>';
                return;
            }
            historyList.innerHTML = currentSnapshots.map((s) => `
                <div class="history-item" data-ts="${escHtml(s.ts)}">
                    <div class="history-item-ts">${formatSnapshotTs(s.ts)}</div>
                    <div class="history-item-size">${formatByteSize(s.size)}</div>
                </div>
            `).join('');
            historyList.querySelectorAll('.history-item').forEach(el => {
                el.addEventListener('click', () => {
                    historyList.querySelectorAll('.history-item').forEach(x => x.classList.remove('active'));
                    el.classList.add('active');
                    loadSnapshotContent(el.dataset.ts);
                });
            });
        } catch (err) {
            historyList.innerHTML = `<div class="history-list-empty">Error: ${escHtml(err.message)}</div>`;
        }
    }

    async function loadSnapshotContent(ts) {
        selectedSnapshotTs = ts;
        selectedSnapshotContent = null;
        historyRestore.disabled = true;
        historyPreview.innerHTML = '<div class="history-preview-empty">Loading…</div>';
        try {
            const url = `${BASE}/api/snapshots/content?path=${encodeURIComponent(currentFileData.path)}&ts=${encodeURIComponent(ts)}`;
            const res = await fetch(url, fetchOpts);
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            selectedSnapshotContent = data.content;
            historyPreview.innerHTML = `<pre>${escHtml(data.content)}</pre>`;
            historyRestore.disabled = false;
        } catch (err) {
            historyPreview.innerHTML = `<div class="history-preview-empty">Error: ${escHtml(err.message)}</div>`;
        }
    }

    function closeHistoryModal() {
        historyOverlay.classList.remove('active');
        selectedSnapshotTs = null;
        selectedSnapshotContent = null;
    }

    async function restoreSelectedSnapshot() {
        if (!currentFileData || selectedSnapshotContent == null) return;
        // Save restores as a normal write — the server takes a fresh snapshot
        // of the current (pre-restore) content first, so the restore itself
        // is reversible.
        try {
            const res = await fetch(`${BASE}/api/save`, mutFetchOpts({
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: currentFileData.path,
                    content: selectedSnapshotContent,
                }),
            }));
            if (!res.ok) throw new Error(await res.text());
            currentFileData.content = selectedSnapshotContent;
            lastSavedContent = selectedSnapshotContent;
            setSaveStatus('saved');
            closeHistoryModal();
            // Re-render the preview with the restored content
            renderPreviewMode(currentFileData);
        } catch (err) {
            alert('Restore failed: ' + err.message);
        }
    }

    previewHistory.addEventListener('click', openHistoryModal);
    historyClose.addEventListener('click', closeHistoryModal);
    historyOverlay.addEventListener('click', (e) => {
        if (e.target === historyOverlay) closeHistoryModal();
    });
    historyRestore.addEventListener('click', restoreSelectedSnapshot);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && historyOverlay.classList.contains('active')) {
            closeHistoryModal();
        }
    });

    async function loadPreviewContent(path) {
        try {
            const ext = '.' + path.split('.').pop().toLowerCase();
            const parts = path.split('/');
            previewBreadcrumb.innerHTML = parts.map((p) => `<span>${escHtml(p)}</span>`).join(' / ');
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
            lastSavedContent = data.content;

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

            renderPreviewMode(data);
        } catch (err) {
            previewBody.innerHTML = `<p style="padding:20px;color:var(--text-secondary);">Error: ${escHtml(err.message)}</p>`;
        }
    }

    // === CSV Parser & Serializer (vanilla JS, RFC 4180) ===
    function parseCsv(text) {
        const rows = [];
        let i = 0;
        const len = text.length;
        while (i < len) {
            const row = [];
            while (i < len) {
                let val = '';
                if (text[i] === '"') {
                    i++; // skip opening quote
                    while (i < len) {
                        if (text[i] === '"') {
                            if (i + 1 < len && text[i + 1] === '"') { val += '"'; i += 2; }
                            else { i++; break; }
                        } else { val += text[i]; i++; }
                    }
                } else {
                    while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') { val += text[i]; i++; }
                }
                row.push(val);
                if (i < len && text[i] === ',') { i++; }
                else break;
            }
            if (i < len && text[i] === '\r') i++;
            if (i < len && text[i] === '\n') i++;
            if (row.length > 1 || row[0] !== '' || i < len) rows.push(row);
        }
        return rows;
    }

    function csvStringify(rows) {
        return rows.map(row => row.map(cell => {
            if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
                return '"' + cell.replace(/"/g, '""') + '"';
            }
            return cell;
        }).join(',')).join('\n');
    }

    // === CSV persistence via server config API ===
    const CONFIG_API = BASE + '/api/config';
    let csvConfigCache = null; // { colWidths: {path: [...]}, rowColors: {path: {...}} }

    async function loadCsvConfig() {
        if (csvConfigCache) return csvConfigCache;
        try {
            const res = await fetch(`${CONFIG_API}?key=csv-preferences`, fetchOpts);
            if (res.ok) csvConfigCache = await res.json();
        } catch (e) {}
        if (!csvConfigCache || typeof csvConfigCache !== 'object') csvConfigCache = {};
        if (!csvConfigCache.colWidths) csvConfigCache.colWidths = {};
        if (!csvConfigCache.rowColors) csvConfigCache.rowColors = {};
        if (!csvConfigCache.colorRules) csvConfigCache.colorRules = {};
        if (!csvConfigCache.checkboxCols) csvConfigCache.checkboxCols = {};
        return csvConfigCache;
    }
    function saveCsvConfig() {
        if (!csvConfigCache) return;
        fetch(CONFIG_API, mutFetchOpts({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'csv-preferences', data: csvConfigCache }),
        })).catch(() => {});
    }
    function saveCsvColWidths(path, widths) {
        if (!csvConfigCache) csvConfigCache = { colWidths: {}, rowColors: {} };
        csvConfigCache.colWidths[path] = widths;
        saveCsvConfig();
    }
    function loadCsvColWidths(path) {
        return csvConfigCache && csvConfigCache.colWidths ? csvConfigCache.colWidths[path] || null : null;
    }
    function saveCsvRowColors(path, colors) {
        if (!csvConfigCache) csvConfigCache = { colWidths: {}, rowColors: {} };
        csvConfigCache.rowColors[path] = colors;
        saveCsvConfig();
    }
    function loadCsvRowColors(path) {
        return csvConfigCache && csvConfigCache.rowColors ? csvConfigCache.rowColors[path] || null : null;
    }
    function saveCsvColorRules(path, rules) {
        if (!csvConfigCache) csvConfigCache = { colWidths: {}, rowColors: {} };
        if (!csvConfigCache.colorRules) csvConfigCache.colorRules = {};
        csvConfigCache.colorRules[path] = rules;
        saveCsvConfig();
    }
    function loadCsvColorRules(path) {
        return csvConfigCache && csvConfigCache.colorRules ? csvConfigCache.colorRules[path] || null : null;
    }
    function saveCsvCheckboxCols(path, cols) {
        if (!csvConfigCache) csvConfigCache = { colWidths: {}, rowColors: {} };
        if (!csvConfigCache.checkboxCols) csvConfigCache.checkboxCols = {};
        csvConfigCache.checkboxCols[path] = cols;
        saveCsvConfig();
    }
    function loadCsvCheckboxCols(path) {
        return csvConfigCache && csvConfigCache.checkboxCols ? csvConfigCache.checkboxCols[path] || null : null;
    }
    const ROW_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
    const RULE_OPS = [
        { value: 'equals', label: 'equals' },
        { value: 'contains', label: 'contains' },
        { value: 'gt', label: '>' },
        { value: 'lt', label: '<' },
        { value: 'empty', label: 'is empty' },
    ];

    function matchColorRule(rule, cellValue) {
        const val = (cellValue || '').trim();
        switch (rule.op) {
            case 'equals': return val.toLowerCase() === rule.value.toLowerCase();
            case 'contains': return val.toLowerCase().includes(rule.value.toLowerCase());
            case 'gt': return !isNaN(parseFloat(val)) && parseFloat(val) > parseFloat(rule.value);
            case 'lt': return !isNaN(parseFloat(val)) && parseFloat(val) < parseFloat(rule.value);
            case 'empty': return val === '';
            default: return false;
        }
    }

    function getConditionalColor(row, headers, rules) {
        if (!rules || rules.length === 0) return '';
        for (const rule of rules) {
            const colIdx = headers.indexOf(rule.column);
            if (colIdx < 0) continue;
            if (matchColorRule(rule, row[colIdx])) return rule.color;
        }
        return '';
    }

    // === Color Rules Modal ===
    let currentCsvHeaders = [];
    let currentCsvRenderFn = null;

    function showColorRulesModal(filePath, headers, colorRules, onSave) {
        let rules = JSON.parse(JSON.stringify(colorRules || []));
        const overlay = document.createElement('div');
        overlay.className = 'color-rules-overlay';

        function renderModal() {
            let rulesHtml = '';
            rules.forEach((rule, i) => {
                const colOpts = headers.map(h => `<option value="${escHtml(h)}"${rule.column === h ? ' selected' : ''}>${escHtml(h)}</option>`).join('');
                const opOpts = RULE_OPS.map(o => `<option value="${o.value}"${rule.op === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
                const colorDots = ROW_COLORS.map(c =>
                    `<div class="csv-color-dot${rule.color === c ? ' active' : ''}" data-color="${c}" data-rule="${i}"></div>`
                ).join('');
                const needsValue = rule.op !== 'empty';
                rulesHtml += `
                    <div class="color-rule-row" data-idx="${i}">
                        <select class="rule-col" data-idx="${i}">${colOpts}</select>
                        <select class="rule-op" data-idx="${i}">${opOpts}</select>
                        <input class="rule-val" data-idx="${i}" placeholder="value" value="${escHtml(rule.value || '')}" ${needsValue ? '' : 'style="display:none"'}>
                        <div class="rule-colors">${colorDots}</div>
                        <button class="rule-delete" data-idx="${i}" title="Delete">&times;</button>
                    </div>`;
            });

            overlay.innerHTML = `
                <div class="color-rules-modal">
                    <h3>Color Rules</h3>
                    <div class="color-rules-list">${rulesHtml || '<div class="color-rules-empty">No rules defined</div>'}</div>
                    <div class="color-rules-actions">
                        <button class="color-rules-add">+ Add Rule</button>
                        <button class="color-rules-reset-rules" title="Remove all rules">Reset Rules</button>
                    </div>
                    <div class="color-rules-buttons">
                        <button class="color-rules-cancel">Cancel</button>
                        <button class="color-rules-save">Save</button>
                    </div>
                </div>`;

            // Bind events
            overlay.querySelectorAll('.rule-col').forEach(sel => {
                sel.addEventListener('change', () => { rules[parseInt(sel.dataset.idx)].column = sel.value; });
            });
            overlay.querySelectorAll('.rule-op').forEach(sel => {
                sel.addEventListener('change', () => {
                    const idx = parseInt(sel.dataset.idx);
                    rules[idx].op = sel.value;
                    const valInput = overlay.querySelector(`.rule-val[data-idx="${idx}"]`);
                    valInput.style.display = sel.value === 'empty' ? 'none' : '';
                });
            });
            overlay.querySelectorAll('.rule-val').forEach(inp => {
                inp.addEventListener('input', () => { rules[parseInt(inp.dataset.idx)].value = inp.value; });
            });
            overlay.querySelectorAll('.csv-color-dot').forEach(dot => {
                dot.addEventListener('click', () => {
                    const idx = parseInt(dot.dataset.rule);
                    rules[idx].color = dot.dataset.color;
                    overlay.querySelectorAll(`.csv-color-dot[data-rule="${idx}"]`).forEach(d => d.classList.remove('active'));
                    dot.classList.add('active');
                });
            });
            overlay.querySelectorAll('.rule-delete').forEach(btn => {
                btn.addEventListener('click', () => {
                    rules.splice(parseInt(btn.dataset.idx), 1);
                    renderModal();
                });
            });
            overlay.querySelector('.color-rules-add').addEventListener('click', () => {
                rules.push({ column: headers[0] || '', op: 'equals', value: '', color: 'red' });
                renderModal();
            });
            overlay.querySelector('.color-rules-reset-rules').addEventListener('click', () => {
                if (confirm('Remove all color rules?')) {
                    rules = [];
                    renderModal();
                }
            });
            overlay.querySelector('.color-rules-cancel').addEventListener('click', () => overlay.remove());
            overlay.querySelector('.color-rules-save').addEventListener('click', () => {
                onSave(rules);
                overlay.remove();
            });
        }

        renderModal();
        document.body.appendChild(overlay);
    }

    // === CSV Viewer (read-only with sort, filter, color) ===
    function renderCsvViewer(content) {
        const rows = parseCsv(content);
        if (rows.length === 0) { previewBody.innerHTML = '<p style="padding:20px;color:var(--text-secondary);">Empty CSV</p>'; return; }

        // Keep csvEditRows in sync with the viewer's initial state so
        // getCurrentContent() can serialize even before editor mode is shown.
        csvEditRows = rows.map(r => [...r]);

        const headers = rows[0];
        let dataRows = rows.slice(1);
        let sortCol = -1, sortAsc = true;
        let filters = headers.map(() => '');
        const filePath = currentFileData ? currentFileData.path : '';

        // Load or compute initial column widths
        let colWidths = loadCsvColWidths(filePath);
        if (!colWidths || colWidths.length !== headers.length) {
            colWidths = headers.map(() => 150);
        }

        // Conditional color rules
        let colorRules = loadCsvColorRules(filePath) || [];
        // Checkbox columns
        const checkboxCols = loadCsvCheckboxCols(filePath) || [];

        // Color rules button handler
        currentCsvHeaders = headers;
        currentCsvRenderFn = function() { render(); };
        previewColorRules.onclick = () => {
            showColorRulesModal(filePath, headers, colorRules, (newRules) => {
                colorRules = newRules;
                saveCsvColorRules(filePath, colorRules);
                render();
            });
        };

        function render() {
            let filtered = dataRows.map((row, i) => ({ row, origIdx: i })).filter(({ row }) =>
                headers.every((_, ci) => {
                    if (!filters[ci]) return true;
                    return (row[ci] || '').toLowerCase().includes(filters[ci].toLowerCase());
                })
            );
            if (sortCol >= 0) {
                filtered.sort((a, b) => {
                    const va = a.row[sortCol] || '', vb = b.row[sortCol] || '';
                    // Pure numeric comparison only if both values are purely numeric
                    const na = Number(va), nb = Number(vb);
                    let cmp = (va.trim() !== '' && vb.trim() !== '' && !isNaN(na) && !isNaN(nb))
                        ? na - nb : va.localeCompare(vb);
                    return sortAsc ? cmp : -cmp;
                });
            }

            const totalW = colWidths.reduce((s, w) => s + w, 0);
            let html = `<div class="csv-viewer"><table class="csv-table" style="width:${totalW}px"><colgroup>`;
            headers.forEach((_, ci) => { html += `<col style="width:${colWidths[ci]}px">`; });
            html += '</colgroup><thead><tr>';
            headers.forEach((h, ci) => {
                const arrow = sortCol === ci ? (sortAsc ? ' &#9650;' : ' &#9660;') : '';
                html += `<th data-col="${ci}">${escHtml(h)}${arrow}<span class="csv-resize-handle" data-col="${ci}"></span></th>`;
            });
            html += '</tr><tr class="csv-filter-row">';
            headers.forEach((_, ci) => {
                html += `<th><input class="csv-filter" data-col="${ci}" placeholder="Filter..." value="${escHtml(filters[ci])}"></th>`;
            });
            html += '</tr></thead><tbody>';
            filtered.forEach(({ row, origIdx }) => {
                // Normalize checkbox column values for color rule matching
                checkboxCols.forEach(ci => {
                    if (ci < row.length) {
                        const v = (row[ci] || '').toLowerCase();
                        if (v !== 'true') row[ci] = 'false';
                    }
                });
                const color = getConditionalColor(row, headers, colorRules);
                const colorAttr = color && color !== 'none' ? ` data-color="${color}"` : '';
                html += `<tr${colorAttr} data-orig="${origIdx}">`;
                headers.forEach((_, ci) => {
                    const val = row[ci] || '';
                    if (checkboxCols.includes(ci)) {
                        const checked = val.toLowerCase() === 'true';
                        html += `<td class="csv-checkbox-cell"><input type="checkbox" class="csv-viewer-cb" data-orig="${origIdx}" data-col="${ci}"${checked ? ' checked' : ''}></td>`;
                    } else {
                        const num = parseFloat(val);
                        const cls = !isNaN(num) && val.trim() !== '' ? ' num' : '';
                        html += `<td class="${cls}"><span class="csv-cell-text">${escHtml(val)}</span><button class="csv-cell-copy" title="Copy">&#x2398;</button></td>`;
                    }
                });
                html += '</tr>';
            });
            html += '</tbody></table></div>';
            html += `<div class="csv-status">${filtered.length} of ${dataRows.length} rows</div>`;

            previewBody.innerHTML = html;

            // Bind sort (only on th text area, not resize handle)
            previewBody.querySelectorAll('.csv-table thead th[data-col]').forEach(th => {
                th.style.cursor = 'pointer';
                th.addEventListener('click', (e) => {
                    if (e.target.classList.contains('csv-resize-handle')) return;
                    const ci = parseInt(th.dataset.col);
                    if (sortCol === ci) sortAsc = !sortAsc;
                    else { sortCol = ci; sortAsc = true; }
                    render();
                });
            });
            // Bind filters
            previewBody.querySelectorAll('.csv-filter').forEach(input => {
                input.addEventListener('input', () => {
                    filters[parseInt(input.dataset.col)] = input.value;
                    render();
                });
            });
            // Bind column resize
            previewBody.querySelectorAll('.csv-resize-handle').forEach(handle => {
                handle.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const ci = parseInt(handle.dataset.col);
                    const startX = e.clientX;
                    const startW = colWidths[ci];
                    handle.classList.add('active');
                    const table = previewBody.querySelector('.csv-table');
                    const onMove = (me) => {
                        colWidths[ci] = Math.max(40, startW + me.clientX - startX);
                        const col = previewBody.querySelector(`col:nth-child(${ci + 1})`);
                        if (col) col.style.width = colWidths[ci] + 'px';
                        if (table) table.style.width = colWidths.reduce((s, w) => s + w, 0) + 'px';
                    };
                    const onUp = () => {
                        handle.classList.remove('active');
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        saveCsvColWidths(filePath, colWidths);
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
            });
            // Bind cell copy buttons
            previewBody.querySelectorAll('.csv-cell-copy').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const td = btn.parentElement;
                    const text = td.querySelector('.csv-cell-text').textContent;
                    navigator.clipboard.writeText(text).then(() => {
                        btn.classList.add('copied');
                        btn.innerHTML = '&#10003;';
                        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = '&#x2398;'; }, 1000);
                    });
                });
            });
            // Click a cell text → switch to inline editor (click-to-edit).
            // csvEditRows already mirrors the viewer state (including any
            // checkbox mutations), so we just re-serialize and hand off.
            previewBody.querySelectorAll('.csv-cell-text').forEach(span => {
                span.addEventListener('click', (e) => {
                    e.stopPropagation();
                    renderCsvEditor(csvStringify(csvEditRows));
                });
            });
            // Bind viewer checkboxes (interactive in view mode)
            previewBody.querySelectorAll('.csv-viewer-cb').forEach(cb => {
                cb.addEventListener('change', () => {
                    const origIdx = parseInt(cb.dataset.orig);
                    const ci = parseInt(cb.dataset.col);
                    dataRows[origIdx][ci] = cb.checked ? 'true' : 'false';
                    // csvEditRows is the serialization source of truth — keep
                    // it in sync with the viewer's local dataRows so the
                    // auto-save pipeline can pick up the change.
                    csvEditRows = [headers, ...dataRows].map(r => [...r]);
                    scheduleSave();
                    render();
                });
            });
        }
        render();
    }

    // === CSV Editor (editable table with row/col add/delete) ===
    let csvEditRows = [];
    let csvContextEl = null;

    function showCsvContextMenu(x, y, rowIdx, colIdx) {
        hideCsvContextMenu();
        csvContextEl = document.createElement('div');
        csvContextEl.className = 'finder-context';
        csvContextEl.style.left = x + 'px';
        csvContextEl.style.top = y + 'px';
        const actions = [];
        if (csvEditRows.length > 1) {
            actions.push({ label: 'Delete Row', cls: 'danger', action: () => {
                csvEditRows.splice(rowIdx, 1);
                scheduleSave();
                renderCsvEditTable();
            }});
        }
        if (csvEditRows[0].length > 1) {
            actions.push({ label: 'Delete Column', cls: 'danger', action: () => {
                csvEditRows.forEach(r => r.splice(colIdx, 1));
                // Update checkbox cols
                const filePath = currentFileData ? currentFileData.path : '';
                let cbCols = loadCsvCheckboxCols(filePath);
                if (cbCols) {
                    cbCols = cbCols.filter(c => c !== colIdx).map(c => c > colIdx ? c - 1 : c);
                    saveCsvCheckboxCols(filePath, cbCols);
                }
                scheduleSave();
                renderCsvEditTable();
            }});
        }
        actions.forEach(({ label, cls, action }) => {
            const el = document.createElement('div');
            el.className = 'finder-context-item' + (cls ? ' ' + cls : '');
            el.textContent = label;
            el.addEventListener('click', () => { hideCsvContextMenu(); action(); });
            csvContextEl.appendChild(el);
        });
        document.body.appendChild(csvContextEl);
        const rect = csvContextEl.getBoundingClientRect();
        if (rect.right > window.innerWidth) csvContextEl.style.left = (x - rect.width) + 'px';
        if (rect.bottom > window.innerHeight) csvContextEl.style.top = (y - rect.height) + 'px';
    }
    function hideCsvContextMenu() {
        if (csvContextEl) { csvContextEl.remove(); csvContextEl = null; }
    }
    document.addEventListener('click', hideCsvContextMenu);

    function renderCsvEditor(content) {
        csvEditRows = parseCsv(content);
        if (csvEditRows.length === 0) csvEditRows = [['']];
        renderCsvEditTable();
    }

    function renderCsvEditTable() {
        // Save scroll position before re-render
        const oldScroll = previewBody.querySelector('.csv-edit-scroll');
        const scrollTop = oldScroll ? oldScroll.scrollTop : 0;
        const scrollLeft = oldScroll ? oldScroll.scrollLeft : 0;

        const rows = csvEditRows;
        const maxCols = Math.max(...rows.map(r => r.length));
        // Normalize column count
        rows.forEach(r => { while (r.length < maxCols) r.push(''); });

        const filePath = currentFileData ? currentFileData.path : '';
        let colWidths = loadCsvColWidths(filePath);
        if (!colWidths || colWidths.length !== maxCols) {
            colWidths = new Array(maxCols).fill(150);
        }
        let checkboxCols = loadCsvCheckboxCols(filePath) || [];

        let html = '<div class="csv-editor"><div class="csv-edit-toolbar">';
        html += '<button class="csv-edit-btn" id="csvAddRow">+ Row</button>';
        html += '<button class="csv-edit-btn" id="csvAddCol">+ Column</button>';
        html += '</div>';
        const totalW = 36 + colWidths.reduce((s, w) => s + w, 0);
        html += `<div class="csv-edit-scroll"><table class="csv-table csv-edit-table" style="width:${totalW}px"><colgroup>`;
        html += '<col style="width:36px">';
        for (let ci = 0; ci < maxCols; ci++) { html += `<col style="width:${colWidths[ci]}px">`; }
        // Column drag handle + checkbox toggle row at top
        html += '</colgroup><thead><tr class="csv-col-drag-row"><td></td>';
        for (let ci = 0; ci < maxCols; ci++) {
            const isCb = checkboxCols.includes(ci);
            html += `<td class="csv-col-actions"><span class="csv-drag-handle csv-col-drag" data-col="${ci}" title="Drag to reorder">&#8801;</span><button class="csv-cb-toggle${isCb ? ' active' : ''}" data-col="${ci}" title="Toggle checkbox column">&#9745;</button></td>`;
        }
        html += '</tr></thead><tbody>';
        rows.forEach((row, ri) => {
            html += '<tr>';
            html += `<td class="csv-row-actions"><span class="csv-drag-handle csv-row-drag" data-row="${ri}" title="Drag to reorder">&#9776;</span></td>`;
            row.forEach((cell, ci) => {
                const isHeader = ri === 0 ? ' csv-header-cell' : '';
                const resizer = ri === 0 ? `<span class="csv-resize-handle" data-col="${ci}"></span>` : '';
                if (checkboxCols.includes(ci) && ri > 0) {
                    const checked = cell.toLowerCase() === 'true';
                    html += `<td class="csv-cell csv-checkbox-cell" data-row="${ri}" data-col="${ci}"><input type="checkbox" class="csv-checkbox" data-row="${ri}" data-col="${ci}"${checked ? ' checked' : ''}></td>`;
                } else {
                    html += `<td class="csv-cell${isHeader}" contenteditable="true" data-row="${ri}" data-col="${ci}">${escHtml(cell)}${resizer}</td>`;
                }
            });
            html += '</tr>';
        });
        html += '</tbody></table></div></div>';

        previewBody.innerHTML = html;

        // Restore scroll position
        const newScroll = previewBody.querySelector('.csv-edit-scroll');
        if (newScroll) { newScroll.scrollTop = scrollTop; newScroll.scrollLeft = scrollLeft; }

        // Bind cell edits
        previewBody.querySelectorAll('.csv-cell').forEach(td => {
            td.addEventListener('blur', () => {
                const ri = parseInt(td.dataset.row), ci = parseInt(td.dataset.col);
                const newVal = td.textContent;
                if (csvEditRows[ri][ci] !== newVal) {
                    csvEditRows[ri][ci] = newVal;
                    scheduleSave();
                }
            });
            td.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    td.blur();
                }
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const ri = parseInt(td.dataset.row), ci = parseInt(td.dataset.col);
                    const next = e.shiftKey
                        ? previewBody.querySelector(`.csv-cell[data-row="${ci > 0 ? ri : ri - 1}"][data-col="${ci > 0 ? ci - 1 : csvEditRows[0].length - 1}"]`)
                        : previewBody.querySelector(`.csv-cell[data-row="${ci < csvEditRows[0].length - 1 ? ri : ri + 1}"][data-col="${ci < csvEditRows[0].length - 1 ? ci + 1 : 0}"]`);
                    if (next) { td.blur(); next.focus(); }
                }
            });
        });

        // Add row
        document.getElementById('csvAddRow').addEventListener('click', () => {
            csvEditRows.push(new Array(csvEditRows[0].length).fill(''));
            scheduleSave();
            renderCsvEditTable();
        });
        // Add column
        document.getElementById('csvAddCol').addEventListener('click', () => {
            csvEditRows.forEach(r => r.push(''));
            scheduleSave();
            renderCsvEditTable();
        });
        // Right-click context menu for delete
        previewBody.querySelectorAll('.csv-cell').forEach(td => {
            td.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showCsvContextMenu(e.clientX, e.clientY, parseInt(td.dataset.row), parseInt(td.dataset.col));
            });
        });
        // Checkbox column toggle
        previewBody.querySelectorAll('.csv-cb-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const ci = parseInt(btn.dataset.col);
                // Sync cells first
                previewBody.querySelectorAll('.csv-cell[contenteditable]').forEach(td => {
                    csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
                });
                const headerName = csvEditRows[0][ci] || '';
                if (checkboxCols.includes(ci)) {
                    checkboxCols = checkboxCols.filter(c => c !== ci);
                    // Remove default color rules for this checkbox column
                    let rules = loadCsvColorRules(filePath) || [];
                    rules = rules.filter(r => !(r.column === headerName && r._checkbox));
                    saveCsvColorRules(filePath, rules);
                } else {
                    checkboxCols.push(ci);
                    // Initialize all non-header cells to "false"
                    for (let ri = 1; ri < csvEditRows.length; ri++) {
                        csvEditRows[ri][ci] = 'false';
                    }
                    // Add default color rules: checked → red, unchecked → none
                    let rules = loadCsvColorRules(filePath) || [];
                    rules.push({ column: headerName, op: 'equals', value: 'true', color: 'red', _checkbox: true });
                    rules.push({ column: headerName, op: 'equals', value: 'false', color: 'none', _checkbox: true });
                    saveCsvColorRules(filePath, rules);
                }
                saveCsvCheckboxCols(filePath, checkboxCols);
                scheduleSave();
                renderCsvEditTable();
            });
        });
        // Checkbox change
        previewBody.querySelectorAll('.csv-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const ri = parseInt(cb.dataset.row), ci = parseInt(cb.dataset.col);
                csvEditRows[ri][ci] = cb.checked ? 'true' : 'false';
                scheduleSave();
            });
        });
        // Drag to reorder rows
        previewBody.querySelectorAll('.csv-row-drag').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                // Sync cells
                previewBody.querySelectorAll('.csv-cell').forEach(td => {
                    csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
                });
                const fromIdx = parseInt(handle.dataset.row);
                const table = previewBody.querySelector('.csv-edit-table');
                const tbody = table.querySelector('tbody');
                const allRows = Array.from(tbody.querySelectorAll('tr')).filter(tr => !tr.classList.contains('csv-col-actions-row'));
                const dragRow = allRows[fromIdx];
                if (!dragRow) return;

                dragRow.classList.add('csv-dragging');
                let toIdx = fromIdx;

                const onMove = (me) => {
                    allRows.forEach((tr, i) => {
                        tr.classList.remove('csv-drag-over-top', 'csv-drag-over-bottom');
                        const rect = tr.getBoundingClientRect();
                        const midY = rect.top + rect.height / 2;
                        if (me.clientY >= rect.top && me.clientY < rect.bottom) {
                            toIdx = me.clientY < midY ? i : i;
                            if (i !== fromIdx) {
                                tr.classList.add(me.clientY < midY ? 'csv-drag-over-top' : 'csv-drag-over-bottom');
                            }
                        }
                    });
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    allRows.forEach(tr => tr.classList.remove('csv-dragging', 'csv-drag-over-top', 'csv-drag-over-bottom'));
                    if (toIdx !== fromIdx) {
                        const [moved] = csvEditRows.splice(fromIdx, 1);
                        csvEditRows.splice(toIdx, 0, moved);
                        scheduleSave();
                        renderCsvEditTable();
                    }
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
        // Drag to reorder columns
        previewBody.querySelectorAll('.csv-col-drag').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                // Sync cells
                previewBody.querySelectorAll('.csv-cell').forEach(td => {
                    csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
                });
                const fromIdx = parseInt(handle.dataset.col);
                const table = previewBody.querySelector('.csv-edit-table');
                // Get header cells for column position detection
                const headerRow = table.querySelector('tbody tr');
                const headerCells = Array.from(headerRow.querySelectorAll('.csv-cell'));
                let toIdx = fromIdx;

                // Highlight column
                const highlightCol = (ci, cls) => {
                    table.querySelectorAll(`td.csv-cell[data-col="${ci}"]`).forEach(td => td.classList.add(cls));
                };
                const clearHighlights = () => {
                    table.querySelectorAll('.csv-drag-over-left, .csv-drag-over-right, .csv-col-dragging').forEach(td =>
                        td.classList.remove('csv-drag-over-left', 'csv-drag-over-right', 'csv-col-dragging'));
                };
                highlightCol(fromIdx, 'csv-col-dragging');

                const onMove = (me) => {
                    clearHighlights();
                    highlightCol(fromIdx, 'csv-col-dragging');
                    headerCells.forEach((cell, i) => {
                        const rect = cell.getBoundingClientRect();
                        if (me.clientX >= rect.left && me.clientX < rect.right) {
                            toIdx = i;
                            if (i !== fromIdx) {
                                const cls = me.clientX < rect.left + rect.width / 2 ? 'csv-drag-over-left' : 'csv-drag-over-right';
                                highlightCol(i, cls);
                            }
                        }
                    });
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    clearHighlights();
                    if (toIdx !== fromIdx) {
                        csvEditRows.forEach(r => {
                            const [moved] = r.splice(fromIdx, 1);
                            r.splice(toIdx, 0, moved);
                        });
                        scheduleSave();
                        renderCsvEditTable();
                    }
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
        // Column resize in editor
        previewBody.querySelectorAll('.csv-edit-table .csv-resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const ci = parseInt(handle.dataset.col);
                const startX = e.clientX;
                const startW = colWidths[ci];
                handle.classList.add('active');
                const table = previewBody.querySelector('.csv-edit-table');
                const onMove = (me) => {
                    colWidths[ci] = Math.max(40, startW + me.clientX - startX);
                    const col = previewBody.querySelector(`.csv-edit-table col:nth-child(${ci + 2})`);
                    if (col) col.style.width = colWidths[ci] + 'px';
                    if (table) table.style.width = (36 + colWidths.reduce((s, w) => s + w, 0)) + 'px';
                };
                const onUp = () => {
                    handle.classList.remove('active');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    saveCsvColWidths(filePath, colWidths);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }

    function csvTableToString() {
        // Sync any focused cell (skip checkbox cells which store values via csvEditRows directly)
        previewBody.querySelectorAll('.csv-cell[contenteditable]').forEach(td => {
            csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
        });
        return csvStringify(csvEditRows);
    }

    // === URL hash navigation ===
    let navigatingBack = false;
    function syncHashToPath() {
        navigatingBack = true;
        const hash = decodeURIComponent(location.hash.slice(1));
        if (!hash) { loadFinderGrid(''); navigatingBack = false; return; }
        // Check if it looks like a file (has extension) → open preview in its parent folder
        const lastPart = hash.split('/').pop();
        if (lastPart.includes('.')) {
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
    loadTree();
    syncHashToPath();
})();
