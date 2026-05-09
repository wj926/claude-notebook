/* === Claude Notebook — editor/markdown.js ===
 *
 * Pure DOM ↔ Markdown conversion for the Notion-style contenteditable
 * editor. Every function takes a DOM node (or HTML string) and returns
 * another DOM-independent value — no app state, no globals beyond
 * `escHtml` imported from core/utils.
 *
 * Scope covers what marked.js produces + the hand-built blocks we add
 * (callouts, math, TOC, toggle details, inline math spans, color
 * spans). Anything else falls through as textContent.
 */

import { escHtml } from '../core/utils.js';

// Block-level tags the editor can emit at the top level of a document.
export const BLOCK_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'ul', 'ol', 'li', 'hr', 'table', 'div',
    'details', 'section',
]);

// Tags we allow to survive a paste operation; everything else is stripped
// to its text content by `sanitizePastedHtml`.
const ALLOWED_PASTE_TAGS = new Set([
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 'del', 's', 'strike', 'code',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'details', 'summary', 'span',
]);

// ---------- DOM helpers ----------

/** Walk up from a node to the enclosing block element inside the editor. */
export function closestBlock(node, editor) {
    let n = node;
    while (n && n !== editor) {
        if (n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.tagName.toLowerCase())) {
            return n;
        }
        n = n.parentNode;
    }
    return null;
}

export function placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

// ---------- DOM → Markdown ----------

/** Serialize an <audio>/<video> element back to raw HTML with the clean
 *  relative src so round-trips stay stable. */
export function mediaTagToHtml(node) {
    const tag = node.tagName.toLowerCase();
    const src = node.getAttribute('data-src-original') || node.getAttribute('src') || '';
    const controls = node.hasAttribute('controls') ? ' controls' : '';
    const extra = tag === 'video' ? ' width="100%"' : '';
    return `<${tag} src="${src}"${controls}${extra}></${tag}>`;
}

/** Recursive HTML → Markdown for inline content. */
export function inlineToMd(el) {
    let out = '';
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            out += node.textContent;
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = node.tagName.toLowerCase();
        if (tag === 'br') { out += '  \n'; continue; }
        if (tag === 'img') {
            const alt = node.getAttribute('alt') || '';
            // Prefer the clean relative form saved by rewriteRelativeMediaUrls
            // so we round-trip cleanly.
            const src = node.getAttribute('data-src-original') || node.getAttribute('src') || '';
            out += `![${alt}](${src})`;
            continue;
        }
        if (tag === 'audio' || tag === 'video') {
            // Images use their natural markdown form; audio/video have no
            // markdown equivalent so we pass raw HTML which marked.js
            // re-renders on the next open.
            out += mediaTagToHtml(node);
            continue;
        }

        const inner = inlineToMd(node);
        switch (tag) {
            case 'strong': case 'b': out += inner.trim() ? `**${inner}**` : inner; break;
            case 'em': case 'i':     out += inner.trim() ? `*${inner}*`   : inner; break;
            case 'code':             out += `\`${inner}\``;                       break;
            case 'del': case 's': case 'strike': out += `~~${inner}~~`;           break;
            case 'u':
                // Underline has no standard markdown — fall back to
                // inline HTML which marked.js passes through.
                out += `<u>${inner}</u>`;
                break;
            case 'a': {
                const href = node.getAttribute('data-href-original') || node.getAttribute('href') || '';
                out += `[${inner}](${href})`;
                break;
            }
            case 'input':
                // task-list checkbox — handled by the containing <li>
                break;
            case 'span': {
                // Inline math → $...$ with the span preserved so reloads
                // still render via KaTeX.
                if (node.classList && node.classList.contains('math-inline')) {
                    const tex = node.getAttribute('data-tex') || '';
                    out += `<span class="math-inline" data-tex="${escHtml(tex)}">$${tex}$</span>`;
                    break;
                }
                // Resizable image wrapper (.img-wrap) — extract the inner
                // <img> and serialize as inline HTML so the user-set width
                // survives a save round-trip.
                if (node.classList && node.classList.contains('img-wrap')) {
                    const innerImg = node.querySelector(':scope > img');
                    if (innerImg) {
                        const alt = innerImg.getAttribute('alt') || '';
                        const src = innerImg.getAttribute('data-src-original') || innerImg.getAttribute('src') || '';
                        const w = node.style.width;  // set by user dragging the resize handle
                        if (w) {
                            const px = parseInt(w, 10);
                            const widthAttr = Number.isFinite(px) && px > 0 ? ` width="${px}"` : '';
                            out += `<img alt="${escHtml(alt)}" src="${src}"${widthAttr}>`;
                        } else {
                            out += `![${alt}](${src})`;
                        }
                    }
                    break;
                }
                // Preserve color / background spans as inline HTML —
                // style attribute passes through verbatim so marked.js
                // re-renders the color on reload.
                const style = node.getAttribute('style');
                if (style) out += `<span style="${style}">${inner}</span>`;
                else out += inner;
                break;
            }
            default:
                out += inner;
        }
    }
    return out;
}

