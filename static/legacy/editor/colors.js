/* === Claude Notebook — editor/colors.js ===
 *
 * Notion-style 10-color palette for text and background. The picker is
 * a small floating panel anchored to the selection toolbar; selecting
 * a swatch wraps the current selection in a <span style="..."> that the
 * markdown serializer in editor/markdown.js preserves verbatim on
 * round-trips.
 */

import { scheduleSave } from './auto-save.js';

const NOTION_COLORS = [
    { key: 'default', label: '기본',  textVar: '',         bgVar: ''        },
    { key: 'gray',    label: '회색',  textVar: '#9b9a97',  bgVar: '#f1f1ef' },
    { key: 'brown',   label: '갈색',  textVar: '#64473a',  bgVar: '#f4eeee' },
    { key: 'orange',  label: '주황',  textVar: '#d9730d',  bgVar: '#faebdd' },
    { key: 'yellow',  label: '노랑',  textVar: '#dfab01',  bgVar: '#fbf3db' },
    { key: 'green',   label: '초록',  textVar: '#0f7b6c',  bgVar: '#ddedea' },
    { key: 'blue',    label: '파랑',  textVar: '#0b6e99',  bgVar: '#ddebf1' },
    { key: 'purple',  label: '보라',  textVar: '#6940a5',  bgVar: '#eae4f2' },
    { key: 'pink',    label: '분홍',  textVar: '#ad1a72',  bgVar: '#f4dfeb' },
    { key: 'red',     label: '빨강',  textVar: '#e03e3e',  bgVar: '#fbe4e4' },
];

let _lastColor = null;          // { mode: 'text'|'bg', colorKey }
let _colorPickerEl = null;

export function applyColorToSelection(mode, colorKey) {
    const def = NOTION_COLORS.find(c => c.key === colorKey);
    if (!def) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);

    if (colorKey === 'default') {
        document.execCommand('removeFormat');
        scheduleSave();
        return;
    }

    const el = document.createElement('span');
    if (mode === 'text') el.style.color = def.textVar;
    else                 el.style.backgroundColor = def.bgVar;
    try {
        el.appendChild(range.extractContents());
        range.insertNode(el);
        const s = window.getSelection();
        s.removeAllRanges();
        const r = document.createRange();
        r.selectNodeContents(el);
        s.addRange(r);
        _lastColor = { mode, colorKey };
        scheduleSave();
    } catch { /* range across blocks — skip */ }
}

export function applyLastColor() {
    if (!_lastColor) return;
    applyColorToSelection(_lastColor.mode, _lastColor.colorKey);
}

export function closeColorPicker() {
    if (_colorPickerEl) _colorPickerEl.remove();
    _colorPickerEl = null;
}

export function openColorPicker(anchorRect) {
    closeColorPicker();
    const el = document.createElement('div');
    el.className = 'color-picker';
    el.style.position = 'fixed';
    el.style.left = Math.round(anchorRect.left) + 'px';
    el.style.top  = Math.round(anchorRect.bottom + 6) + 'px';
    el.style.zIndex = '5300';

    const section = (title, mode) => {
        let html = `<div class="cp-section-title">${title}</div><div class="cp-swatches">`;
        NOTION_COLORS.forEach(c => {
            const style = mode === 'text'
                ? (c.textVar ? `color:${c.textVar};`      : '')
                : (c.bgVar   ? `background:${c.bgVar};`  : '');
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
    if (r.right  > window.innerWidth  - 8) el.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) el.style.top  = Math.round(anchorRect.top - r.height - 6) + 'px';

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
