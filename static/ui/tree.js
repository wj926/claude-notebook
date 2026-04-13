/* === Claude Notebook — ui/tree.js ===
 *
 * Lazy-loaded sidebar tree. Each directory fetches its children only on
 * first expansion so big workspaces don't pay an upfront cost.
 *
 * Forward dependencies on app-level navigation (open a file's preview,
 * navigate the finder grid) are injected via `initTree({...})` so this
 * module stays free of app state.
 */

import { fetchTreeLevel } from '../core/api.js';
import { escHtml, getFileIcon, isMobile } from '../core/utils.js';
import { closeSidebar } from './sidebar.js';

const treeEl = document.getElementById('tree');

let onOpenFile = (_path) => {};
let onOpenDir = (_path) => {};

function renderTree(items, parent, depth) {
    items.forEach((item) => {
        if (item.type === 'directory') {
            renderDirectoryNode(item, parent, depth);
        } else {
            renderFileNode(item, parent, depth);
        }
    });
}

function renderDirectoryNode(item, parent, depth) {
    const dirEl = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'tree-item';
    label.dataset.depth = depth;
    label.innerHTML = `<span class="icon">&#9654;</span><span class="name">${escHtml(item.name)}</span>`;
    if (item.repo_url) label.appendChild(buildRepoLink(item.repo_url));

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
            } catch (_) {
                children.innerHTML = '<div class="tree-item" style="opacity:0.5">Error loading</div>';
            }
        }
        if (isOpen) onOpenDir(item.path);
    });
    dirEl.appendChild(label);
    dirEl.appendChild(children);
    parent.appendChild(dirEl);
}

function renderFileNode(item, parent, depth) {
    const fileEl = document.createElement('div');
    fileEl.className = 'tree-item';
    fileEl.dataset.depth = depth;
    fileEl.innerHTML = `<span class="icon">${getFileIcon(item.name)}</span><span class="name">${escHtml(item.name)}</span>`;
    fileEl.addEventListener('click', () => {
        document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'));
        fileEl.classList.add('active');
        onOpenFile(item.path);
        if (isMobile()) closeSidebar();
    });
    parent.appendChild(fileEl);
}

function buildRepoLink(repoUrl) {
    const repoLink = document.createElement('a');
    repoLink.href = repoUrl;
    repoLink.target = '_blank';
    repoLink.rel = 'noopener noreferrer';
    repoLink.className = 'repo-link';
    repoLink.title = repoUrl;
    repoLink.innerHTML = '<svg class="github-icon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
    repoLink.addEventListener('click', (e) => e.stopPropagation());
    return repoLink;
}

/** Fetch the workspace root and (re-)render the tree. */
export async function loadTree() {
    try {
        const data = await fetchTreeLevel('');
        treeEl.innerHTML = '';
        renderTree(data, treeEl, 0);
    } catch (_) {
        treeEl.innerHTML = '<div class="loading">Error loading files.</div>';
    }
}

/** Wire app-level callbacks. Must be called once before `loadTree()`. */
export function initTree({ openFile, openDir }) {
    if (typeof openFile === 'function') onOpenFile = openFile;
    if (typeof openDir === 'function') onOpenDir = openDir;
}