/** List → Markdown (supports nesting + task-list checkboxes). */
export function listToMd(ul, ordered, depth) {
    const items = Array.from(ul.children).filter(c => c.tagName === 'LI');
    const indent = '    '.repeat(depth); // 4 spaces per level keeps marked.js happy
    return items.map((li, i) => {
        const bullet = ordered ? `${i + 1}. ` : '- ';
        const cb = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
        const task = cb ? (cb.checked ? '[x] ' : '[ ] ') : '';
        // Split li contents: the first paragraph/text is the item text;
        // any nested ul/ol is recursively serialized and indented.
        const textParts = [];
        const nestedParts = [];
        for (const child of li.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                textParts.push(child.textContent);
                continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const tag = child.tagName.toLowerCase();
            if (tag === 'ul')        nestedParts.push(listToMd(child, false, depth + 1));
            else if (tag === 'ol')   nestedParts.push(listToMd(child, true,  depth + 1));
            else if (tag === 'input' && child.type === 'checkbox') { /* consumed above */ }
            else                     textParts.push(inlineToMd(child));
        }
        const text = textParts.join('').replace(/^\s+|\s+$/g, '');
        let line = indent + bullet + task + text;
        if (nestedParts.length) line += '\n' + nestedParts.join('\n');
        return line;
    }).join('\n');
}

/** Table → Markdown (GFM pipe table). */
export function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const cellsOf = (tr) => Array.from(tr.children)
        .filter(c => c.tagName === 'TH' || c.tagName === 'TD')
        .map(c => inlineToMd(c).replace(/\|/g, '\\|').replace(/\n/g, ' '));
    const header = cellsOf(rows[0]);
    const sep = header.map(() => '---');
    const body = rows.slice(1).map(cellsOf);
    const toRow = (cells) => '| ' + cells.join(' | ') + ' |';
    return [toRow(header), toRow(sep), ...body.map(toRow)].join('\n');
}

// Generic "serialize a node's children": blocks via blockToMd,
// inline via inlineToMd, text nodes verbatim. Used for containers that
// mix both (blockquote, details, callout).
function serializeContainer(container, excludeNode) {
    return Array.from(container.childNodes)
        .filter(n => n !== excludeNode)
        .map(n => {
            if (n.nodeType === Node.TEXT_NODE) return n.textContent;
            if (n.nodeType !== Node.ELEMENT_NODE) return '';
            if (BLOCK_TAGS.has(n.tagName.toLowerCase())) return blockToMd(n);
            return inlineToMd(n);
        })
        .map(s => s.trim())
        .filter(Boolean)
        .join('\n\n');
}

