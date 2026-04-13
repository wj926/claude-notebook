/* === Claude Notebook — editor/notion.js ===
 *
 * The Notion-style WYSIWYG markdown editor. This is the big one —
 * setupNotionEditor wires up every typing/selection interaction on a
 * contenteditable region that IS the rendered markdown: block-type
 * shortcuts (#/##/-/1./[]/```), inline live markdown (**bold** /
 * *italic* / `code` / ~~strike~~), auto-link on space, nested-list
 * Tab/Shift+Tab, Cmd+A two-stage selection, block-selection mode
 * (Escape), block conversion (Cmd+Option+N), focus mode,
 * markdown-view-mode toggle (rendered ↔ raw text), smart paste with
 * sanitization, selection toolbar, floating link input, block menu
 * (Cmd+/ or right-click), slash menu (`/`), emoji picker (`:`), and
 * the @ file-reference picker.
 *
 * Standalone block primitives (callout, math, TOC, code-lang-picker,
 * color picker, keyboard-help) live in their own files under editor/
 * and are imported here.
 */

import { BASE, fetchOpts, mutFetchOpts, apiRawUrl } from '../core/api.js';
import {
    escHtml,
    IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS,
    getFileIcon, isMobile,
} from '../core/utils.js';
import {
    BLOCK_TAGS,
    closestBlock,
    placeCaretAtStart,
    inlineToMd,
    domToMarkdown,
    sanitizePastedHtml,
} from './markdown.js';
import {
    scheduleSave,
    flushSave,
    cancelPendingSave,
    setSaveStatus,
    setSavedBaseline,
} from './auto-save.js';
import {
    applyColorToSelection,
    applyLastColor,
    openColorPicker,
    closeColorPicker,
} from './colors.js';
import { insertMathBlock, rehydrateMathBlocks } from './math.js';
import { insertTOC, rehydrateTOCBlocks } from './toc.js';
import { insertCallout } from './callout.js';
import { updateCodeLangIndicator, closeCodeLangPicker } from './code-lang.js';

const previewBody       = document.getElementById('previewBody');
const previewViewToggle = document.getElementById('previewViewToggle');

// App-level deps injected via initNotion() so the module can look up
// { path, content, extension } for the currently-open file and resolve
// the directory of that file (used by the @ mention picker).
let getFile    = () => null;
let getFileDir = () => '';

export function initNotion(deps) {
    if (deps.getFile)    getFile    = deps.getFile;
    if (deps.getFileDir) getFileDir = deps.getFileDir;
}

// ========================================================================
// Notion-style markdown editor
// ========================================================================
// The rendered .markdown-body IS the editor. Clicking anywhere puts the
// caret there. Typing "works", including Notion's markdown shortcuts
// (`#`, `##`, `-`, `1.`, `>`, `---`, `[]` + space) which transform the
// current block in place. Auto-save reads the DOM through the HTML →
// Markdown serializer in editor/markdown.js — there is no mode switch
// and no rendered ↔ source asymmetry.
//
// DOM ↔ Markdown conversion moved to editor/markdown.js:
//   BLOCK_TAGS, closestBlock, placeCaretAtStart, mediaTagToHtml,
//   inlineToMd, listToMd, tableToMd, blockToMd, domToMarkdown.

// ---- Markdown shortcut detection ----
// Patterns are matched against the block's leading text content when the
// user types a space. If any matches, we transform the block in place
// and strip the shortcut characters.
function detectBlockShortcut(text) {
    if (text === '# ') return { tag: 'h1' };
    if (text === '## ') return { tag: 'h2' };
    if (text === '### ') return { tag: 'h3' };
    if (text === '#### ') return { tag: 'h4' };
    if (text === '##### ') return { tag: 'h5' };
    if (text === '###### ') return { tag: 'h6' };
    if (text === '- ' || text === '* ' || text === '+ ') return { list: 'ul' };
    if (/^\d+\. $/.test(text)) return { list: 'ol' };
    if (text === '> ' || text === '" ') return { tag: 'blockquote' };
    if (text === '[] ' || text === '[ ] ') return { list: 'ul', task: false };
    if (text === '[x] ' || text === '[X] ') return { list: 'ul', task: true };
    if (text === '``` ') return { tag: 'pre' };
    return null;
}

/** Try to convert the current block based on its leading shortcut chars.
 *  Returns true if a transformation happened. */
function tryMarkdownShortcut(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const block = closestBlock(range.startContainer, editor);
    if (!block) return false;
    // Only trigger for top-level paragraphs that the user just typed into
    if (block.tagName.toLowerCase() !== 'p') return false;
    const text = block.textContent;
    const match = detectBlockShortcut(text);
    if (!match) return false;

    if (match.list) {
        const list = document.createElement(match.list);
        const li = document.createElement('li');
        if (match.task !== undefined) {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            if (match.task) cb.checked = true;
            li.appendChild(cb);
            li.appendChild(document.createTextNode(' '));
        }
        list.appendChild(li);
        block.replaceWith(list);
        placeCaretAtStart(li);
    } else if (match.tag === 'pre') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        pre.appendChild(code);
        block.replaceWith(pre);
        placeCaretAtStart(code);
    } else if (match.tag === 'blockquote') {
        const bq = document.createElement('blockquote');
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        bq.appendChild(p);
        block.replaceWith(bq);
        placeCaretAtStart(p);
    } else {
        const el = document.createElement(match.tag);
        block.replaceWith(el);
        placeCaretAtStart(el);
    }
    return true;
}

/** Handle `---` + Enter → horizontal rule, and Enter inside a heading
 *  creates a fresh paragraph below rather than a duplicate heading. */
function tryEnterBehavior(editor, e) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const block = closestBlock(range.startContainer, editor);
    if (!block) return false;

    // --- → <hr>
    if (block.tagName.toLowerCase() === 'p' && block.textContent === '---') {
        e.preventDefault();
        const hr = document.createElement('hr');
        const after = document.createElement('p');
        after.appendChild(document.createElement('br'));
        block.replaceWith(hr);
        hr.after(after);
        placeCaretAtStart(after);
        return true;
    }

    // Enter inside a heading → new <p> below
    const tag = block.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
        // If caret is at the end of the heading, create a p instead of splitting
        const atEnd = range.endOffset === (range.endContainer.nodeType === Node.TEXT_NODE
            ? range.endContainer.length
            : range.endContainer.childNodes.length);
        if (atEnd) {
            e.preventDefault();
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            block.after(p);
            placeCaretAtStart(p);
            return true;
        }
    }
    return false;
}

function wrapSelectionWithTag(tagName) {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const el = document.createElement(tagName);
    try {
        el.appendChild(range.extractContents());
        range.insertNode(el);
        sel.removeAllRanges();
        const r = document.createRange();
        r.selectNodeContents(el);
        sel.addRange(r);
    } catch { /* range crossed block boundaries — ignore */ }
}

// ========================================================================
// Notion parity Phase 1
//   • Slash menu (/)  — caret-based block picker
//   • Selection toolbar — floating format bar on text selection
//   • Block menu (Cmd+/, right-click) — caret/mouse-driven block ops
//   • Link input (Cmd+K) — floating URL input
//   • Cmd+Option+0..8 — quick block type shortcuts
//   • Cmd+U / Cmd+Shift+S — underline / strikethrough
//   • Cmd+D / Cmd+Shift+↑↓ — duplicate / move block
// ------------------------------------------------------------------------
// Everything is single-contenteditable friendly: no per-block hover
// overlays, no drag handles. All floating UI is positioned from caret or
// selection rects and tracks no block DOM structure.
// ========================================================================

/** Turn the given top-level block element into a different block type.
 *  Preserves content where possible. */
function convertBlockTo(editor, block, kind) {
    if (!block) return;
    const inner = block.innerHTML || '<br>';
    const text = block.textContent || '';

    // Special kinds that aren't single-tag swaps
    if (kind === 'ul' || kind === 'ol') {
        const list = document.createElement(kind);
        const li = document.createElement('li');
        li.innerHTML = inner === '<br>' ? '' : inner;
        list.appendChild(li);
        block.replaceWith(list);
        placeCaretAtStart(li);
        return list;
    }
    if (kind === 'todo') {
        const list = document.createElement('ul');
        const li = document.createElement('li');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        li.appendChild(cb);
        li.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.innerHTML = inner === '<br>' ? '' : inner;
        li.appendChild(span);
        list.appendChild(li);
        block.replaceWith(list);
        placeCaretAtStart(span);
        return list;
    }
    if (kind === 'toggle') {
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.innerHTML = inner === '<br>' ? '' : inner;
        details.appendChild(summary);
        const body = document.createElement('p');
        body.appendChild(document.createElement('br'));
        details.appendChild(body);
        block.replaceWith(details);
        placeCaretAtStart(summary);
        return details;
    }
    if (kind === 'callout') {
        const callout = document.createElement('div');
        callout.className = 'callout';
        callout.setAttribute('data-icon', '💡');
        const icon = document.createElement('span');
        icon.className = 'callout-icon';
        icon.setAttribute('contenteditable', 'false');
        icon.textContent = '💡';
        const content = document.createElement('div');
        content.className = 'callout-content';
        const inside = document.createElement('p');
        inside.innerHTML = inner === '<br>' ? '<br>' : inner;
        content.appendChild(inside);
        callout.appendChild(icon);
        callout.appendChild(content);
        block.replaceWith(callout);
        placeCaretAtStart(inside);
        return callout;
    }
    if (kind === 'pre') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = text;
        pre.appendChild(code);
        block.replaceWith(pre);
        placeCaretAtStart(code);
        return pre;
    }
    if (kind === 'hr') {
        const hr = document.createElement('hr');
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        block.replaceWith(hr);
        hr.after(p);
        placeCaretAtStart(p);
        return hr;
    }
    if (kind === 'math') {
        // Special: ask for LaTeX and render via KaTeX
        insertMathBlock(editor);
        return null;
    }
    if (kind === 'toc') {
        insertTOC(editor);
        return null;
    }
    // Simple tag swap (p, h1-h6, blockquote)
    const el = document.createElement(kind);
    el.innerHTML = inner === '<br>' ? '<br>' : inner;
    block.replaceWith(el);
    placeCaretAtStart(el);
    return el;
}

