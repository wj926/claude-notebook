/* === Claude Notebook — editor/code-lang.js ===
 *
 * Language picker for <pre><code> code blocks. Shown as a small floating
 * label at the block's top-right whenever the caret is inside a code
 * block; clicking the label opens a dropdown to switch language (which
 * re-runs highlight.js on the block).
 */

import { escHtml } from '../core/utils.js';
import { scheduleSave } from './auto-save.js';

const CODE_LANGS = [
    { id: '',           label: 'Plain'      },
    { id: 'javascript', label: 'JavaScript' },
    { id: 'typescript', label: 'TypeScript' },
    { id: 'python',     label: 'Python'     },
    { id: 'bash',       label: 'Bash'       },
    { id: 'json',       label: 'JSON'       },
    { id: 'yaml',       label: 'YAML'       },
    { id: 'html',       label: 'HTML'       },
    { id: 'css',        label: 'CSS'        },
    { id: 'sql',        label: 'SQL'        },
    { id: 'markdown',   label: 'Markdown'   },
    { id: 'rust',       label: 'Rust'       },
    { id: 'go',         label: 'Go'         },
    { id: 'java',       label: 'Java'       },
    { id: 'c',          label: 'C'          },
    { id: 'cpp',        label: 'C++'        },
    { id: 'ruby',       label: 'Ruby'       },
    { id: 'php',        label: 'PHP'        },
    { id: 'swift',      label: 'Swift'      },
    { id: 'kotlin',     label: 'Kotlin'     },
];

let _codeLangEl = null;
let _codeLangBlock = null;

export function closeCodeLangPicker() {
    if (_codeLangEl) _codeLangEl.remove();
    _codeLangEl = null;
    _codeLangBlock = null;
}

function currentCodeBlockLang(pre) {
    const code = pre && pre.querySelector('code');
    if (!code) return '';
    const m = code.className.match(/language-([\w-]+)/);
    return m ? m[1] : '';
}

function setCodeBlockLang(pre, lang) {
    const code = pre.querySelector('code');
    if (!code) return;
    // Strip existing language + hljs classes
    code.className = code.className
        .split(/\s+/)
        .filter(c => !c.startsWith('language-') && !c.startsWith('hljs'))
        .join(' ')
        .trim();
    if (lang) code.classList.add('language-' + lang);
    if (typeof hljs !== 'undefined' && lang) {
        try { hljs.highlightElement(code); } catch {}
    }
    scheduleSave();
}

function openCodeLangDropdown(pre, anchorRect) {
    const dd = document.createElement('div');
    dd.className = 'code-lang-dropdown';
    dd.style.position = 'fixed';
    dd.style.zIndex = '5400';
    const cur = currentCodeBlockLang(pre);
    dd.innerHTML = CODE_LANGS.map(l => `
        <div class="cl-item ${l.id === cur ? 'active' : ''}" data-id="${l.id}">${escHtml(l.label)}</div>
    `).join('');
    document.body.appendChild(dd);
    dd.style.left = Math.round(anchorRect.right - dd.offsetWidth) + 'px';
    dd.style.top  = Math.round(anchorRect.bottom + 4) + 'px';
    const r = dd.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) dd.style.top  = Math.max(8, window.innerHeight - r.height - 8) + 'px';
    if (r.right  > window.innerWidth  - 8) dd.style.left = Math.max(8, window.innerWidth  - r.width  - 8) + 'px';
    dd.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.cl-item');
        if (!item) return;
        e.preventDefault();
        setCodeBlockLang(pre, item.dataset.id);
        dd.remove();
        closeCodeLangPicker();
    });
    const outside = (e) => {
        if (!dd.contains(e.target)) {
            dd.remove();
            document.removeEventListener('mousedown', outside, true);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

/** Called on every selection change inside the editor. Shows/hides/repositions
 *  the floating lang indicator based on whether the caret is inside a <pre>. */
export function updateCodeLangIndicator(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) { closeCodeLangPicker(); return; }
    let n = sel.getRangeAt(0).startContainer;
    let pre = null;
    while (n && n !== editor) {
        if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'PRE') { pre = n; break; }
        n = n.parentNode;
    }
    if (!pre) { closeCodeLangPicker(); return; }
    if (_codeLangBlock === pre && _codeLangEl) {
        // Already showing — just reposition
        const rect = pre.getBoundingClientRect();
        _codeLangEl.style.top  = Math.round(rect.top + 6) + 'px';
        _codeLangEl.style.left = Math.round(rect.right - _codeLangEl.offsetWidth - 10) + 'px';
        return;
    }
    closeCodeLangPicker();
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'code-lang-indicator';
    const lang = currentCodeBlockLang(pre);
    el.textContent = (CODE_LANGS.find(l => l.id === lang)?.label || lang || 'Plain') + ' ▾';
    el.style.position = 'fixed';
    el.style.zIndex = '4900';
    document.body.appendChild(el);
    const rect = pre.getBoundingClientRect();
    el.style.top  = Math.round(rect.top + 6) + 'px';
    el.style.left = Math.round(rect.right - el.offsetWidth - 10) + 'px';
    el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCodeLangDropdown(pre, el.getBoundingClientRect());
    });
    _codeLangEl = el;
    _codeLangBlock = pre;
}