/** Single block → Markdown. */
export function blockToMd(block) {
    const tag = block.tagName.toLowerCase();
    switch (tag) {
        case 'h1': return '# '      + inlineToMd(block);
        case 'h2': return '## '     + inlineToMd(block);
        case 'h3': return '### '    + inlineToMd(block);
        case 'h4': return '#### '   + inlineToMd(block);
        case 'h5': return '##### '  + inlineToMd(block);
        case 'h6': return '###### ' + inlineToMd(block);
        case 'p':  return inlineToMd(block);
        case 'blockquote': {
            const inner = serializeContainer(block);
            return inner.split('\n').map(l => '> ' + l).join('\n');
        }
        case 'pre': {
            const code = block.querySelector('code');
            const langMatch = code && code.className.match(/language-([\w-]+)/);
            const lang = langMatch ? langMatch[1] : '';
            const text = (code || block).textContent.replace(/\n$/, '');
            return '```' + lang + '\n' + text + '\n```';
        }
        case 'ul':    return listToMd(block, false, 0);
        case 'ol':    return listToMd(block, true,  0);
        case 'hr':    return '---';
        case 'table': return tableToMd(block);
        case 'details': {
            // Toggle block — preserved as inline HTML since markdown has
            // no standard toggle syntax. marked.js passes HTML through
            // so the block re-renders correctly next open.
            const summary = block.querySelector(':scope > summary');
            const summaryMd = summary ? inlineToMd(summary) : '';
            const body = serializeContainer(block, summary);
            return `<details>\n<summary>${summaryMd}</summary>\n\n${body}\n\n</details>`;
        }
        case 'div': case 'section': {
            // Callout block — preserve as inline HTML so re-opens re-render
            // with the icon + styling intact.
            if (block.classList && block.classList.contains('callout')) {
                const icon = block.getAttribute('data-icon') || '💡';
                const content = block.querySelector(':scope > .callout-content') || block;
                const innerMd = serializeContainer(content);
                return `<div class="callout" data-icon="${escHtml(icon)}">\n\n${innerMd}\n\n</div>`;
            }
            // Math block — store tex in data-tex; serialize as $$...$$ for
            // markdown compatibility but keep the wrapping div with data-tex
            // so round-trip re-renders via KaTeX.
            if (block.classList && block.classList.contains('math-block')) {
                const tex = block.getAttribute('data-tex') || '';
                return `<div class="math-block" data-tex="${escHtml(tex)}">\n\n$$${tex}$$\n\n</div>`;
            }
            // TOC block — preserve as inline HTML. Click handlers are
            // re-bound on file load via rehydrateTOCBlocks.
            if (block.classList && block.classList.contains('toc-block')) {
                return block.outerHTML;
            }
            // Transparent: recurse
            return serializeContainer(block);
        }
        default:
            return inlineToMd(block);
    }
}

/** Serialize the whole editor to Markdown. */
export function domToMarkdown(editor) {
    if (!editor) return '';
    const parts = [];
    for (const child of editor.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            const t = child.textContent.replace(/^\s+|\s+$/g, '');
            if (t) parts.push(t);
            continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const childTag = child.tagName.toLowerCase();
        // Top-level audio/video (rare — usually wrapped in <p> by marked,
        // but possible after edits). Handle explicitly so they don't
        // evaporate through the stray-inline branch.
        if (childTag === 'audio' || childTag === 'video') {
            parts.push(mediaTagToHtml(child));
            continue;
        }
        if (BLOCK_TAGS.has(childTag)) {
            parts.push(blockToMd(child));
        } else {
            // stray inline at top level — wrap as paragraph
            const t = inlineToMd(child);
            if (t.trim()) parts.push(t);
        }
    }
    // Collapse triple-blank-lines, ensure trailing newline
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

// ---------- Paste sanitation ----------

/** Strip elements outside the allow-list and drop disallowed attributes.
 *  <span style> is preserved so pasted color/bg spans survive. */
export function sanitizePastedHtml(raw) {
    const tmp = document.createElement('div');
    tmp.innerHTML = raw;
    const walk = (el) => {
        Array.from(el.children).forEach(walk);
        if (!ALLOWED_PASTE_TAGS.has(el.tagName.toLowerCase())) {
            el.replaceWith(document.createTextNode(el.textContent || ''));
            return;
        }
        const keepAttrs = new Set(['href', 'src', 'alt', 'type', 'checked', 'start']);
        Array.from(el.attributes).forEach(attr => {
            if (keepAttrs.has(attr.name.toLowerCase())) return;
            if (el.tagName.toLowerCase() === 'span' && attr.name === 'style') return;
            el.removeAttribute(attr.name);
        });
    };
    Array.from(tmp.children).forEach(walk);
    return tmp.innerHTML;
}