/** Convert the block the caret is currently inside. */
function convertCurrentBlock(editor, kind) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
    if (block) convertBlockTo(editor, block, kind);
}

// ==================== Inline live markdown ====================
// When the user types the CLOSING marker of an inline markdown pattern,
// detect the pair and swap it for the corresponding element. Runs only
// after non-IME single-character insertions so Korean composition isn't
// disrupted.
//
// Triggers (after typing the last character):
//   **text**   →  <strong>text</strong>
//   *text*     →  <em>text</em>          (not inside **...**)
//   `text`     →  <code>text</code>
//   ~~text~~   →  <del>text</del>

function isInsideTag(node, tagName) {
    let n = node;
    while (n) {
        if (n.nodeType === Node.ELEMENT_NODE && n.tagName && n.tagName.toLowerCase() === tagName) return true;
        n = n.parentNode;
    }
    return false;
}

/** Attempt inline markdown conversion at the current caret.
 *  Returns true if something was converted (and scheduleSave should fire). */
function tryInlineMarkdown(editor, lastChar) {
    if (!editor) return false;
    if (lastChar !== '*' && lastChar !== '`' && lastChar !== '~') return false;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return false;
    // Don't trigger inside code/pre
    if (isInsideTag(node, 'code') || isInsideTag(node, 'pre')) return false;

    const text = node.textContent;
    const offset = range.startOffset;
    if (offset === 0) return false;

    // Patterns, ordered so longer-marker variants win
    const patterns = [
        { close: '**', open: '**', tag: 'strong' },
        { close: '~~', open: '~~', tag: 'del' },
        { close: '`',  open: '`',  tag: 'code' },
        { close: '*',  open: '*',  tag: 'em' },
    ];

    for (const p of patterns) {
        const cl = p.close.length;
        if (offset < cl + 1) continue; // need at least "X*"
        if (text.slice(offset - cl, offset) !== p.close) continue;
        // Find the opening marker BEFORE the text body
        const searchEnd = offset - cl;
        let openIdx = -1;
        // Scan backwards
        for (let i = searchEnd - 1; i >= 0; i--) {
            if (text.slice(i, i + p.open.length) === p.open) {
                // Reject degenerate case: adjacent markers (e.g. "****")
                if (i + p.open.length >= searchEnd) continue;
                // Reject `*` matching middle of `**` (em inside strong)
                if (p.tag === 'em') {
                    if (text[i - 1] === '*' || text[i + 1] === '*') continue;
                    if (text[searchEnd - 1] === '*' || text[searchEnd] === '*') continue;
                }
                openIdx = i;
                break;
            }
        }
        if (openIdx === -1) continue;
        const bodyStart = openIdx + p.open.length;
        const bodyEnd = searchEnd;
        const body = text.slice(bodyStart, bodyEnd);
        if (!body) continue;
        if (body.startsWith(' ') || body.endsWith(' ')) continue; // whitespace edges kill the match

        // Build: before + <tag>body</tag> + after
        const before = text.slice(0, openIdx);
        const after = text.slice(offset);
        const parent = node.parentNode;

        const el = document.createElement(p.tag);
        el.textContent = body;
        const afterNode = document.createTextNode(after);

        // Replace the original text node with: before text + el + after text
        if (before) {
            node.textContent = before;
            parent.insertBefore(el, node.nextSibling);
            parent.insertBefore(afterNode, el.nextSibling);
        } else {
            parent.insertBefore(el, node);
            parent.insertBefore(afterNode, el.nextSibling);
            parent.removeChild(node);
        }

        // Place caret after the new element (inside `afterNode` at 0)
        const r = document.createRange();
        r.setStart(afterNode, 0);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return true;
    }
    return false;
}

// ==================== Nested list Tab / Shift+Tab ====================
/** Indent the current <li> by moving it into a sublist of the
 *  previous <li>. Returns true if handled. */
function tryIndentListItem(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    let node = sel.getRangeAt(0).startContainer;
    while (node && node !== editor) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') break;
        node = node.parentNode;
    }
    if (!node || node === editor || node.tagName !== 'LI') return false;
    const li = node;
    const prev = li.previousElementSibling;
    if (!prev || prev.tagName !== 'LI') return false; // nothing to nest under
    const parentList = li.parentNode; // <ul> or <ol>
    const listTag = parentList.tagName.toLowerCase();
    // Existing sublist on previous li? append to it. Otherwise create new.
    let sublist = Array.from(prev.children).find(c => c.tagName === 'UL' || c.tagName === 'OL');
    if (!sublist) {
        sublist = document.createElement(listTag);
        prev.appendChild(sublist);
    }
    sublist.appendChild(li);
    placeCaretAtStart(li);
    return true;
}

/** Outdent the current <li> — if it's inside a sublist, move it out
 *  after the parent <li>. Returns true if handled. */
function tryOutdentListItem(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    let node = sel.getRangeAt(0).startContainer;
    while (node && node !== editor) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') break;
        node = node.parentNode;
    }
    if (!node || node === editor || node.tagName !== 'LI') return false;
    const li = node;
    const parentList = li.parentNode;
    if (!parentList || (parentList.tagName !== 'UL' && parentList.tagName !== 'OL')) return false;
    const grandLi = parentList.parentNode;
    // Only outdent if we're actually in a nested list
    if (!grandLi || grandLi.tagName !== 'LI') return false;
    const grandList = grandLi.parentNode;
    if (!grandList || (grandList.tagName !== 'UL' && grandList.tagName !== 'OL')) return false;
    // Move any later siblings into a fresh sublist that travels with the li
    const laterSiblings = [];
    let sibling = li.nextElementSibling;
    while (sibling) {
        const next = sibling.nextElementSibling;
        laterSiblings.push(sibling);
        sibling = next;
    }
    if (laterSiblings.length) {
        const newSub = document.createElement(parentList.tagName);
        laterSiblings.forEach(s => newSub.appendChild(s));
        li.appendChild(newSub);
    }
    parentList.removeChild(li);
    // If the original parentList is now empty, remove it
    if (!parentList.firstElementChild) parentList.remove();
    // Insert li after grandLi
    grandLi.parentNode.insertBefore(li, grandLi.nextSibling);
    placeCaretAtStart(li);
    return true;
}

// Color picker moved to editor/colors.js

// ==================== Cmd+A two-stage select ====================
/** First press selects the current block's contents. Second press
 *  (when the current block is already fully selected) extends to the
 *  whole editor. */
function twoStageSelectAll(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const block = closestBlock(range.startContainer, editor);
    if (!block) {
        // Fall back to full editor
        const r = document.createRange();
        r.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
    }
    // Is the current block already fully selected?
    const fullBlockRange = document.createRange();
    fullBlockRange.selectNodeContents(block);
    const already =
        range.startContainer === fullBlockRange.startContainer &&
        range.startOffset === fullBlockRange.startOffset &&
        range.endContainer === fullBlockRange.endContainer &&
        range.endOffset === fullBlockRange.endOffset;
    // Loose check: compare string lengths (selection spans block contents)
    const selectedText = sel.toString();
    const blockText = block.textContent;
    const looseFull = selectedText.length > 0 && selectedText.length >= blockText.length;
    if (already || looseFull) {
        // Second press → select all blocks
        const r = document.createRange();
        r.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
    }
    // First press → select just the block
    sel.removeAllRanges();
    sel.addRange(fullBlockRange);
}

// ==================== Block selection mode (Esc) ====================
// Pressing Esc puts the editor in "block selected" state — the current
// block gets a visual outline, arrow keys navigate between blocks,
// Backspace/Delete removes the selected block, Enter returns to text
// editing, another Esc blurs.
let _selectedBlock = null;

function clearBlockSelection() {
    if (_selectedBlock) {
        _selectedBlock.classList.remove('block-selected');
        _selectedBlock = null;
    }
}
function selectBlock(block) {
    clearBlockSelection();
    if (!block) return;
    block.classList.add('block-selected');
    _selectedBlock = block;
    // Collapse text selection so only the block outline is visible
    const sel = window.getSelection();
    sel.removeAllRanges();
}
function enterBlockSelectionFromCaret(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
    if (!block) return false;
    selectBlock(block);
    return true;
}
/** Handle keydown while in block selection mode. Returns true if
 *  consumed. */
