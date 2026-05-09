/* === Claude Notebook — ui/finder.js ===
 *
 * The Finder pane: grid / detail view, multi-select with Ctrl/Shift,
 * Windows-style rubber-band drag selection, sort-by-column header,
 * directory breadcrumb, click-to-open / directory navigation, plus
 * the right-click context menu (single + multi) that delegates to
 * ui/file-ops.js.
 *
 * Owns its own selection state and view mode. Forward dependency on
 * "open a file's preview" is injected through initFinder({openFile}).
 */

import { fetchTreeLevel } from '../core/api.js';
import { escHtml, getFileIcon, fileTypeLabel, formatMtime, formatFileSize } from '../core/utils.js';
import {
    downloadFile,
    downloadPaths,
    deleteItem  as deleteItemApi,
    deletePaths,
    renameItem  as renameItemApi,
} from './file-ops.js';
import { loadTree } from './tree.js';

const finder           = document.getElementById('finder');
const finderGrid       = document.getElementById('finderGrid');
const finderEmpty      = document.getElementById('finderEmpty');
const finderBreadcrumb = document.getElementById('finderBreadcrumb');

let onOpenFile = (_path) => {};
let onNavigate = (_path) => {};

let currentFinderPath = '';
let selectedPaths     = new Set();
let lastClickedIndex  = -1;
let currentItems      = [];
let _rubberBandUsed   = false;

let viewMode       = localStorage.getItem('finderViewMode') || 'grid'; // 'grid' | 'detail'
let detailSortKey  = 'name';
let detailSortDesc = false;

// ---------- Selection ----------

