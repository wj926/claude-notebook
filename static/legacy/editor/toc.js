/* === Claude Notebook — editor/toc.js ===
 *
 * Table-of-Contents block: scans the editor for h1–h3 headings, builds
 * a linked list, and serializes back as inline HTML so reloads keep
 * the structure intact. Click handlers are re-bound on file load via
 * `rehydrateTOCBlocks()` (event listeners aren't serialized).
 */

import { closestBlock, placeCaretAtStart } from './markdown.js';
import { scheduleSave } from './auto-save.js';

function buildTOCElement(editor) {
    const wrap = document.createElement('div');
    wrap.className = 'toc-block';
    wrap.setAttribute('contenteditable', 'false');

    const title = document.createElement('div');
    title.className = 'toc-title';
    title.textContent = '목차';
    wrap.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'toc-list';
    const headings = editor.querySelectorAll('h1, h2, h3');
    headings.forEach((h, i) => {
        const id = h.id || ('toc-h-' + i);
        h.id = id;
        const li = document.createElement('li');
        li.className = 'toc-level-' + h.tagName.toLowerCase();
        const a = document.createElement('a');
        a.textContent = h.textContent || '(제목 없음)';
        a.href = '#' + id;
        a.addEventListener('click', (e) => {
            e.preventDefault();
            h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        li.appendChild(a);
        list.appendChild(li);
    });
    if (headings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'toc-empty';
        empty.textContent = '제목이 없습니다. H1~H3 헤딩을 추가한 뒤 /toc 를 다시 실행하세요.';
        wrap.appendChild(empty);
    } else {
        wrap.appendChild(list);
    }
    return wrap;
}

export function insertTOC(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
    if (!block) return;

    const toc = buildTOCElement(editor);
    block.replaceWith(toc);

    // Blank paragraph after for further typing
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    toc.after(p);
    placeCaretAtStart(p);
    scheduleSave();
}

/** Re-bind click handlers for any TOC blocks that came from the saved
 *  file (event listeners aren't serialized). */
export function rehydrateTOCBlocks(editor) {
    editor.querySelectorAll('.toc-block').forEach(b => {
        if (!b.getAttribute('contenteditable')) b.setAttribute('contenteditable', 'false');
        b.querySelectorAll('a[href^="#"]').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const id = a.getAttribute('href').slice(1);
                const target = editor.querySelector('#' + CSS.escape(id));
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    });
}