function handleBlockSelectionKey(editor, e) {
    if (!_selectedBlock) return false;
    if (e.key === 'Escape') {
        e.preventDefault();
        clearBlockSelection();
        editor.blur();
        return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = _selectedBlock.nextElementSibling;
        if (next && BLOCK_TAGS.has(next.tagName.toLowerCase())) selectBlock(next);
        return true;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const prev = _selectedBlock.previousElementSibling;
        if (prev && BLOCK_TAGS.has(prev.tagName.toLowerCase())) selectBlock(prev);
        return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const target = _selectedBlock;
        const next = target.nextElementSibling || target.previousElementSibling;
        target.remove();
        clearBlockSelection();
        if (next) placeCaretAtStart(next);
        scheduleSave();
        return true;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        const target = _selectedBlock;
        clearBlockSelection();
        placeCaretAtStart(target);
        return true;
    }
    // Any other key → exit block selection and let the key reach the editor
    clearBlockSelection();
    return false;
}

// ==================== Smart paste ====================
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** Handle paste event. Returns true if we handled it (so the default
 *  paste should be suppressed). */
function handlePaste(editor, e) {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return false;
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');

    // 1. Pasting a bare URL into a non-collapsed selection → link it
    if (text && URL_RE.test(text.trim())) {
        const sel = window.getSelection();
        if (sel.rangeCount && !sel.isCollapsed) {
            e.preventDefault();
            document.execCommand('createLink', false, text.trim());
            return true;
        }
        // Collapsed caret + URL → insert a clickable link
        if (sel.rangeCount && sel.isCollapsed) {
            e.preventDefault();
            const a = document.createElement('a');
            a.href = text.trim();
            a.textContent = text.trim();
            sel.getRangeAt(0).insertNode(a);
            // Move caret after the link
            const r = document.createRange();
            r.setStartAfter(a);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            return true;
        }
    }
    // 2. Rich HTML → sanitize and insert. We keep structural tags but
    //    strip all inline styles and dangerous attributes.
    if (html) {
        e.preventDefault();
        const sanitized = sanitizePastedHtml(html);
        if (sanitized) {
            document.execCommand('insertHTML', false, sanitized);
            return true;
        }
    }
    // 3. Fall through to plain text insert (existing behavior)
    if (text) {
        e.preventDefault();
        document.execCommand('insertText', false, text);
        return true;
    }
    return false;
}

// sanitizePastedHtml moved to editor/markdown.js

// Code-block language picker moved to editor/code-lang.js

// Math + TOC blocks moved to editor/math.js + editor/toc.js

// ==================== Auto-link on typing ====================
// When the user types a space or enter right after a URL, wrap the URL
// in an <a>. Pattern matches http(s)://, ftp://, www., and bare
// foo.bar.com style URLs when the whole "word" looks like a hostname.
const AUTO_URL_RE = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)$/i;

function tryAutoLink(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return false;
    // Don't trigger inside a link, code, or pre
    if (isInsideTag(node, 'a') || isInsideTag(node, 'code') || isInsideTag(node, 'pre')) return false;

    const text = node.textContent;
    const offset = range.startOffset;
    // Look at the characters just before the caret (up to the last space)
    const head = text.slice(0, offset);
    const match = head.match(AUTO_URL_RE);
    if (!match) return false;
    const url = match[1];
    // Avoid double-trigger on URLs already ending with punctuation that
    // shouldn't be part of the link (e.g. "see https://x.com.")
    const cleaned = url.replace(/[.,;:!?)\]}'"]+$/, '');
    if (!cleaned) return false;
    const start = head.length - url.length;
    const end = start + cleaned.length;

    // Build: [head-before][link][rest]
    const before = text.slice(0, start);
    const after = text.slice(end);
    const parent = node.parentNode;
    const a = document.createElement('a');
    a.href = cleaned.startsWith('www.') ? 'https://' + cleaned : cleaned;
    a.textContent = cleaned;

    const afterNode = document.createTextNode(after);
    if (before) {
        node.textContent = before;
        parent.insertBefore(a, node.nextSibling);
        parent.insertBefore(afterNode, a.nextSibling);
    } else {
        parent.insertBefore(a, node);
        parent.insertBefore(afterNode, a.nextSibling);
        parent.removeChild(node);
    }
    // Restore caret just after the link (before any trailing punctuation)
    const r = document.createRange();
    r.setStart(afterNode, 0);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
}

// ==================== Emoji shortcode ====================
// Type `:` to open a picker; filter by typing the emoji name.
// Subset of common emojis — ~150 entries, keyed by :name:
const EMOJIS = [
    { k: 'smile', c: '😊' }, { k: 'smiley', c: '😃' }, { k: 'laughing', c: '😆' },
    { k: 'grin', c: '😁' }, { k: 'wink', c: '😉' }, { k: 'heart_eyes', c: '😍' },
    { k: 'joy', c: '😂' }, { k: 'rofl', c: '🤣' }, { k: 'thinking', c: '🤔' },
    { k: 'neutral', c: '😐' }, { k: 'expressionless', c: '😑' }, { k: 'sleepy', c: '😪' },
    { k: 'sob', c: '😭' }, { k: 'cry', c: '😢' }, { k: 'angry', c: '😠' },
    { k: 'rage', c: '😡' }, { k: 'scream', c: '😱' }, { k: 'fear', c: '😨' },
    { k: 'sweat', c: '😓' }, { k: 'relieved', c: '😌' }, { k: 'tired', c: '😫' },
    { k: 'yawning', c: '🥱' }, { k: 'sunglasses', c: '😎' }, { k: 'nerd', c: '🤓' },
    { k: 'cool', c: '🆒' }, { k: 'heart', c: '❤️' }, { k: 'heart_red', c: '❤️' },
    { k: 'blue_heart', c: '💙' }, { k: 'green_heart', c: '💚' }, { k: 'yellow_heart', c: '💛' },
    { k: 'purple_heart', c: '💜' }, { k: 'orange_heart', c: '🧡' }, { k: 'black_heart', c: '🖤' },
    { k: 'sparkling_heart', c: '💖' }, { k: 'heartbeat', c: '💓' }, { k: 'broken_heart', c: '💔' },
    { k: 'thumbs_up', c: '👍' }, { k: '+1', c: '👍' }, { k: 'thumbs_down', c: '👎' },
    { k: '-1', c: '👎' }, { k: 'ok_hand', c: '👌' }, { k: 'clap', c: '👏' },
    { k: 'wave', c: '👋' }, { k: 'pray', c: '🙏' }, { k: 'muscle', c: '💪' },
    { k: 'fire', c: '🔥' }, { k: 'star', c: '⭐' }, { k: 'sparkles', c: '✨' },
    { k: 'zap', c: '⚡' }, { k: 'sun', c: '☀️' }, { k: 'cloud', c: '☁️' },
    { k: 'rain', c: '🌧️' }, { k: 'snowflake', c: '❄️' }, { k: 'rainbow', c: '🌈' },
    { k: 'moon', c: '🌙' }, { k: 'earth', c: '🌍' }, { k: 'rocket', c: '🚀' },
    { k: 'airplane', c: '✈️' }, { k: 'car', c: '🚗' }, { k: 'bike', c: '🚴' },
    { k: 'walk', c: '🚶' }, { k: 'run', c: '🏃' }, { k: 'house', c: '🏠' },
    { k: 'office', c: '🏢' }, { k: 'school', c: '🏫' }, { k: 'hospital', c: '🏥' },
    { k: 'bank', c: '🏦' }, { k: 'shop', c: '🏪' }, { k: 'phone', c: '📞' },
    { k: 'iphone', c: '📱' }, { k: 'computer', c: '💻' }, { k: 'desktop', c: '🖥️' },
    { k: 'keyboard', c: '⌨️' }, { k: 'mouse', c: '🖱️' }, { k: 'printer', c: '🖨️' },
    { k: 'camera', c: '📷' }, { k: 'video_camera', c: '📹' }, { k: 'tv', c: '📺' },
    { k: 'book', c: '📖' }, { k: 'books', c: '📚' }, { k: 'notebook', c: '📓' },
    { k: 'pencil', c: '✏️' }, { k: 'pen', c: '🖊️' }, { k: 'memo', c: '📝' },
    { k: 'page', c: '📄' }, { k: 'clipboard', c: '📋' }, { k: 'folder', c: '📁' },
    { k: 'file', c: '📃' }, { k: 'mailbox', c: '📬' }, { k: 'email', c: '📧' },
    { k: 'envelope', c: '✉️' }, { k: 'package', c: '📦' }, { k: 'lock', c: '🔒' },
    { k: 'unlock', c: '🔓' }, { k: 'key', c: '🔑' }, { k: 'bell', c: '🔔' },
    { k: 'mute', c: '🔕' }, { k: 'speaker', c: '🔊' }, { k: 'headphones', c: '🎧' },
    { k: 'microphone', c: '🎤' }, { k: 'music', c: '🎵' }, { k: 'guitar', c: '🎸' },
    { k: 'piano', c: '🎹' }, { k: 'drum', c: '🥁' }, { k: 'art', c: '🎨' },
    { k: 'clapper', c: '🎬' }, { k: 'game', c: '🎮' }, { k: 'dart', c: '🎯' },
    { k: 'trophy', c: '🏆' }, { k: 'medal', c: '🏅' }, { k: 'gold', c: '🥇' },
    { k: 'silver', c: '🥈' }, { k: 'bronze', c: '🥉' }, { k: 'soccer', c: '⚽' },
    { k: 'basketball', c: '🏀' }, { k: 'baseball', c: '⚾' }, { k: 'tennis', c: '🎾' },
    { k: 'coffee', c: '☕' }, { k: 'tea', c: '🍵' }, { k: 'beer', c: '🍺' },
    { k: 'wine', c: '🍷' }, { k: 'cocktail', c: '🍸' }, { k: 'pizza', c: '🍕' },
    { k: 'burger', c: '🍔' }, { k: 'fries', c: '🍟' }, { k: 'hotdog', c: '🌭' },
    { k: 'sushi', c: '🍣' }, { k: 'rice', c: '🍚' }, { k: 'ramen', c: '🍜' },
    { k: 'bread', c: '🍞' }, { k: 'cake', c: '🎂' }, { k: 'cookie', c: '🍪' },
    { k: 'apple', c: '🍎' }, { k: 'banana', c: '🍌' }, { k: 'grapes', c: '🍇' },
    { k: 'orange', c: '🍊' }, { k: 'strawberry', c: '🍓' }, { k: 'watermelon', c: '🍉' },
    { k: 'dog', c: '🐶' }, { k: 'cat', c: '🐱' }, { k: 'mouse_animal', c: '🐭' },
    { k: 'bear', c: '🐻' }, { k: 'panda', c: '🐼' }, { k: 'koala', c: '🐨' },
    { k: 'lion', c: '🦁' }, { k: 'tiger', c: '🐯' }, { k: 'cow', c: '🐮' },
    { k: 'pig', c: '🐷' }, { k: 'horse', c: '🐴' }, { k: 'fish', c: '🐟' },
    { k: 'check', c: '✅' }, { k: 'cross', c: '❌' }, { k: 'warning', c: '⚠️' },
    { k: 'info', c: 'ℹ️' }, { k: 'question', c: '❓' }, { k: 'exclamation', c: '❗' },
    { k: 'bulb', c: '💡' }, { k: 'hundred', c: '💯' }, { k: 'eyes', c: '👀' },
    { k: 'tada', c: '🎉' }, { k: 'gift', c: '🎁' }, { k: 'balloon', c: '🎈' },
];

