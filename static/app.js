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
        } else if (TIMETABLE_EXTS.includes(ext)) {
            content = JSON.stringify(_timetableData, null, 2);
        } else if (DATETABLE_EXTS.includes(ext)) {
            content = JSON.stringify(_datetableData, null, 2);
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
        const isSchedule = SCHEDULE_EXTS.includes(data.extension);
        previewBody.classList.toggle('csv-mode', isCsv);
        previewColorRules.style.display = isCsv ? '' : 'none';
        if (isCsv) {
            await loadCsvConfig();
            renderCsvViewer(data.content);
        } else if (TIMETABLE_EXTS.includes(data.extension)) {
            renderTimetable(data.content, data.path);
        } else if (DATETABLE_EXTS.includes(data.extension)) {
            renderDatetable(data.content, data.path);
        } else if (MD_EXTS.includes(data.extension) && typeof marked !== 'undefined') {
            previewBody.innerHTML = `<div class="markdown-body">${marked.parse(data.content)}</div>`;
            if (typeof hljs !== 'undefined') {
                previewBody.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
            }
        } else {
            previewBody.innerHTML = `<pre class="file-raw">${escHtml(data.content)}</pre>`;
        }
        // Schedule types: always show save button
        if (isSchedule) {
            previewSave.style.display = '';
            previewEdit.style.display = 'none';
        }
    }

    async function renderEditMode(data) {
        const isCsv = CSV_EXTS.includes(data.extension);
        previewBody.classList.toggle('csv-mode', isCsv);
        if (isCsv) {
            await loadCsvConfig();
            renderCsvEditor(data.content);
        } else if (SCHEDULE_EXTS.includes(data.extension)) {
            // Schedule types are always interactive, no separate edit mode
            renderPreviewMode(data);
            return;
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

            // File too large for inline preview — offer download
            if (data.too_large) {
                previewEdit.style.display = 'none';
                previewBody.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-secondary);">
                    <p style="font-size:48px;margin-bottom:12px;">📦</p>
                    <p><strong>${escHtml(data.name)}</strong></p>
                    <p style="margin:8px 0;">${formatSize(data.size)} — too large to preview</p>
                    <a href="${BASE}/api/download?path=${encodeURIComponent(path)}"
                       style="display:inline-block;margin-top:12px;padding:8px 20px;background:var(--accent);color:#fff;border-radius:6px;text-decoration:none;">Download</a>
                </div>`;
                return;
            }

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
            // Bind viewer checkboxes (interactive in view mode)
            previewBody.querySelectorAll('.csv-viewer-cb').forEach(cb => {
                cb.addEventListener('change', async () => {
                    const origIdx = parseInt(cb.dataset.orig);
                    const ci = parseInt(cb.dataset.col);
                    dataRows[origIdx][ci] = cb.checked ? 'true' : 'false';
                    // Rebuild full content and save
                    const allRows = [headers, ...dataRows];
                    const content = csvStringify(allRows);
                    try {
                        await fetch(`${BASE}/api/save`, mutFetchOpts({
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: filePath, content }),
                        }));
                    } catch (e) {}
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
                renderCsvEditTable();
            });
        });
        // Checkbox change
        previewBody.querySelectorAll('.csv-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const ri = parseInt(cb.dataset.row), ci = parseInt(cb.dataset.col);
                csvEditRows[ri][ci] = cb.checked ? 'true' : 'false';
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

    function renderTimetable(content, filePath) {
        try { _timetableData = JSON.parse(content); } catch { _timetableData = { people: [], schedule: {} }; }
        if (!_timetableData.people) _timetableData.people = [];
        if (!_timetableData.schedule) _timetableData.schedule = {};
        TT_DAYS.forEach(d => { if (!_timetableData.schedule[d]) _timetableData.schedule[d] = {}; });

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
        const totalCols = people.length * 7;
        html += '<div class="tt-scroll"><table class="tt-table">';
        // Header row 1: days
        html += '<thead><tr><th class="tt-time-col" rowspan="2">시간</th>';
        TT_DAY_LABELS.forEach(d => {
            html += `<th colspan="${people.length || 1}" class="tt-day-header">${d}</th>`;
        });
        html += '</tr>';
        // Header row 2: people per day
        html += '<tr>';
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

    function renderDatetable(content, filePath) {
        try { _datetableData = JSON.parse(content); } catch { _datetableData = { people: [], events: {} }; }
        if (!_datetableData.people) _datetableData.people = [];
        if (!_datetableData.events) _datetableData.events = {};

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

        // Month navigation
        html += '<div class="dt-nav">';
        html += `<button class="dt-nav-btn" id="dtPrev">◀</button>`;
        html += `<span class="dt-nav-title">${year}년 ${monthNames[month]}</span>`;
        html += `<button class="dt-nav-btn" id="dtNext">▶</button>`;
        html += '</div>';

        // Calendar grid
        html += '<div class="dt-grid">';
        const dowLabels = ['일','월','화','수','목','금','토'];
        dowLabels.forEach((d, i) => {
            const cls = i === 0 ? 'dt-dow dt-sun' : i === 6 ? 'dt-dow dt-sat' : 'dt-dow';
            html += `<div class="${cls}">${d}</div>`;
        });

        // Empty cells before first day
        for (let i = 0; i < startDow; i++) html += '<div class="dt-cell dt-empty"></div>';

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dow = (startDow + d - 1) % 7;
            const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
            let cls = 'dt-cell';
            if (dow === 0) cls += ' dt-sun';
            if (dow === 6) cls += ' dt-sat';
            if (isToday) cls += ' dt-today';

            const events = _datetableData.events[dateStr] || [];
            html += `<div class="${cls}" data-date="${dateStr}">`;
            html += `<div class="dt-date-num">${d}</div>`;
            html += '<div class="dt-events">';
            events.forEach((ev, ei) => {
                const person = people.find(p => p.name === ev.person);
                const color = person ? person.color : '#999';
                html += `<div class="dt-event" style="background:${color}20;border-left:3px solid ${color}" data-date="${dateStr}" data-eidx="${ei}">${escHtml(ev.person)}(${escHtml(ev.reason)})</div>`;
            });
            html += '</div></div>';
        }

        // Fill remaining cells
        const totalCells = startDow + daysInMonth;
        const remaining = (7 - totalCells % 7) % 7;
        for (let i = 0; i < remaining; i++) html += '<div class="dt-cell dt-empty"></div>';

        html += '</div></div>';
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
                // Remove events
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

        // Click date cell: add event
        previewBody.querySelectorAll('.dt-cell[data-date]').forEach(cell => {
            cell.addEventListener('click', (e) => {
                if (e.target.closest('.dt-event')) return; // don't trigger on event click
                const dateStr = cell.dataset.date;
                if (people.length === 0) { alert('먼저 인원을 추가하세요.'); return; }
                const personList = people.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
                const choice = prompt(`${dateStr}\n인원 번호를 선택하세요:\n${personList}`);
                if (!choice) return;
                const idx = parseInt(choice) - 1;
                if (idx < 0 || idx >= people.length) { alert('잘못된 번호입니다.'); return; }
                const reason = prompt(`${people[idx].name}의 사유를 입력하세요:`);
                if (reason === null) return;
                if (!_datetableData.events[dateStr]) _datetableData.events[dateStr] = [];
                _datetableData.events[dateStr].push({ person: people[idx].name, reason: reason.trim() || '' });
                renderDatetable(JSON.stringify(_datetableData), filePath);
            });
        });

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
