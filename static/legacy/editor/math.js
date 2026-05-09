/* === Claude Notebook — editor/math.js ===
 *
 * Block-level math via KaTeX (lazy-loaded from CDN on first use).
 * The block stores `data-tex` so reloads can re-render via KaTeX, and
 * the markdown serializer in editor/markdown.js round-trips the same
 * `<div class="math-block" data-tex="...">$$...$$</div>` shape.
 */

import { closestBlock, placeCaretAtStart } from './markdown.js';
import { scheduleSave } from './auto-save.js';

let _katexLoading = null;

function loadKatex() {
    if (typeof window.katex !== 'undefined') return Promise.resolve();
    if (_katexLoading) return _katexLoading;
    _katexLoading = new Promise((resolve) => {
        const css = document.createElement('link');
        css.rel  = 'stylesheet';
        css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
        document.head.appendChild(css);

        const script = document.createElement('script');
        script.src     = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
        script.onload  = () => resolve();
        script.onerror = () => resolve(); // fail gracefully
        document.head.appendChild(script);
    });
    return _katexLoading;
}

function renderMathBlock(wrap) {
    const tex = wrap.getAttribute('data-tex') || '';
    if (typeof window.katex !== 'undefined') {
        try {
            wrap.innerHTML = '';
            window.katex.render(tex, wrap, { throwOnError: false, displayMode: true });
            return;
        } catch {}
    }
    wrap.textContent = '$$ ' + tex + ' $$';
}

export async function insertMathBlock(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
    if (!block) return;
    const tex = prompt('LaTeX 수식을 입력하세요:', '');
    if (tex == null) return;
    await loadKatex();

    const wrap = document.createElement('div');
    wrap.className = 'math-block';
    wrap.setAttribute('contenteditable', 'false');
    wrap.setAttribute('data-tex', tex);
    renderMathBlock(wrap);
    wrap.addEventListener('click', () => {
        const next = prompt('LaTeX 수식 수정:', wrap.getAttribute('data-tex') || '');
        if (next != null) {
            wrap.setAttribute('data-tex', next);
            renderMathBlock(wrap);
            scheduleSave();
        }
    });
    block.replaceWith(wrap);

    // Ensure a paragraph after so the user can keep typing
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    wrap.after(p);
    placeCaretAtStart(p);
    scheduleSave();
}

/** Find unrendered math nodes and render them — called after file load
 *  so blocks that came from disk pick up a proper KaTeX render. */
export async function rehydrateMathBlocks(editor) {
    const blocks  = editor.querySelectorAll('.math-block[data-tex]');
    const inlines = editor.querySelectorAll('.math-inline[data-tex]');
    if (blocks.length === 0 && inlines.length === 0) return;
    await loadKatex();

    blocks.forEach(b => {
        if (!b.getAttribute('contenteditable')) b.setAttribute('contenteditable', 'false');
        renderMathBlock(b);
        b.addEventListener('click', () => {
            const next = prompt('LaTeX 수식 수정:', b.getAttribute('data-tex') || '');
            if (next != null) {
                b.setAttribute('data-tex', next);
                renderMathBlock(b);
                scheduleSave();
            }
        });
    });
    inlines.forEach(sp => {
        if (!sp.getAttribute('contenteditable')) sp.setAttribute('contenteditable', 'false');
        const tex = sp.getAttribute('data-tex') || '';
        try {
            sp.innerHTML = '';
            window.katex.render(tex, sp, { throwOnError: false, displayMode: false });
        } catch { sp.textContent = '$' + tex + '$'; }
    });
}