let _emojiState = null; // { editor, block, anchorOffset, el, filter, index }

function openEmojiPicker(editor) {
    closeEmojiPicker();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'emoji-picker';
    el.style.position = 'fixed';
    el.style.left = Math.round(rect.left) + 'px';
    el.style.top = Math.round(rect.bottom + 6) + 'px';
    el.style.zIndex = '5000';
    document.body.appendChild(el);
    _emojiState = { editor, el, filter: '', index: 0 };
    renderEmojiPicker();
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
        el.style.top = Math.round(rect.top - r.height - 6) + 'px';
    }
}
function closeEmojiPicker() {
    if (_emojiState && _emojiState.el) _emojiState.el.remove();
    _emojiState = null;
}
function emojiFiltered() {
    if (!_emojiState) return [];
    const f = _emojiState.filter.toLowerCase();
    if (!f) return EMOJIS.slice(0, 20);
    return EMOJIS.filter(e => e.k.includes(f)).slice(0, 30);
}
function renderEmojiPicker() {
    if (!_emojiState) return;
    const items = emojiFiltered();
    if (_emojiState.index >= items.length) _emojiState.index = 0;
    _emojiState.el.innerHTML = items.length === 0
        ? '<div class="ep-empty">일치하는 이모지 없음</div>'
        : `<div class="ep-header">이모지${_emojiState.filter ? ' :' + escHtml(_emojiState.filter) : ''}</div>` +
          items.map((e, i) => `
            <div class="ep-item ${i === _emojiState.index ? 'active' : ''}" data-char="${escHtml(e.c)}">
                <span class="ep-char">${e.c}</span>
                <span class="ep-label">:${escHtml(e.k)}:</span>
            </div>
          `).join('');
    _emojiState.el.querySelectorAll('.ep-item').forEach((el, i) => {
        el.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            _emojiState.index = i;
            commitEmojiPicker();
        });
        el.addEventListener('mouseenter', () => {
            _emojiState.index = i;
            _emojiState.el.querySelectorAll('.ep-item').forEach(x => x.classList.remove('active'));
            el.classList.add('active');
        });
    });
}
function commitEmojiPicker() {
    if (!_emojiState) return;
    const items = emojiFiltered();
    const item = items[_emojiState.index];
    if (!item) { closeEmojiPicker(); return; }
    // Strip ":filter" from the block and insert the emoji
    const filter = _emojiState.filter;
    stripColonQueryFromCaret(filter);
    closeEmojiPicker();
    document.execCommand('insertText', false, item.c);
    scheduleSave();
}
function stripColonQueryFromCaret(filter) {
    // Delete the `:` + filter text that's immediately before the caret
    const toDelete = filter.length + 1;
    for (let i = 0; i < toDelete; i++) {
        document.execCommand('delete');
    }
}
function handleEmojiPickerKey(e) {
    if (!_emojiState) return false;
    if (e.key === 'Escape') { e.preventDefault(); closeEmojiPicker(); return true; }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = emojiFiltered();
        _emojiState.index = (_emojiState.index + 1) % Math.max(1, items.length);
        renderEmojiPicker();
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = emojiFiltered();
        _emojiState.index = (_emojiState.index - 1 + items.length) % Math.max(1, items.length);
        renderEmojiPicker();
        return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitEmojiPicker();
        return true;
    }
    return false;
}
function updateEmojiPickerFilter(editor) {
    if (!_emojiState) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) { closeEmojiPicker(); return; }
    const node = sel.getRangeAt(0).startContainer;
    if (node.nodeType !== Node.TEXT_NODE) { closeEmojiPicker(); return; }
    const head = node.textContent.slice(0, sel.getRangeAt(0).startOffset);
    const colonIdx = head.lastIndexOf(':');
    if (colonIdx === -1) { closeEmojiPicker(); return; }
    const after = head.slice(colonIdx + 1);
    if (after.includes(' ') || after.includes(':')) { closeEmojiPicker(); return; }
    if (after.length > 20) { closeEmojiPicker(); return; }
    _emojiState.filter = after;
    _emojiState.index = 0;
    renderEmojiPicker();
}

// ==================== @ file reference picker ====================
// Typing `@` in the markdown editor opens a picker listing files from the
// same folder as the currently-open file. Selecting one inserts:
//   • Image: `![name](filename)` — rendered inline via rewriteRelativeMediaUrls.
//   • Video: `<video src="filename" controls width="100%"></video>`.
//   • Audio: `<audio src="filename" controls></audio>`.
//   • Other: `[name](filename)` — a regular markdown link.
// The path stored in the .md source is the clean relative form (just the
// filename, since we only list same-folder files); rewriteRelativeMediaUrls
// resolves it to `/api/file?raw=1` at preview time.

function mentionCategoryFor(ext) {
    if (IMAGE_EXTS.includes(ext)) return 'image';
    if (VIDEO_EXTS.includes(ext)) return 'video';
    if (AUDIO_EXTS.includes(ext)) return 'audio';
    return 'other';
}
function mentionIconFor(cat) {
    if (cat === 'image') return '🖼';
    if (cat === 'video') return '🎬';
    if (cat === 'audio') return '🎵';
    return '📄';
}
function mentionInsertFor(cat, nameNoPath) {
    // nameNoPath is the filename only (same folder). Display label for
    // markdown links strips the extension to keep the source tidy.
    const label = nameNoPath.replace(/\.[^.]+$/, '') || nameNoPath;
    if (cat === 'image') return `![${label}](${nameNoPath})`;
    if (cat === 'video') return `<video src="${nameNoPath}" controls width="100%"></video>`;
    if (cat === 'audio') return `<audio src="${nameNoPath}" controls></audio>`;
    return `[${label}](${nameNoPath})`;
}

