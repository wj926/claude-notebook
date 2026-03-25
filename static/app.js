/* === Workspace Viewer App — Finder + File Management === */

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

    // === Mobile sidebar ===
    function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
    function openSidebar() { sidebar.classList.add('open'); sidebarOverlay.classList.add('active'); }
    function closeSidebar() { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); }
    sidebarToggle.addEventListener('click', () => { sidebar.classList.contains('open') ? closeSidebar() : openSidebar(); });
    sidebarClose.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

    // === Terminal button ===
    document.getElementById('terminalBtn').addEventListener('click', () => {
        window.location.href = (window.__VIEWER_BASE || '/workspace-viewer') + '/terminal';
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
    async function fetchTreeLevel(dirPath) {
        const url = dirPath ? `${BASE}/api/tree?path=${encodeURIComponent(dirPath)}` : `${BASE}/api/tree`;
        const res = await fetch(url, fetchOpts);
        if (!res.ok) throw new Error('Failed to load tree');
        return res.json();
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

    // === Finder Grid ===
    async function loadFinderGrid(dirPath) {
        currentFinderPath = dirPath || '';
        try {
            const items = await fetchTreeLevel(dirPath);
            finderGrid.innerHTML = '';
            // Sort by name (folders first, then files)
            items.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            if (items.length === 0) {
                finderEmpty.style.display = '';
                finderGrid.style.display = 'none';
            } else {
                finderEmpty.style.display = 'none';
                finderGrid.style.display = '';
                items.forEach((item) => {
                    const el = document.createElement('div');
                    el.className = 'finder-item';
                    el.dataset.path = item.path;
                    el.dataset.type = item.type;
                    el.dataset.name = item.name;
                    const icon = item.type === 'directory' ? '📁' : getFileIcon(item.name);
                    el.innerHTML = `<div class="finder-item-icon">${icon}</div><div class="finder-item-name">${escHtml(item.name)}</div>`;
                    // Click: folder → navigate, file → preview
                    el.addEventListener('click', () => {
                        if (item.type === 'directory') {
                            loadFinderGrid(item.path);
                        } else {
                            openPreview(item.path);
                        }
                    });
                    // Right-click: context menu
                    el.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        showContextMenu(e.clientX, e.clientY, item);
                    });
                    finderGrid.appendChild(el);
                });
            }
            updateFinderBreadcrumb(dirPath);
        } catch (err) {
            finderGrid.innerHTML = `<div style="padding:20px;color:var(--text-secondary);">Error: ${escHtml(err.message)}</div>`;
        }
    }

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

    // === Context Menu ===
    let contextEl = null;
    function showContextMenu(x, y, item) {
        hideContextMenu();
        contextEl = document.createElement('div');
        contextEl.className = 'finder-context';
        contextEl.style.left = x + 'px';
        contextEl.style.top = y + 'px';
        const actions = [];
        if (item.type === 'file') {
            actions.push({ label: '📥 Download', action: () => downloadFile(item.path) });
        }
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
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = path.split('/').pop();
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

    // === Upload ===
    finderUpload.addEventListener('change', async () => {
        const files = finderUpload.files;
        if (!files.length) return;
        await uploadFiles(files, currentFinderPath);
        finderUpload.value = '';
    });

    async function uploadFiles(files, targetDir) {
        const form = new FormData();
        for (const f of files) form.append('file', f, f.name);
        try {
            const url = `${BASE}/api/upload?dir=${encodeURIComponent(targetDir || '')}`;
            const res = await fetch(url, mutFetchOpts({ method: 'POST', body: form }));
            if (!res.ok) throw new Error(await res.text());
            loadFinderGrid(currentFinderPath);
            loadTree();
        } catch (err) {
            alert('Upload failed: ' + err.message);
        }
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
        if (e.dataTransfer.files.length) {
            await uploadFiles(e.dataTransfer.files, currentFinderPath);
        }
    });

    // === Preview Overlay ===
    function openPreview(path) {
        currentPreviewPath = path;
        previewOverlay.classList.add('active');
        finder.style.display = 'none';
        loadPreviewContent(path);
    }

    function closePreviewFn() {
        previewOverlay.classList.remove('active');
        finder.style.display = '';
        previewBody.innerHTML = '';
        currentPreviewPath = '';
    }
    previewClose.addEventListener('click', closePreviewFn);
    previewDownload.addEventListener('click', () => { if (currentPreviewPath) downloadFile(currentPreviewPath); });

    async function loadPreviewContent(path) {
        try {
            const ext = '.' + path.split('.').pop().toLowerCase();
            const parts = path.split('/');
            previewBreadcrumb.innerHTML = parts.map((p) => `<span>${escHtml(p)}</span>`).join(' / ');

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
            const isMarkdown = ['.md', '.markdown'].includes(data.extension);

            if (isMarkdown && typeof marked !== 'undefined') {
                previewBody.innerHTML = `<div class="markdown-body">${marked.parse(data.content)}</div>`;
                if (typeof hljs !== 'undefined') {
                    previewBody.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
                }
            } else {
                previewBody.innerHTML = `<pre class="file-raw">${escHtml(data.content)}</pre>`;
            }
        } catch (err) {
            previewBody.innerHTML = `<p style="padding:20px;color:var(--text-secondary);">Error: ${escHtml(err.message)}</p>`;
        }
    }

    // === Init ===
    loadTree();
    loadFinderGrid('');
})();
