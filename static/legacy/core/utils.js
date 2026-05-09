/* === Claude Notebook — core/utils.js ===
 *
 * Pure-ish helpers: HTML escaping, file-icon lookup, path resolution,
 * size/time formatting, viewport detection. No app state, no globals
 * beyond what is imported from core/api.js.
 */

import { apiRawUrl } from './api.js';

// ---------- HTML / DOM ----------

/** Escape arbitrary text so it is safe to inject as HTML. */
export function escHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

// ---------- File-type metadata ----------

// File-type icons. Two flavours:
//   - emoji string for media / generic file types
//   - inline SVG string for office documents so PDF / Word / Excel /
//     PowerPoint look like their actual brand glyphs (color + letter)
//     instead of indistinguishable books.
// Both flavours render via `<span>${icon}</span>` (innerHTML), so the
// tree/finder code doesn't need to know the difference.

const officeBadge = (bg, label, fontSize = 8) => (
    `<svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"` +
    ` style="display:block;border-radius:3px;">` +
    `<rect width="24" height="24" rx="3" fill="${bg}"/>` +
    `<text x="12" y="${12 + fontSize / 2.5}" text-anchor="middle" fill="#fff"` +
    ` font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif"` +
    ` font-size="${fontSize}" font-weight="800" letter-spacing="-0.3">${label}</text>` +
    `</svg>`
);

// Brand colors (official-ish):
//   PDF   = #D93025 (Adobe red)
//   Word  = #185ABD (MS blue)
//   Excel = #107C41 (MS green)
//   PPT   = #C43E1C (MS orange-red)
const ICON_PDF   = officeBadge('#D93025', 'PDF', 7);
const ICON_WORD  = officeBadge('#185ABD', 'W',  12);
const ICON_EXCEL = officeBadge('#107C41', 'X',  12);
const ICON_PPT   = officeBadge('#C43E1C', 'P',  12);

export const FILE_ICONS = {
    // Text / markup
    md: '📄', markdown: '📄', txt: '📄', log: '📜',
    // Code
    py: '🐍', js: '⚙️', ts: '⚙️', jsx: '⚙️', tsx: '⚙️',
    sh: '⚙️', bash: '⚙️', zsh: '⚙️', fish: '⚙️',
    rb: '⚙️', go: '⚙️', rs: '⚙️', java: '⚙️', kt: '⚙️',
    c: '⚙️', cpp: '⚙️', h: '⚙️', hpp: '⚙️',
    php: '⚙️', swift: '⚙️',
    // Data / config
    json: '📋', yaml: '📋', yml: '📋', toml: '📋',
    cfg: '📋', ini: '📋', xml: '📋', env: '📋',
    csv: '📊', tsv: '📊',
    // Web
    html: '🌐', htm: '🌐', css: '🎨', scss: '🎨', sass: '🎨',
    // Office documents — branded SVG badges instead of color-coded books
    pdf:  ICON_PDF,
    docx: ICON_WORD,  doc: ICON_WORD,  odt: ICON_WORD,  rtf: ICON_WORD,
    xlsx: ICON_EXCEL, xls: ICON_EXCEL, ods: ICON_EXCEL,
    pptx: ICON_PPT,   ppt: ICON_PPT,   odp: ICON_PPT,   key: ICON_PPT,
    // Notebooks
    ipynb: '📓',
    // Custom file types this app understands
    timetable: '📅', datetable: '📅',
    // Images
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️',
    svg: '🖼️', bmp: '🖼️', ico: '🖼️', tiff: '🖼️', tif: '🖼️', heic: '🖼️',
    // Video
    mp4: '🎬', m4v: '🎬', mov: '🎬', webm: '🎬', mkv: '🎬',
    avi: '🎬', wmv: '🎬', flv: '🎬', ogv: '🎬',
    // Audio
    mp3: '🎵', wav: '🎵', m4a: '🎵', aac: '🎵', flac: '🎵',
    ogg: '🎵', oga: '🎵', opus: '🎵',
    // Archives
    zip: '📦', tar: '📦', gz: '📦', tgz: '📦',
    bz2: '📦', xz: '📦', '7z': '📦', rar: '📦',
    // Fonts
    ttf: '🔤', otf: '🔤', woff: '🔤', woff2: '🔤', eot: '🔤',
};

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'];

// Audio / video extensions served inline via /api/file?raw=1 with the
// correct Content-Type (see jupyter_ext MEDIA_CONTENT_TYPES).
export const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus'];
export const VIDEO_EXTS = ['.mp4', '.m4v', '.webm', '.ogv', '.mov'];

export function getFileIcon(name) {
    return FILE_ICONS[name.split('.').pop().toLowerCase()] || '📄';
}

export function fileTypeLabel(item) {
    if (item.type === 'directory') return '폴더';
    const ext = item.name.includes('.') ? item.name.split('.').pop().toLowerCase() : '';
    return ext ? ext.toUpperCase() + ' 파일' : '파일';
}

// ---------- Path resolution ----------

/** Resolve a relative path (as it appears in a markdown link/image)
 *  against a workspace-absolute directory. Returns the resolved
 *  workspace path, or null if the input is an external URL / hash / etc. */
export function resolveRelPath(relPath, fileDir) {
    if (!relPath) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(relPath)) return null; // http:, mailto:, data:
    if (relPath.startsWith('#') || relPath.startsWith('/')) return null;
    const parts = (fileDir ? fileDir.split('/') : []).filter(Boolean);
    const stripped = relPath.replace(/^\.\//, '');
    for (const seg of stripped.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { if (parts.length) parts.pop(); continue; }
        parts.push(seg);
    }
    return parts.join('/');
}

/** Walk a rendered markdown DOM and rewrite relative src/href on
 *  <img>, <audio>, <video>, <source>, <a> so they resolve to the
 *  workspace file API. Original values are stashed in data-*-original
 *  so domToMarkdown can round-trip the clean relative form back. */
export function rewriteRelativeMediaUrls(rootEl, fileDir) {
    if (!rootEl) return;
    rootEl.querySelectorAll('img[src], audio[src], video[src], source[src]').forEach((el) => {
        const src = el.getAttribute('src') || '';
        const resolved = resolveRelPath(src, fileDir);
        if (resolved == null) return;
        el.setAttribute('data-src-original', src);
        el.setAttribute('src', apiRawUrl(resolved));
    });
    rootEl.querySelectorAll('a[href]').forEach((el) => {
        const href = el.getAttribute('href') || '';
        const resolved = resolveRelPath(href, fileDir);
        if (resolved == null) return;
        el.setAttribute('data-href-original', href);
        el.setAttribute('data-workspace-path', resolved);
    });
}

// ---------- Viewport ----------

export function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
}

// ---------- Formatting ----------
//
// NOTE: three byte-formatters exist with subtly different rounding rules
// (KB-decimals especially). They are preserved verbatim for now —
// unifying them is a Phase 2 task once we can verify each call-site visually.

/** Finder / detail view formatter. */
export function formatFileSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Upload progress formatter — KB shown without decimals. */
export function formatSize(bytes) {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
}

/** Snapshot history formatter — caps at MB. */
export function formatByteSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatMtime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