let _mentionState = null;
async function openMentionPicker(editor) {
    closeMentionPicker();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'mention-picker';
    el.style.position = 'fixed';
    el.style.left = Math.round(rect.left) + 'px';
    el.style.top = Math.round(rect.bottom + 6) + 'px';
    el.style.zIndex = '5000';
    document.body.appendChild(el);
    _mentionState = { editor, el, filter: '', index: 0, files: null, loading: true };
    renderMentionPicker();
    // Load the sibling files in the current folder. Deliberately scoped to
    // the same directory so the picker stays fast and the inserted path
    // stays a clean one-level reference.
    try {
        const dir = getFileDir();
        const items = await fetchTreeLevel(dir);
        // Skip the current file itself; only show files (not folders).
        const curName = getFile() && getFile().path
            ? getFile().path.split('/').pop()
            : '';
        const files = items
            .filter((it) => it.type === 'file' && it.name !== curName)
            .map((it) => {
                const ext = '.' + (it.name.split('.').pop() || '').toLowerCase();
                return { name: it.name, ext, category: mentionCategoryFor(ext) };
            });
        // Sort: media first (so the main use case surfaces), then alpha.
        const rank = { image: 0, video: 0, audio: 0, other: 1 };
        files.sort((a, b) => (rank[a.category] - rank[b.category]) || a.name.localeCompare(b.name));
        if (!_mentionState) return; // picker was closed while loading
        _mentionState.files = files;
        _mentionState.loading = false;
        renderMentionPicker();
    } catch (err) {
        if (!_mentionState) return;
        _mentionState.files = [];
        _mentionState.loading = false;
        _mentionState.error = err.message || '로드 실패';
        renderMentionPicker();
    }
    // Re-clamp in case the loaded list grew past the viewport.
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
        el.style.top = Math.round(rect.top - r.height - 6) + 'px';
    }
}
function closeMentionPicker() {
    if (_mentionState && _mentionState.el) _mentionState.el.remove();
    _mentionState = null;
}
function mentionFiltered() {
    if (!_mentionState || !_mentionState.files) return [];
    const f = _mentionState.filter.toLowerCase();
    if (!f) return _mentionState.files;
    return _mentionState.files.filter((it) => it.name.toLowerCase().includes(f));
}
function renderMentionPicker() {
    if (!_mentionState) return;
    if (_mentionState.loading) {
        _mentionState.el.innerHTML = '<div class="mp-empty">불러오는 중…</div>';
        return;
    }
    if (_mentionState.error) {
        _mentionState.el.innerHTML = `<div class="mp-empty">오류: ${escHtml(_mentionState.error)}</div>`;
        return;
    }
    const items = mentionFiltered();
    if (_mentionState.index >= items.length) _mentionState.index = 0;
    _mentionState.el.innerHTML = items.length === 0
        ? '<div class="mp-empty">일치하는 파일 없음</div>'
        : `<div class="mp-header">파일 참조${_mentionState.filter ? ' @' + escHtml(_mentionState.filter) : ''}</div>` +
          items.slice(0, 50).map((it, i) => `
            <div class="mp-item ${i === _mentionState.index ? 'active' : ''}" data-k="${escHtml(it.name)}">
                <span class="mp-icon">${mentionIconFor(it.category)}</span>
                <span class="mp-label">${escHtml(it.name)}</span>
                <span class="mp-preview">${escHtml(it.ext.replace(/^\./, ''))}</span>
            </div>
          `).join('');
    _mentionState.el.querySelectorAll('.mp-item').forEach((el, i) => {
        el.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            _mentionState.index = i;
            commitMentionPicker();
        });
        el.addEventListener('mouseenter', () => {
            _mentionState.index = i;
            _mentionState.el.querySelectorAll('.mp-item').forEach(x => x.classList.remove('active'));
            el.classList.add('active');
        });
    });
}
function commitMentionPicker() {
    if (!_mentionState) return;
    const items = mentionFiltered();
    const item = items[_mentionState.index];
    if (!item) { closeMentionPicker(); return; }
    // Strip the typed "@filter" first so the insertion replaces it.
    const filter = _mentionState.filter;
    const toDelete = filter.length + 1; // include the @
    for (let i = 0; i < toDelete; i++) document.execCommand('delete');
    const editorEl = _mentionState.editor;
    const fileDir = getFileDir();
    closeMentionPicker();
    const mdSnippet = mentionInsertFor(item.category, item.name);
    if (item.category === 'image') {
        // Markdown image — convert to an <img> node so it renders right
        // now (marked would also produce this but doing it inline lets us
        // pre-apply the API URL, so no flicker).
        const img = document.createElement('img');
        img.setAttribute('alt', item.name.replace(/\.[^.]+$/, ''));
        img.setAttribute('data-src-original', item.name);
        const resolved = resolveRelPath(item.name, fileDir);
        img.setAttribute('src', resolved != null ? apiRawUrl(resolved) : item.name);
        insertNodeAtCaret(img, editorEl);
    } else if (item.category === 'audio' || item.category === 'video') {
        const tag = item.category;
        const media = document.createElement(tag);
        media.setAttribute('controls', '');
        if (tag === 'video') media.setAttribute('width', '100%');
        media.setAttribute('data-src-original', item.name);
        const resolved = resolveRelPath(item.name, fileDir);
        media.setAttribute('src', resolved != null ? apiRawUrl(resolved) : item.name);
        insertNodeAtCaret(media, editorEl);
    } else {
        // Plain file — insert a regular markdown link via execCommand so it
        // slots into whatever text/block the caret is in.
        document.execCommand('insertText', false, mdSnippet);
    }
    scheduleSave();
}
/** Insert a DOM node at the current caret and leave the caret just after
 *  it. Used for @-picker media insertions where the node is the payload. */
function insertNodeAtCaret(node, editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) { editor.appendChild(node); return; }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    // Move caret after the inserted node
    range.setStartAfter(node);
    range.setEndAfter(node);
    sel.removeAllRanges();
    sel.addRange(range);
}
function handleMentionPickerKey(e) {
    if (!_mentionState) return false;
    if (e.key === 'Escape') { e.preventDefault(); closeMentionPicker(); return true; }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = mentionFiltered();
        _mentionState.index = (_mentionState.index + 1) % Math.max(1, items.length);
        renderMentionPicker();
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = mentionFiltered();
        _mentionState.index = (_mentionState.index - 1 + items.length) % Math.max(1, items.length);
        renderMentionPicker();
        return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitMentionPicker();
        return true;
    }
    return false;
}
function updateMentionPickerFilter(editor) {
    if (!_mentionState) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) { closeMentionPicker(); return; }
    const node = sel.getRangeAt(0).startContainer;
    if (node.nodeType !== Node.TEXT_NODE) { closeMentionPicker(); return; }
    const head = node.textContent.slice(0, sel.getRangeAt(0).startOffset);
    const atIdx = head.lastIndexOf('@');
    if (atIdx === -1) { closeMentionPicker(); return; }
    const after = head.slice(atIdx + 1);
    // Allow spaces in filenames — only close on explicit cancel (Escape,
    // another @, or an absurdly long query).
    if (after.includes('@')) { closeMentionPicker(); return; }
    if (after.length > 40) { closeMentionPicker(); return; }
    _mentionState.filter = after;
    _mentionState.index = 0;
    renderMentionPicker();
}

// ==================== Inline math ($...$) ====================
async function tryInlineMath(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return false;
    if (isInsideTag(node, 'code') || isInsideTag(node, 'pre')) return false;
    const text = node.textContent;
    const offset = range.startOffset;
    // Text must end with the closing `$` just typed
    if (offset === 0 || text[offset - 1] !== '$') return false;
    // Find the opening `$`
    const searchEnd = offset - 1;
    const openIdx = text.lastIndexOf('$', searchEnd - 1);
    if (openIdx === -1) return false;
    // Skip if the inner is empty or surrounds `$$` (display math)
    if (text[openIdx - 1] === '$' || text[openIdx + 1] === '$') return false;
    const tex = text.slice(openIdx + 1, searchEnd);
    if (!tex.trim()) return false;

    await loadKatex();
    const before = text.slice(0, openIdx);
    const after = text.slice(offset);
    const parent = node.parentNode;

    const span = document.createElement('span');
    span.className = 'math-inline';
    span.setAttribute('contenteditable', 'false');
    span.setAttribute('data-tex', tex);
    if (typeof window.katex !== 'undefined') {
        try {
            window.katex.render(tex, span, { throwOnError: false, displayMode: false });
        } catch { span.textContent = '$' + tex + '$'; }
    } else {
        span.textContent = '$' + tex + '$';
    }
    const afterNode = document.createTextNode(after);
    if (before) {
        node.textContent = before;
        parent.insertBefore(span, node.nextSibling);
        parent.insertBefore(afterNode, span.nextSibling);
    } else {
        parent.insertBefore(span, node);
        parent.insertBefore(afterNode, span.nextSibling);
        parent.removeChild(node);
    }
    const r = document.createRange();
    r.setStart(afterNode, 0);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
}

// Callout moved to editor/callout.js

// Block type definitions shared by slash menu, Cmd+Option+N, and block menu
const NOTION_BLOCKS = [
    { key: 'text',   label: '텍스트',     aliases: ['text', 'p', 'plain', 'para'],           icon: '📝', shortcut: '⌘⌥0', kind: 'p' },
    { key: 'h1',     label: '제목 1',     aliases: ['h1', 'heading1', 'title', '#'],         icon: 'H1', shortcut: '⌘⌥1', kind: 'h1' },
    { key: 'h2',     label: '제목 2',     aliases: ['h2', 'heading2', '##'],                 icon: 'H2', shortcut: '⌘⌥2', kind: 'h2' },
    { key: 'h3',     label: '제목 3',     aliases: ['h3', 'heading3', '###'],                icon: 'H3', shortcut: '⌘⌥3', kind: 'h3' },
    { key: 'todo',   label: '할 일 목록', aliases: ['todo', 'task', 'check', '[]'],          icon: '☑',  shortcut: '⌘⌥4', kind: 'todo' },
    { key: 'ul',     label: '글머리 기호', aliases: ['bullet', 'ul', 'list', 'unordered'],   icon: '•',  shortcut: '⌘⌥5', kind: 'ul' },
    { key: 'ol',     label: '번호 매기기', aliases: ['number', 'ol', 'ordered'],             icon: '1.', shortcut: '⌘⌥6', kind: 'ol' },
    { key: 'toggle', label: '토글',        aliases: ['toggle', 'details', 'collapse'],       icon: '▸',  shortcut: '⌘⌥7', kind: 'toggle' },
    { key: 'callout',label: '콜아웃',      aliases: ['callout', 'note', 'tip', 'info'],      icon: '💡', shortcut: '',    kind: 'callout' },
    { key: 'quote',  label: '인용',        aliases: ['quote', 'blockquote', '"'],            icon: '❝',  shortcut: '',    kind: 'blockquote' },
    { key: 'code',   label: '코드',        aliases: ['code', 'pre', '```'],                  icon: '⟨⟩', shortcut: '⌘⌥8', kind: 'pre' },
    { key: 'math',   label: '수식',        aliases: ['math', 'latex', 'tex', 'equation'],    icon: 'Σ',  shortcut: '',    kind: 'math' },
    { key: 'toc',    label: '목차',        aliases: ['toc', 'contents', 'table'],            icon: '☰',  shortcut: '',    kind: 'toc' },
    { key: 'hr',     label: '구분선',      aliases: ['divider', 'hr', '---'],                icon: '—',  shortcut: '',    kind: 'hr' },
];
// Cmd+Option+0..8 map
const BLOCK_KEY_SHORTCUTS = {
    '0': 'p', '1': 'h1', '2': 'h2', '3': 'h3',
    '4': 'todo', '5': 'ul', '6': 'ol', '7': 'toggle', '8': 'pre',
};

