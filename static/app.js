/* === Workspace Viewer App === */

(function () {
    const treeEl = document.getElementById('tree');
    const contentEl = document.getElementById('content');
    const sidebar = document.getElementById('sidebar');
    const divider = document.getElementById('divider');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarClose = document.getElementById('sidebarClose');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    // === Mobile sidebar toggle ===
    function isMobile() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    function openSidebar() {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('active');
    }

    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    }

    sidebarToggle.addEventListener('click', () => {
        sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
    sidebarClose.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

    // === Terminal button ===
    const terminalBtn = document.getElementById('terminalBtn');
    terminalBtn.addEventListener('click', () => {
        const base = window.__VIEWER_BASE || '/workspace-viewer';
        window.location.href = base + '/terminal';
    });

    // Configure marked
    marked.setOptions({
        gfm: true,
        breaks: true,
    });

    // === Sidebar resize ===
    let isResizing = false;
    divider.addEventListener('mousedown', (e) => {
        isResizing = true;
        divider.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const width = Math.min(Math.max(e.clientX, 200), 480);
        sidebar.style.width = width + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            divider.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });

    // === Load tree (lazy) ===
    const fetchOpts = {
        headers: { 'ngrok-skip-browser-warning': '1' },
        credentials: 'same-origin',
    };

    async function fetchTreeLevel(dirPath) {
        const base = window.__VIEWER_BASE || '';
        const url = dirPath
            ? `${base}/api/tree?path=${encodeURIComponent(dirPath)}`
            : `${base}/api/tree`;
        const res = await fetch(url, fetchOpts);
        if (!res.ok) throw new Error('Failed to load tree');
        return res.json();
    }

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
                });

                dirEl.appendChild(label);
                dirEl.appendChild(children);
                parent.appendChild(dirEl);
            } else {
                const fileEl = document.createElement('div');
                fileEl.className = 'tree-item';
                fileEl.dataset.depth = depth;

                const icon = getFileIcon(item.name);
                fileEl.innerHTML = `<span class="icon">${icon}</span><span class="name">${escHtml(item.name)}</span>`;

                fileEl.addEventListener('click', () => {
                    document.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
                    fileEl.classList.add('active');
                    loadFile(item.path);
                    if (isMobile()) closeSidebar();
                });

                parent.appendChild(fileEl);
            }
        });
    }

    function getFileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const icons = {
            md: '&#128196;', markdown: '&#128196;',
            py: '&#128013;', js: '&#9881;',
            json: '&#128203;', yaml: '&#128203;', yml: '&#128203;',
            html: '&#127760;', css: '&#127912;',
            txt: '&#128196;', sh: '&#9881;',
        };
        return icons[ext] || '&#128196;';
    }

    // === Load file ===
    async function loadFile(path) {
        try {
            const base = window.__VIEWER_BASE || '';
            const res = await fetch(`${base}/api/file?path=${encodeURIComponent(path)}`, fetchOpts);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`HTTP ${res.status}: ${text.substring(0, 100)}`);
            }
            const data = await res.json();

            // Breadcrumb
            const parts = path.split('/');
            const breadcrumb = parts.map((p, i) => `<span>${escHtml(p)}</span>`).join(' / ');

            const isMarkdown = ['.md', '.markdown'].includes(data.extension);

            if (isMarkdown && typeof marked !== 'undefined') {
                const html = marked.parse(data.content);
                contentEl.innerHTML = `
                    <div class="breadcrumb">${breadcrumb}</div>
                    <div class="markdown-body">${html}</div>
                `;
                // Apply syntax highlighting to code blocks
                if (typeof hljs !== 'undefined') {
                    contentEl.querySelectorAll('pre code').forEach((block) => {
                        hljs.highlightElement(block);
                    });
                }
            } else {
                contentEl.innerHTML = `
                    <div class="breadcrumb">${breadcrumb}</div>
                    <pre class="file-raw">${escHtml(data.content)}</pre>
                `;
            }
        } catch (err) {
            contentEl.innerHTML = `<div class="welcome"><p>Error: ${escHtml(err.message)}</p></div>`;
            console.error('loadFile error:', err);
        }
    }

    function escHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // === Init ===
    loadTree();
})();
