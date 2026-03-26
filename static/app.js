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
    const previewEdit = document.getElementById('previewEdit');
    const previewSave = document.getElementById('previewSave');
    const previewColorRules = document.getElementById('previewColorRules');

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
    let isEditing = false;
    let currentFileData = null; // { path, content, extension }

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
        actions.push({ label: '✏️ Rename', action: () => renameItem(item) });
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
    finderUpload.addEventListener('change', async () => {
        const files = finderUpload.files;
        if (!files.length) return;
        const wrapped = Array.from(files).map((f) => ({ file: f, relativePath: f.name }));
        await uploadFiles(wrapped, currentFinderPath);
        finderUpload.value = '';
    });

    async function uploadFiles(filesWithPaths, targetDir) {
        const form = new FormData();
        for (const { file, relativePath } of filesWithPaths) {
            form.append('file', file, relativePath || file.name);
        }
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

    // Recursively collect files from a DataTransferItem entry
    function readEntryRecursive(entry) {
        return new Promise((resolve) => {
            if (entry.isFile) {
                entry.file((f) => resolve([{ file: f, relativePath: entry.fullPath.replace(/^\//, '') }]));
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const allEntries = [];
                const readBatch = () => {
                    reader.readEntries(async (entries) => {
                        if (entries.length === 0) {
                            const results = [];
                            for (const e of allEntries) {
                                results.push(...await readEntryRecursive(e));
                            }
                            resolve(results);
                        } else {
                            allEntries.push(...entries);
                            readBatch(); // readEntries may return partial results
                        }
                    });
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
            for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry();
                if (entry) allFiles.push(...await readEntryRecursive(entry));
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
    const EDITABLE_EXTS = ['.md', '.markdown', '.csv', '.txt', '.py', '.js', '.json', '.yaml', '.yml', '.html', '.css', '.sh', '.toml', '.cfg', '.ini', '.xml'];
    const CSV_EXTS = ['.csv'];
    const MD_EXTS = ['.md', '.markdown'];

    function openPreview(path) {
        currentPreviewPath = path;
        isEditing = false;
        currentFileData = null;
        previewOverlay.classList.add('active');
        finder.style.display = 'none';
        previewEdit.style.display = 'none';
        previewSave.style.display = 'none';
        previewColorRules.style.display = 'none';
        loadPreviewContent(path);
        updateHash(path);
        const fileName = path.split('/').pop() || path;
        document.title = fileName + ' - Claude Notebook';
    }

    function closePreviewFn() {
        if (isEditing && !confirm('Discard unsaved changes?')) return;
        previewOverlay.classList.remove('active');
        previewBody.classList.remove('csv-mode');
        finder.style.display = '';
        previewBody.innerHTML = '';
        currentPreviewPath = '';
        isEditing = false;
        currentFileData = null;
        previewEdit.style.display = 'none';
        previewSave.style.display = 'none';
        previewColorRules.style.display = 'none';
        previewEdit.classList.remove('active');
        updateHash(currentPath);
        const folderName = currentPath.split('/').pop() || 'Workspace';
        document.title = folderName + ' - Claude Notebook';
    }
    previewClose.addEventListener('click', closePreviewFn);
    previewDownload.addEventListener('click', () => { if (currentPreviewPath) downloadFile(currentPreviewPath); });

    // Edit toggle
    previewEdit.addEventListener('click', () => {
        if (!currentFileData) return;
        if (isEditing) {
            // Switch back to preview
            isEditing = false;
            previewEdit.classList.remove('active');
            previewSave.style.display = 'none';
            const isCsv = CSV_EXTS.includes(currentFileData.extension);
            previewColorRules.style.display = isCsv ? '' : 'none';
            renderPreviewMode(currentFileData);
        } else {
            // Switch to edit
            isEditing = true;
            previewEdit.classList.add('active');
            previewSave.style.display = '';
            previewColorRules.style.display = 'none';
            renderEditMode(currentFileData);
        }
    });

    // Save
    previewSave.addEventListener('click', async () => {
        if (!currentFileData) return;
        let content;
        const ext = currentFileData.extension;
        if (CSV_EXTS.includes(ext)) {
            content = csvTableToString();
        } else {
            const ta = previewBody.querySelector('.edit-textarea');
            if (!ta) return;
            content = ta.value;
        }
        try {
            const res = await fetch(`${BASE}/api/save`, mutFetchOpts({
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
                body: JSON.stringify({ path: currentFileData.path, content }),
            }));
            if (!res.ok) throw new Error(await res.text());
            currentFileData.content = content;
            isEditing = false;
            previewEdit.classList.remove('active');
            previewSave.style.display = 'none';
            renderPreviewMode(currentFileData);
        } catch (err) {
            alert('Save failed: ' + err.message);
        }
    });

    async function renderPreviewMode(data) {
        const isCsv = CSV_EXTS.includes(data.extension);
        previewBody.classList.toggle('csv-mode', isCsv);
        previewColorRules.style.display = isCsv ? '' : 'none';
        if (isCsv) {
            await loadCsvConfig();
            renderCsvViewer(data.content);
        } else if (MD_EXTS.includes(data.extension) && typeof marked !== 'undefined') {
            previewBody.innerHTML = `<div class="markdown-body">${marked.parse(data.content)}</div>`;
            if (typeof hljs !== 'undefined') {
                previewBody.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
            }
        } else {
            previewBody.innerHTML = `<pre class="file-raw">${escHtml(data.content)}</pre>`;
        }
    }

    async function renderEditMode(data) {
        const isCsv = CSV_EXTS.includes(data.extension);
        previewBody.classList.toggle('csv-mode', isCsv);
        if (isCsv) {
            await loadCsvConfig();
            renderCsvEditor(data.content);
        } else {
            previewBody.innerHTML = `<textarea class="edit-textarea" spellcheck="false">${escHtml(data.content)}</textarea>`;
            const ta = previewBody.querySelector('.edit-textarea');
            ta.focus();
            // Tab key support
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = ta.selectionStart;
                    ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(ta.selectionEnd);
                    ta.selectionStart = ta.selectionEnd = start + 4;
                }
            });
        }
    }

    async function loadPreviewContent(path) {
        try {
            const ext = '.' + path.split('.').pop().toLowerCase();
            const parts = path.split('/');
            previewBreadcrumb.innerHTML = parts.map((p) => `<span>${escHtml(p)}</span>`).join(' / ');

            if (IMAGE_EXTS.includes(ext)) {
                previewEdit.style.display = 'none';
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

            // Show edit button for editable files
            if (EDITABLE_EXTS.includes(data.extension)) {
                previewEdit.style.display = '';
            } else {
                previewEdit.style.display = 'none';
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

    function showColorRulesModal(filePath, headers, rowColors, colorRules, onSave) {
        let rules = JSON.parse(JSON.stringify(colorRules || []));
        const overlay = document.createElement('div');
        overlay.className = 'color-rules-overlay';

        function renderModal() {
            let rulesHtml = '';
            rules.forEach((rule, i) => {
                const colOpts = headers.map(h => `<option value="${escHtml(h)}"${rule.column === h ? ' selected' : ''}>${escHtml(h)}</option>`).join('');
                const opOpts = RULE_OPS.map(o => `<option value="${o.value}"${rule.op === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
                const colorDots = ROW_COLORS.filter(c => c !== 'none').map(c =>
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
                        <div class="color-rules-reset-group">
                            <button class="color-rules-reset-manual" title="Reset manual row colors">Reset Manual Colors</button>
                            <button class="color-rules-reset-rules" title="Remove all rules">Reset Rules</button>
                        </div>
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
            overlay.querySelector('.color-rules-reset-manual').addEventListener('click', () => {
                if (confirm('Reset all manual row colors?')) {
                    saveCsvRowColors(filePath, {});
                    onSave(rules, true);
                    overlay.remove();
                }
            });
            overlay.querySelector('.color-rules-reset-rules').addEventListener('click', () => {
                if (confirm('Remove all color rules?')) {
                    rules = [];
                    renderModal();
                }
            });
            overlay.querySelector('.color-rules-cancel').addEventListener('click', () => overlay.remove());
            overlay.querySelector('.color-rules-save').addEventListener('click', () => {
                onSave(rules, false);
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

        // Row colors (keyed by original row index)
        let rowColors = loadCsvRowColors(filePath) || {};
        // Conditional color rules
        let colorRules = loadCsvColorRules(filePath) || [];

        // Color rules button handler
        currentCsvHeaders = headers;
        currentCsvRenderFn = function() { render(); };
        previewColorRules.onclick = () => {
            showColorRulesModal(filePath, headers, rowColors, colorRules, (newRules, resetManual) => {
                colorRules = newRules;
                saveCsvColorRules(filePath, colorRules);
                if (resetManual) rowColors = {};
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
                    const na = parseFloat(va), nb = parseFloat(vb);
                    let cmp = (!isNaN(na) && !isNaN(nb)) ? na - nb : va.localeCompare(vb);
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
                // Manual color takes priority over conditional color
                const manualColor = rowColors[origIdx] || '';
                const condColor = manualColor && manualColor !== 'none' ? '' : getConditionalColor(row, headers, colorRules);
                const color = (manualColor && manualColor !== 'none') ? manualColor : condColor;
                const colorAttr = color && color !== 'none' ? ` data-color="${color}"` : '';
                html += `<tr${colorAttr} data-orig="${origIdx}">`;
                headers.forEach((_, ci) => {
                    const val = row[ci] || '';
                    const num = parseFloat(val);
                    const cls = !isNaN(num) && val.trim() !== '' ? ' num' : '';
                    const colorBtn = ci === 0 ? '<button class="csv-row-color" title="Color">&#9679;</button>' : '';
                    html += `<td class="${cls}">${colorBtn}<span class="csv-cell-text">${escHtml(val)}</span><button class="csv-cell-copy" title="Copy">&#x2398;</button></td>`;
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
            // Bind row color buttons
            previewBody.querySelectorAll('.csv-row-color').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Remove any existing menu
                    document.querySelectorAll('.csv-row-color-menu').forEach(m => m.remove());
                    const tr = btn.closest('tr');
                    const origIdx = parseInt(tr.dataset.orig);
                    const rect = btn.getBoundingClientRect();
                    const menu = document.createElement('div');
                    menu.className = 'csv-row-color-menu';
                    ROW_COLORS.forEach(c => {
                        const dot = document.createElement('div');
                        dot.className = 'csv-color-dot' + ((rowColors[origIdx] || 'none') === c ? ' active' : '');
                        dot.dataset.color = c;
                        dot.addEventListener('click', () => {
                            if (c === 'none') delete rowColors[origIdx];
                            else rowColors[origIdx] = c;
                            saveCsvRowColors(filePath, rowColors);
                            menu.remove();
                            render();
                        });
                        menu.appendChild(dot);
                    });
                    menu.style.left = rect.right + 4 + 'px';
                    menu.style.top = rect.top - 4 + 'px';
                    document.body.appendChild(menu);
                    const closeMenu = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeMenu); } };
                    setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
                });
            });
        }
        render();
    }

    // === CSV Editor (editable table with row/col add/delete) ===
    let csvEditRows = [];

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

        let html = '<div class="csv-editor"><div class="csv-edit-toolbar">';
        html += '<button class="csv-edit-btn" id="csvAddRow">+ Row</button>';
        html += '<button class="csv-edit-btn" id="csvAddCol">+ Column</button>';
        html += '</div>';
        const totalW = 36 + colWidths.reduce((s, w) => s + w, 0);
        html += `<div class="csv-edit-scroll"><table class="csv-table csv-edit-table" style="width:${totalW}px"><colgroup>`;
        html += '<col style="width:36px">';
        for (let ci = 0; ci < maxCols; ci++) { html += `<col style="width:${colWidths[ci]}px">`; }
        html += '</colgroup><tbody>';
        rows.forEach((row, ri) => {
            html += '<tr>';
            html += `<td class="csv-row-actions"><span class="csv-drag-handle csv-row-drag" data-row="${ri}" title="Drag to reorder">&#9776;</span><button class="csv-del-btn" data-row="${ri}" title="Delete row">&times;</button></td>`;
            row.forEach((cell, ci) => {
                const isHeader = ri === 0 ? ' csv-header-cell' : '';
                const resizer = ri === 0 ? `<span class="csv-resize-handle" data-col="${ci}"></span>` : '';
                html += `<td class="csv-cell${isHeader}" contenteditable="true" data-row="${ri}" data-col="${ci}">${escHtml(cell)}${resizer}</td>`;
            });
            html += '</tr>';
        });
        // Column delete row
        html += '<tr class="csv-col-actions-row"><td></td>';
        for (let ci = 0; ci < maxCols; ci++) {
            html += `<td class="csv-col-actions"><span class="csv-drag-handle csv-col-drag" data-col="${ci}" title="Drag to reorder">&#8801;</span><button class="csv-del-btn" data-col="${ci}" title="Delete column">&times;</button></td>`;
        }
        html += '</tr>';
        html += '</tbody></table></div></div>';

        previewBody.innerHTML = html;

        // Restore scroll position
        const newScroll = previewBody.querySelector('.csv-edit-scroll');
        if (newScroll) { newScroll.scrollTop = scrollTop; newScroll.scrollLeft = scrollLeft; }

        // Bind cell edits
        previewBody.querySelectorAll('.csv-cell').forEach(td => {
            td.addEventListener('blur', () => {
                const ri = parseInt(td.dataset.row), ci = parseInt(td.dataset.col);
                csvEditRows[ri][ci] = td.textContent;
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
            renderCsvEditTable();
        });
        // Add column
        document.getElementById('csvAddCol').addEventListener('click', () => {
            csvEditRows.forEach(r => r.push(''));
            renderCsvEditTable();
        });
        // Delete row
        previewBody.querySelectorAll('.csv-del-btn[data-row]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (csvEditRows.length <= 1) return;
                csvEditRows.splice(parseInt(btn.dataset.row), 1);
                renderCsvEditTable();
            });
        });
        // Delete column
        previewBody.querySelectorAll('.csv-del-btn[data-col]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (csvEditRows[0].length <= 1) return;
                const ci = parseInt(btn.dataset.col);
                csvEditRows.forEach(r => r.splice(ci, 1));
                renderCsvEditTable();
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
        // Sync any focused cell
        previewBody.querySelectorAll('.csv-cell').forEach(td => {
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