// ==================== Focus mode ====================
let _focusMode = localStorage.getItem('notionFocusMode') === '1';
function applyFocusMode(editor) {
    if (!editor) return;
    editor.classList.toggle('focus-mode', _focusMode);
}
function toggleFocusMode(editor) {
    _focusMode = !_focusMode;
    localStorage.setItem('notionFocusMode', _focusMode ? '1' : '0');
    applyFocusMode(editor);
}
/** Tag the block the caret is currently in so focus mode can dim the rest. */
function updateFocusedBlock(editor) {
    const sel = window.getSelection();
    editor.querySelectorAll('.has-caret').forEach(b => b.classList.remove('has-caret'));
    if (!sel.rangeCount) return;
    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
    if (block) block.classList.add('has-caret');
}

// ==================== Markdown view mode (rendered ↔ text) ====================
// 'rendered' = Notion-like editor (default). 'text' = raw markdown source as <pre>.
// `_mdViewMode` is declared at the top of the IIFE alongside other preview state.

function setMarkdownViewMode(mode) {
    if (!getFile() || !MD_EXTS.includes(getFile().extension)) return;
    if (mode === _mdViewMode) return;
    if (mode === 'text') {
        // Capture any unsaved edits from the live editor before swapping out.
        const editor = previewBody.querySelector('.notion-editor');
        if (editor) getFile().content = domToMarkdown(editor);
        previewBody.innerHTML =
            `<textarea class="edit-textarea md-source-edit" spellcheck="false"></textarea>`;
        const ta = previewBody.querySelector('.md-source-edit');
        ta.value = getFile().content || '';
        wireMdSourceTextarea(ta);
        requestAnimationFrame(() => {
            ta.style.height = 'auto';
            ta.style.height = Math.max(ta.scrollHeight, previewBody.clientHeight - 40) + 'px';
            try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
        });
        _mdViewMode = 'text';
        if (previewViewToggle) {
            previewViewToggle.textContent = 'Markdown';
            previewViewToggle.title = 'Switch to rendered Markdown view';
        }
    } else {
        // Coming back from text mode: pull the latest textarea value into
        // getFile().content so the re-render uses the freshest edits.
        const ta = previewBody.querySelector('.md-source-edit');
        if (ta) getFile().content = ta.value;
        previewBody.innerHTML = `<div class="markdown-body notion-editor">${marked.parse(getFile().content)}</div>`;
        if (typeof hljs !== 'undefined') {
            previewBody.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
        }
        const editor = previewBody.querySelector('.notion-editor');
        rewriteRelativeMediaUrls(editor, getFileDir());
        rehydrateTaskCheckboxes(editor);
        setupNotionEditor(editor);
        rehydrateMathBlocks(editor);
        rehydrateTOCBlocks(editor);
        // Re-baseline the saved content against the round-tripped form so a no-op
        // toggle doesn't dirty the file.
        setSavedBaseline(domToMarkdown(editor));
        _mdViewMode = 'rendered';
        if (previewViewToggle) {
            previewViewToggle.textContent = 'Text';
            previewViewToggle.title = 'Switch to plain text view';
        }
    }
}

/** Wire up auto-save / Tab / Ctrl+S behavior on the markdown-source
 *  textarea used by the Text view toggle. Mirrors enterInlineEdit's
 *  textarea, without the one-shot Escape-to-revert (we want the toggle
 *  to persist edits, not throw them away). */
function wireMdSourceTextarea(ta) {
    ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.max(ta.scrollHeight, previewBody.clientHeight - 40) + 'px';
        scheduleSave();
    });
    ta.addEventListener('blur', () => { flushSave(); });
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = ta.selectionStart;
            ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(ta.selectionEnd);
            ta.selectionStart = ta.selectionEnd = start + 4;
            scheduleSave();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            flushSave();
        }
    });
}

/** Strip marked's default `disabled` attribute on task-list checkboxes
 *  and make them contenteditable-transparent so a tap/click actually
 *  toggles them on both desktop and mobile. See bug note in the change
 *  log — marked v4 hardcodes `<input disabled type="checkbox">` in the
 *  gfm renderer, so without this pass nothing is clickable anywhere. */
function rehydrateTaskCheckboxes(editor) {
    if (!editor) return;
    editor.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.removeAttribute('disabled');
        // iOS Safari tends to swallow taps on form controls inside a
        // contenteditable host unless the control opts out.
        cb.setAttribute('contenteditable', 'false');
    });
}

if (previewViewToggle) {
    previewViewToggle.addEventListener('click', () => {
        setMarkdownViewMode(_mdViewMode === 'rendered' ? 'text' : 'rendered');
    });
}


// ==================== Slash menu ====================
let _slashState = null; // { editor, block, anchorOffset, el, filter, index }

function openSlashMenu(editor) {
    closeSlashMenu();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const block = closestBlock(range.startContainer, editor);
    if (!block) return;
    const rect = range.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'slash-menu';
    el.style.position = 'fixed';
    el.style.left = Math.round(rect.left) + 'px';
    el.style.top = Math.round(rect.bottom + 6) + 'px';
    el.style.zIndex = '5000';
    document.body.appendChild(el);

    _slashState = { editor, block, el, filter: '', index: 0 };
    renderSlashMenu();
    // If the menu overflows the viewport, nudge up
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
        el.style.top = Math.round(rect.top - r.height - 6) + 'px';
    }
}
function closeSlashMenu() {
    if (_slashState && _slashState.el) _slashState.el.remove();
    _slashState = null;
}
function slashMenuFilteredItems() {
    if (!_slashState) return [];
    const f = _slashState.filter.toLowerCase();
    if (!f) return NOTION_BLOCKS;
    return NOTION_BLOCKS.filter(b =>
        b.label.toLowerCase().includes(f) ||
        b.aliases.some(a => a.startsWith(f))
    );
}
function renderSlashMenu() {
    if (!_slashState) return;
    const items = slashMenuFilteredItems();
    if (_slashState.index >= items.length) _slashState.index = 0;
    _slashState.el.innerHTML = items.length === 0
        ? '<div class="sm-empty">일치하는 블록 없음</div>'
        : `<div class="sm-header">블록 선택${_slashState.filter ? ' — /' + escHtml(_slashState.filter) : ''}</div>` +
          items.map((b, i) => `
            <div class="sm-item ${i === _slashState.index ? 'active' : ''}" data-key="${b.key}">
                <span class="sm-icon">${b.icon}</span>
                <span class="sm-label">${escHtml(b.label)}</span>
                ${b.shortcut ? `<span class="sm-shortcut">${escHtml(b.shortcut)}</span>` : ''}
            </div>
          `).join('');
    _slashState.el.querySelectorAll('.sm-item').forEach((el, i) => {
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            _slashState.index = i;
            commitSlashMenu();
        });
        el.addEventListener('mouseenter', () => {
            _slashState.index = i;
            _slashState.el.querySelectorAll('.sm-item').forEach(x => x.classList.remove('active'));
            el.classList.add('active');
        });
    });
}
function commitSlashMenu() {
    if (!_slashState) return;
    const items = slashMenuFilteredItems();
    const item = items[_slashState.index];
    if (!item) { closeSlashMenu(); return; }
    const { editor, block } = _slashState;
    // Strip the "/filter" from the block's text before converting
    stripSlashQueryFromBlock(block, _slashState.filter);
    closeSlashMenu();
    convertBlockTo(editor, block, item.kind);
    scheduleSave();
}
function stripSlashQueryFromBlock(block, filter) {
    // Remove the "/" plus the filter text at the end of the block's
    // textContent. We walk text nodes from the end to avoid clobbering
    // inline formatting elsewhere in the block.
    const target = '/' + filter;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let remaining = target.length;
    for (let i = nodes.length - 1; i >= 0 && remaining > 0; i--) {
        const n = nodes[i];
        const len = n.textContent.length;
        if (len >= remaining) {
            n.textContent = n.textContent.slice(0, len - remaining);
            remaining = 0;
        } else {
            n.textContent = '';
            remaining -= len;
        }
    }
}

/** Handle keyboard events while the slash menu is open.
 *  Returns true if the event was consumed. */
function handleSlashMenuKey(e) {
    if (!_slashState) return false;
    if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return true; }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = slashMenuFilteredItems();
        _slashState.index = (_slashState.index + 1) % Math.max(1, items.length);
        renderSlashMenu();
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = slashMenuFilteredItems();
        _slashState.index = (_slashState.index - 1 + items.length) % Math.max(1, items.length);
        renderSlashMenu();
        return true;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        commitSlashMenu();
        return true;
    }
    return false;
}

