/* === Claude Notebook — ui/sidebar.js ===
 *
 * Sidebar chrome: open/close (mobile drawer + desktop collapse), the
 * vertical divider's drag-to-resize, the theme toggle, and the
 * "open terminal" button. Pure DOM wiring — no app state.
 */

import { isMobile } from '../core/utils.js';

const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarClose = document.getElementById('sidebarClose');
const divider = document.getElementById('divider');

export function openSidebar() {
    sidebar.classList.add('open');
    sidebar.classList.remove('collapsed');
    sidebarOverlay.classList.add('active');
    sidebarOverlay.hidden = false;
    if (divider) divider.style.display = '';
}

export function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
    sidebarOverlay.hidden = true;
    if (!isMobile()) {
        sidebar.classList.add('collapsed');
        if (divider) divider.style.display = 'none';
    }
}

function wireToggle() {
    sidebarToggle.addEventListener('click', () => {
        if (isMobile()) {
            sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
        } else {
            sidebar.classList.contains('collapsed') ? openSidebar() : closeSidebar();
        }
    });
    sidebarClose.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);
}

function wireTerminalButton() {
    document.getElementById('terminalBtn').addEventListener('click', () => {
        window.location.href = (window.__VIEWER_BASE || '/claude-notebook') + '/terminal';
    });
}

// Theme: <head> boot script already set data-theme from localStorage / OS.
// Here we wire the click handler and keep tabs in sync via 'storage'.
function wireThemeToggle() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; };
    btn.addEventListener('click', () => {
        const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        try { localStorage.setItem('cn-theme', next); } catch (_) {}
    });
    window.addEventListener('storage', (e) => {
        if (e.key === 'cn-theme' && (e.newValue === 'dark' || e.newValue === 'light')) {
            applyTheme(e.newValue);
        }
    });
}

// Mouse drag on the divider resizes the sidebar within [200, 480]px.
function wireDividerResize() {
    let isResizing = false;
    divider.addEventListener('mousedown', () => {
        isResizing = true;
        divider.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        sidebar.style.width = Math.min(Math.max(e.clientX, 200), 480) + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        divider.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
}

/** Wire all sidebar-related event listeners. Call once on app startup. */
export function initSidebar() {
    wireToggle();
    wireTerminalButton();
    wireThemeToggle();
    wireDividerResize();
}