export function clearSelection() {
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

function deleteItem(item)  { return deleteItemApi(item, refreshWorkspaceViews); }
function renameItem(item)  { return renameItemApi(item, refreshWorkspaceViews); }

// ---------- Sort + render ----------

function sortItems(items) {
    const dirFirst = (a, b) => (a.type !== b.type) ? (a.type === 'directory' ? -1 : 1) : 0;
    items.sort((a, b) => {
        const d = dirFirst(a, b);
        if (d !== 0) return d;
        let cmp = 0;
        if      (detailSortKey === 'name')  cmp = a.name.localeCompare(b.name);
        else if (detailSortKey === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0);
        else if (detailSortKey === 'size')  cmp = (a.size  || 0) - (b.size  || 0);
        else if (detailSortKey === 'type')  cmp = fileTypeLabel(a).localeCompare(fileTypeLabel(b));
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
            const end   = Math.max(lastClickedIndex, idx);
            const rows  = finderGrid.children;
            for (let i = start; i <= end; i++) {
                selectedPaths.add(currentItems[i].path);
                if (rows[i]) rows[i].classList.add('selected');
            }
            updateSelectionBar();
        } else {
            if (selectedPaths.size > 0) { clearSelection(); return; }
            if (item.type === 'directory') loadFinderGrid(item.path);
            else                           onOpenFile(item.path);
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
        el.dataset.path  = item.path;
        el.dataset.type  = item.type;
        el.dataset.name  = item.name;
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
        <div class="fd-col fd-col-name"  data-sort="name">이름${arrow('name')}</div>
        <div class="fd-col fd-col-mtime" data-sort="mtime">수정한 날짜${arrow('mtime')}</div>
        <div class="fd-col fd-col-type"  data-sort="type">유형${arrow('type')}</div>
        <div class="fd-col fd-col-size"  data-sort="size">크기${arrow('size')}</div>
    </div>`;
    finderGrid.innerHTML = html;
    items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'finder-item finder-detail-row';
        row.dataset.path  = item.path;
        row.dataset.type  = item.type;
        row.dataset.name  = item.name;
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
    finderGrid.querySelectorAll('.finder-detail-header .fd-col[data-sort]').forEach(col => {
        col.addEventListener('click', () => {
            const key = col.dataset.sort;
            if (detailSortKey === key) detailSortDesc = !detailSortDesc;
            else { detailSortKey = key; detailSortDesc = false; }
            loadFinderGrid(currentFinderPath);
        });
    });
}

export async function loadFinderGrid(dirPath) {
    currentFinderPath = dirPath || '';
    onNavigate(currentFinderPath);
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
            else                       renderGridView(items);
        }
        updateFinderBreadcrumb(dirPath);
    } catch (err) {
        finderGrid.innerHTML = `<div style="padding:20px;color:var(--text-secondary);">Error: ${escHtml(err.message)}</div>`;
    }
}

export function getCurrentDir() { return currentFinderPath; }

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

// ---------- View toggle ----------

function setupViewToggle() {
    const btn = document.getElementById('viewToggleBtn');
    if (!btn) return;
    const iconGrid = document.getElementById('viewToggleIconGrid');
    const iconList = document.getElementById('viewToggleIconList');
    const updateIcon = () => {
        if (viewMode === 'grid') {
            iconGrid.style.display = 'none';
            iconList.style.display = '';
            btn.title = '자세히 보기';
        } else {
            iconGrid.style.display = '';
            iconList.style.display = 'none';
            btn.title = '큰 아이콘 보기';
        }
    };
    updateIcon();
    btn.addEventListener('click', () => {
        viewMode = viewMode === 'grid' ? 'detail' : 'grid';
        localStorage.setItem('finderViewMode', viewMode);
        updateIcon();
        loadFinderGrid(currentFinderPath);
    });
}

// ---------- Rubber-band drag selection ----------

function setupRubberBand() {
    const rbEl = document.createElement('div');
    rbEl.className = 'rubber-band';
    rbEl.style.display = 'none';
    finder.style.position = 'relative';
    finder.appendChild(rbEl);

    let rbActive = false;
    let rbStartX = 0, rbStartY = 0;
    const rectsIntersect = (a, b) =>
        !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);

    finder.addEventListener('mousedown', (e) => {
        if (e.target.closest('.finder-item, .finder-btn, .finder-toolbar, .selection-bar, label, input, button')) return;
        if (e.button !== 0) return;
        rbActive = true;
        _rubberBandUsed = false;
        const finderRect = finder.getBoundingClientRect();
        rbStartX = e.clientX - finderRect.left + finder.scrollLeft;
        rbStartY = e.clientY - finderRect.top  + finder.scrollTop;
        rbEl.style.left   = rbStartX + 'px';
        rbEl.style.top    = rbStartY + 'px';
        rbEl.style.width  = '0';
        rbEl.style.height = '0';
        rbEl.style.display = 'block';
        if (!e.ctrlKey && !e.metaKey) clearSelection();
    });

    document.addEventListener('mousemove', (e) => {
        if (!rbActive) return;
        const finderRect = finder.getBoundingClientRect();
        const curX = e.clientX - finderRect.left + finder.scrollLeft;
        const curY = e.clientY - finderRect.top  + finder.scrollTop;
        const x = Math.min(rbStartX, curX);
        const y = Math.min(rbStartY, curY);
        const w = Math.abs(curX - rbStartX);
        const h = Math.abs(curY - rbStartY);
        rbEl.style.left = x + 'px';
        rbEl.style.top  = y + 'px';
        rbEl.style.width  = w + 'px';
        rbEl.style.height = h + 'px';

        if (w > 4 || h > 4) {
            _rubberBandUsed = true;
            const bandRect = {
                left:   x + finderRect.left  - finder.scrollLeft,
                top:    y + finderRect.top   - finder.scrollTop,
                right:  x + w + finderRect.left  - finder.scrollLeft,
                bottom: y + h + finderRect.top   - finder.scrollTop,
            };
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
        if (_rubberBandUsed) setTimeout(() => { _rubberBandUsed = false; }, 10);
    });
}

// ---------- Context menu ----------

let contextEl = null;

function buildContextMenu(x, y, actions) {
    hideContextMenu();
    contextEl = document.createElement('div');
    contextEl.className = 'finder-context';
    contextEl.style.left = x + 'px';
    contextEl.style.top  = y + 'px';
    actions.forEach(({ label, cls, action }) => {
        const el = document.createElement('div');
        el.className = 'finder-context-item' + (cls ? ' ' + cls : '');
        el.textContent = label;
        el.addEventListener('click', () => { hideContextMenu(); action(); });
        contextEl.appendChild(el);
    });
    document.body.appendChild(contextEl);
    const rect = contextEl.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  contextEl.style.left = (x - rect.width)  + 'px';
    if (rect.bottom > window.innerHeight) contextEl.style.top  = (y - rect.height) + 'px';
}

function showContextMenu(x, y, item) {
    buildContextMenu(x, y, [
        { label: '✏️ Rename',   action: () => renameItem(item) },
        { label: '📥 Download', action: () => downloadFile(item.path) },
        { label: '🗑 Delete',   cls: 'danger', action: () => deleteItem(item) },
    ]);
}

function showMultiContextMenu(x, y) {
    const count = selectedPaths.size;
    buildContextMenu(x, y, [
        { label: `📥 Download ${count} items`, action: () => downloadSelected() },
        { label: `🗑 Delete ${count} items`,   cls: 'danger', action: () => deleteSelected() },
    ]);
}

function hideContextMenu() {
    if (contextEl) { contextEl.remove(); contextEl = null; }
}

// ---------- Init ----------

export function initFinder(deps) {
    if (deps && deps.openFile)   onOpenFile = deps.openFile;
    if (deps && deps.onNavigate) onNavigate = deps.onNavigate;
    setupViewToggle();
    setupRubberBand();
    document.addEventListener('click', hideContextMenu);
}