/** After each input event, refresh the slash menu filter (or close
 *  it if the "/" was deleted). */
function updateSlashMenuFilter(editor) {
    if (!_slashState) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) { closeSlashMenu(); return; }
    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
    if (block !== _slashState.block) { closeSlashMenu(); return; }
    const text = block.textContent;
    const slashIdx = text.lastIndexOf('/');
    if (slashIdx === -1) { closeSlashMenu(); return; }
    const after = text.slice(slashIdx + 1);
    // Slash must not contain spaces (to let users type "/ foo" literally if
    // they escape out)
    if (after.includes(' ')) { closeSlashMenu(); return; }
    _slashState.filter = after;
    _slashState.index = 0;
    renderSlashMenu();
}

// ==================== Selection toolbar ====================
let _selToolbarEl = null;

function ensureSelectionToolbar() {
    if (_selToolbarEl) return _selToolbarEl;
    const el = document.createElement('div');
    el.className = 'selection-toolbar';
    el.innerHTML = `
        <button data-cmd="bold" title="Bold (⌘B)"><b>B</b></button>
        <button data-cmd="italic" title="Italic (⌘I)"><i>I</i></button>
        <button data-cmd="underline" title="Underline (⌘U)"><u>U</u></button>
        <button data-cmd="strike" title="Strike (⌘⇧S)"><s>S</s></button>
        <button data-cmd="code" title="Code (⌘E)">&lt;/&gt;</button>
        <button data-cmd="link" title="Link (⌘K)">🔗</button>
        <button data-cmd="color" title="색상 (⌘⇧H)"><span class="st-color">A</span>▾</button>
    `;
    // Use pointerdown so we can preventDefault before the selection is
    // lost. pointerdown covers mouse, touch, and pen with a single path.
    el.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        e.preventDefault();
        if (btn.dataset.cmd === 'color') {
            const rect = btn.getBoundingClientRect();
            openColorPicker(rect);
            return;
        }
        applyInlineFormat(btn.dataset.cmd);
    });
    el.style.position = 'fixed';
    el.style.zIndex = '5000';
    el.style.display = 'none';
    document.body.appendChild(el);
    _selToolbarEl = el;
    return el;
}
function hideSelectionToolbar() {
    if (_selToolbarEl) _selToolbarEl.style.display = 'none';
}
function updateSelectionToolbar(editor) {
    // On mobile, don't fight the native iOS/Android selection menu.
    // The custom Notion-style toolbar would stack on top of the OS copy/paste
    // UI and race with it. Users keep the standard copy/paste flow; Bold etc.
    // remain desktop-only for now.
    if (isMobile()) { hideSelectionToolbar(); return; }
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { hideSelectionToolbar(); return; }
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) { hideSelectionToolbar(); return; }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideSelectionToolbar(); return; }
    const tb = ensureSelectionToolbar();
    tb.style.display = 'flex';
    // Measure first so we can center on selection
    const tbRect = tb.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tbRect.width / 2;
    let top = rect.top - tbRect.height - 8;
    // Keep inside viewport
    if (left < 8) left = 8;
    if (left + tbRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tbRect.width - 8;
    }
    if (top < 8) top = rect.bottom + 8; // flip below selection
    tb.style.left = Math.round(left) + 'px';
    tb.style.top = Math.round(top) + 'px';
}

function applyInlineFormat(cmd) {
    switch (cmd) {
        case 'bold':      document.execCommand('bold'); break;
        case 'italic':    document.execCommand('italic'); break;
        case 'underline': document.execCommand('underline'); break;
        case 'strike':    document.execCommand('strikeThrough'); break;
        case 'code':      wrapSelectionWithTag('code'); break;
        case 'link':      openLinkInput(); return; // schedules save itself
    }
    scheduleSave();
}

// ==================== Link input (floating) ====================
function openLinkInput() {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const savedRange = sel.getRangeAt(0).cloneRange();
    const rect = savedRange.getBoundingClientRect();

    // Check if the selection is already inside an existing link
    let existingA = savedRange.startContainer;
    while (existingA && existingA !== document.body) {
        if (existingA.nodeType === Node.ELEMENT_NODE && existingA.tagName === 'A') break;
        existingA = existingA.parentNode;
    }
    const currentUrl = (existingA && existingA.tagName === 'A') ? (existingA.getAttribute('href') || '') : '';

    const overlay = document.createElement('div');
    overlay.className = 'link-input';
    overlay.innerHTML = `
        <input type="url" placeholder="URL을 입력하세요 (예: https://...)" value="${escHtml(currentUrl)}">
        <button type="button" class="li-apply">적용</button>
        ${currentUrl ? '<button type="button" class="li-remove">제거</button>' : ''}
    `;
    overlay.style.position = 'fixed';
    overlay.style.left = Math.round(rect.left) + 'px';
    overlay.style.top = Math.round(rect.bottom + 6) + 'px';
    overlay.style.zIndex = '5100';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    input.focus();
    input.select();

    const cleanup = () => { overlay.remove(); document.removeEventListener('mousedown', outsideClose, true); };
    const outsideClose = (e) => { if (!overlay.contains(e.target)) cleanup(); };
    const restoreSelection = () => {
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(savedRange);
    };
    const apply = () => {
        const url = input.value.trim();
        if (!url) { cleanup(); return; }
        restoreSelection();
        document.execCommand('createLink', false, url);
        scheduleSave();
        cleanup();
    };
    const remove = () => {
        restoreSelection();
        document.execCommand('unlink');
        scheduleSave();
        cleanup();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); apply(); }
        else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    });
    overlay.querySelector('.li-apply').addEventListener('click', apply);
    const rmBtn = overlay.querySelector('.li-remove');
    if (rmBtn) rmBtn.addEventListener('click', remove);
    // Defer the outside-close listener so the initial click that opened
    // the input doesn't immediately close it.
    setTimeout(() => document.addEventListener('mousedown', outsideClose, true), 0);
}

// ==================== Block menu (Cmd+/, right-click) ====================
let _blockMenuEl = null;

function closeBlockMenu() {
    if (_blockMenuEl) _blockMenuEl.remove();
    _blockMenuEl = null;
}

function openBlockMenu(editor, x, y, targetBlock) {
    closeBlockMenu();
    const el = document.createElement('div');
    el.className = 'block-menu';
    el.style.position = 'fixed';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.zIndex = '5200';

    const turnIntoItems = NOTION_BLOCKS
        .map(b => `<div class="bm-item" data-act="turn:${b.key}"><span class="bm-icon">${b.icon}</span><span class="bm-label">${escHtml(b.label)}</span>${b.shortcut ? `<span class="bm-shortcut">${escHtml(b.shortcut)}</span>` : ''}</div>`)
        .join('');

    el.innerHTML = `
        <div class="bm-section-title">변환</div>
        ${turnIntoItems}
        <div class="bm-divider"></div>
        <div class="bm-item" data-act="duplicate"><span class="bm-icon">📋</span><span class="bm-label">복제</span><span class="bm-shortcut">⌘D</span></div>
        <div class="bm-item" data-act="move-up"><span class="bm-icon">↑</span><span class="bm-label">위로 이동</span><span class="bm-shortcut">⌘⇧↑</span></div>
        <div class="bm-item" data-act="move-down"><span class="bm-icon">↓</span><span class="bm-label">아래로 이동</span><span class="bm-shortcut">⌘⇧↓</span></div>
        <div class="bm-divider"></div>
        <div class="bm-item danger" data-act="delete"><span class="bm-icon">🗑</span><span class="bm-label">삭제</span></div>
    `;
    document.body.appendChild(el);

    // Clamp to viewport
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
        el.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
    }
    if (rect.bottom > window.innerHeight - 8) {
        el.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
    }

    // pointerdown unifies mouse + touch + pen. On iOS Safari < 13 it may be
    // missing, but the menu is desktop-only anyway now (mobile contextmenu
    // early-returns). Keeping the handler here so any other future entry
    // point still gets a tap response immediately.
    el.addEventListener('pointerdown', (e) => {
        const item = e.target.closest('.bm-item');
        if (!item) return;
        e.preventDefault();
        performBlockAction(editor, targetBlock, item.dataset.act);
        closeBlockMenu();
    });

    // Outside-dismiss: use pointerdown (mouse/touch/pen) AND touchstart as a
    // belt-and-suspenders fallback so the menu never gets stuck — the old
    // code only listened for `mousedown`, which iOS/Android do not reliably
    // synthesize from touches, causing the menu to live forever.
    const outside = (e) => {
        if (!el.contains(e.target)) {
            closeBlockMenu();
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('touchstart', outside, true);
        }
    };
    setTimeout(() => {
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('touchstart', outside, true);
    }, 0);
}

function performBlockAction(editor, block, act) {
    if (!block) return;
    if (act.startsWith('turn:')) {
        const key = act.slice(5);
        const def = NOTION_BLOCKS.find(b => b.key === key);
        if (def) convertBlockTo(editor, block, def.kind);
    } else if (act === 'duplicate') {
        const clone = block.cloneNode(true);
        block.after(clone);
        placeCaretAtStart(clone);
    } else if (act === 'move-up') {
        const prev = block.previousElementSibling;
        if (prev) block.parentNode.insertBefore(block, prev);
    } else if (act === 'move-down') {
        const next = block.nextElementSibling;
        if (next) block.parentNode.insertBefore(next, block);
    } else if (act === 'delete') {
        const next = block.nextElementSibling || block.previousElementSibling;
        block.remove();
        if (next) placeCaretAtStart(next);
    }
    scheduleSave();
}

/** Wire a contenteditable markdown editor. */
function setupNotionEditor(editor) {
    if (!editor) return;
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('spellcheck', 'false');

    let _isComposing = false;
    editor.addEventListener('compositionstart', () => { _isComposing = true; });
    editor.addEventListener('compositionend', () => { _isComposing = false; });

    editor.addEventListener('input', (e) => {
        // Opening the slash menu: user just typed "/"
        if (e.inputType === 'insertText' && e.data === '/' && !_slashState) {
            openSlashMenu(editor);
        } else if (_slashState) {
            updateSlashMenuFilter(editor);
        }
        // Emoji picker on ":"
        if (e.inputType === 'insertText' && e.data === ':' && !_emojiState && !_slashState) {
            openEmojiPicker(editor);
        } else if (_emojiState) {
            updateEmojiPickerFilter(editor);
        }
        // Mention picker on "@"
        if (e.inputType === 'insertText' && e.data === '@' && !_mentionState && !_slashState) {
            openMentionPicker(editor);
        } else if (_mentionState) {
            updateMentionPickerFilter(editor);
        }
        // Block-level markdown shortcuts on space
        if (e.inputType === 'insertText' && e.data === ' ') {
            tryMarkdownShortcut(editor);
            // Auto-link: detect URL right before the space
            tryAutoLink(editor);
        }
        // Inline live markdown on a non-IME single character insertion
        if (!_isComposing && e.inputType === 'insertText' && e.data && e.data.length === 1) {
            tryInlineMarkdown(editor, e.data);
            // Inline math on closing $
            if (e.data === '$') tryInlineMath(editor);
        }
        scheduleSave();
    });

    editor.addEventListener('keydown', (e) => {
        // Slash menu / emoji / mention pickers consume keys first
        if (_slashState && handleSlashMenuKey(e)) return;
        if (_emojiState && handleEmojiPickerKey(e)) return;
        if (_mentionState && handleMentionPickerKey(e)) return;
        // Block selection mode intercepts most keys
        if (_selectedBlock && handleBlockSelectionKey(editor, e)) return;

        if (e.key === 'Enter' && !e.shiftKey) {
            if (tryEnterBehavior(editor, e)) return;
        }
        // Tab / Shift+Tab — nested list indent/outdent
        if (e.key === 'Tab') {
            const handled = e.shiftKey
                ? tryOutdentListItem(editor)
                : tryIndentListItem(editor);
            if (handled) {
                e.preventDefault();
                scheduleSave();
                return;
            }
        }
        if (e.key === 'Escape') {
            if (_blockMenuEl) { e.preventDefault(); closeBlockMenu(); return; }
            if (_colorPickerEl) { e.preventDefault(); closeColorPicker(); return; }
            // Enter block selection mode instead of blurring
            if (!_selectedBlock && enterBlockSelectionFromCaret(editor)) {
                e.preventDefault();
                return;
            }
            e.preventDefault();
            editor.blur();
            flushSave();
            return;
        }

        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const k = e.key.toLowerCase();

        // Cmd+Shift+H — apply last used color
        if (k === 'h' && e.shiftKey) {
            e.preventDefault();
            applyLastColor();
            return;
        }
        // Cmd+Shift+F — toggle focus mode
        if (k === 'f' && e.shiftKey) {
            e.preventDefault();
            toggleFocusMode(editor);
            return;
        }
        // Cmd+A — two-stage select (block → all)
        if (k === 'a' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            twoStageSelectAll(editor);
            return;
        }

        // Block type shortcuts: Cmd+Option+0..8
        if (e.altKey && BLOCK_KEY_SHORTCUTS[e.key] !== undefined) {
            e.preventDefault();
            convertCurrentBlock(editor, BLOCK_KEY_SHORTCUTS[e.key]);
            scheduleSave();
            return;
        }
        // Block menu: Cmd+/
        if (k === '/') {
            e.preventDefault();
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
            if (!block) return;
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            openBlockMenu(editor, rect.left, rect.bottom + 6, block);
            return;
        }
        // Cmd+D — duplicate current block
        if (k === 'd' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            const sel = window.getSelection();
            if (sel.rangeCount) {
                const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
                if (block) {
                    const clone = block.cloneNode(true);
                    block.after(clone);
                    placeCaretAtStart(clone);
                    scheduleSave();
                }
            }
            return;
        }
        // Cmd+Shift+Up / Cmd+Shift+Down — move block
        if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
            if (!block) return;
            e.preventDefault();
            if (e.key === 'ArrowUp') {
                const prev = block.previousElementSibling;
                if (prev) block.parentNode.insertBefore(block, prev);
            } else {
                const next = block.nextElementSibling;
                if (next) block.parentNode.insertBefore(next, block);
            }
            placeCaretAtStart(block);
            scheduleSave();
            return;
        }
        // Cmd+K — link
        if (k === 'k') {
            e.preventDefault();
            openLinkInput();
            return;
        }
        // Cmd+U — underline
        if (k === 'u' && !e.shiftKey) {
            e.preventDefault();
            document.execCommand('underline');
            scheduleSave();
            return;
        }
        // Cmd+Shift+S — strikethrough
        if (k === 's' && e.shiftKey) {
            e.preventDefault();
            document.execCommand('strikeThrough');
            scheduleSave();
            return;
        }
        if (k === 'b') {
            e.preventDefault();
            document.execCommand('bold');
            scheduleSave();
        } else if (k === 'i') {
            e.preventDefault();
            document.execCommand('italic');
            scheduleSave();
        } else if (k === 'e') {
            e.preventDefault();
            wrapSelectionWithTag('code');
            scheduleSave();
        } else if (k === 's' && !e.shiftKey) {
            e.preventDefault();
            flushSave();
        }
    });

    // Selection toolbar — track selection changes inside this editor
    const selectionHandler = () => {
        if (document.activeElement !== editor && !editor.contains(document.activeElement)) {
            hideSelectionToolbar();
            closeCodeLangPicker();
            return;
        }
        updateSelectionToolbar(editor);
        updateCodeLangIndicator(editor);
        updateFocusedBlock(editor);
    };
    document.addEventListener('selectionchange', selectionHandler);
    applyFocusMode(editor);
    // Reposition the code language indicator on scroll/resize
    window.addEventListener('scroll', () => updateCodeLangIndicator(editor), true);
    window.addEventListener('resize', () => updateCodeLangIndicator(editor));

    // Right-click → block menu.
    // On mobile, `contextmenu` is synthesized by long-press, which is also
    // how the user invokes the native copy/paste menu. Intercepting it here
    // would open our "변환" menu AND prevent the OS menu — and because the
    // block menu's outside-dismiss relied on mousedown (which touch does
    // not reliably synthesize), it could also get stuck. Desktop keeps the
    // right-click behaviour; mobile gets the native selection UI back.
    editor.addEventListener('contextmenu', (e) => {
        if (isMobile()) return;
        const block = closestBlock(e.target, editor);
        if (!block) return;
        e.preventDefault();
        openBlockMenu(editor, e.clientX, e.clientY, block);
    });

    // Save on blur too (belt and suspenders)
    editor.addEventListener('blur', () => {
        hideSelectionToolbar();
        flushSave();
    });

    // Smart paste: URL → link, rich HTML → sanitized insert, plain
    // text → literal. Replaces the previous "always plain text" behavior.
    editor.addEventListener('paste', (e) => {
        handlePaste(editor, e);
        scheduleSave();
    });

    // Clicking anywhere in the editor clears block selection mode
    editor.addEventListener('mousedown', () => {
        if (_selectedBlock) clearBlockSelection();
    });

    // Task-list checkbox toggling. We intentionally manage the toggle
    // manually instead of trusting the browser's native click → toggle,
    // because iOS Safari inside a contenteditable host often swallows
    // the tap for caret placement, leaving the checkbox in its stale
    // state. Handling it here makes desktop + mobile behave identically
    // and wires the change to scheduleSave so the markdown source stays
    // in sync (`[x]` vs `[ ]`).
    editor.addEventListener('click', (e) => {
        const cb = e.target.closest('input[type="checkbox"]');
        if (!cb || !editor.contains(cb)) return;
        // Only task-list checkboxes live inside <li> — leave any other
        // stray checkbox alone (there shouldn't be any today, but be safe).
        if (!cb.closest('li')) return;
        e.preventDefault();
        cb.checked = !cb.checked;
        // Reflect the new state on the attribute too so serialization and
        // any attribute-based CSS stay consistent.
        if (cb.checked) cb.setAttribute('checked', '');
        else cb.removeAttribute('checked');
        scheduleSave();
    });
}


// ---------- Public entry points (called from renderPreviewMode) ----------
// setupNotionEditor(editor)         — defined above, already at module scope
// rehydrateTaskCheckboxes(editor)  — defined above
// setMarkdownViewMode(mode)        — defined above

export { setupNotionEditor, rehydrateTaskCheckboxes, setMarkdownViewMode };
