/* === Claude Notebook — editor/callout.js ===
 *
 * Notion-style callout block (icon + content). The icon is editable on
 * click (single emoji); the content is a regular contenteditable region.
 * The markdown serializer round-trips this as
 *   <div class="callout" data-icon="...">...</div>.
 */

import { closestBlock, placeCaretAtStart } from './markdown.js';
import { scheduleSave } from './auto-save.js';

export function insertCallout(editor) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const block = closestBlock(sel.getRangeAt(0).startContainer, editor);
    if (!block) return;

    const callout = document.createElement('div');
    callout.className = 'callout';
    callout.setAttribute('data-icon', '💡');

    const icon = document.createElement('span');
    icon.className = 'callout-icon';
    icon.setAttribute('contenteditable', 'false');
    icon.textContent = '💡';
    icon.addEventListener('click', (e) => {
        e.preventDefault();
        const next = prompt('아이콘 입력 (이모지 하나):', callout.getAttribute('data-icon') || '💡');
        if (next && next.length <= 4) {
            callout.setAttribute('data-icon', next);
            icon.textContent = next;
            scheduleSave();
        }
    });

    const content = document.createElement('div');
    content.className = 'callout-content';
    content.innerHTML = block.innerHTML || '<p><br></p>';

    callout.appendChild(icon);
    callout.appendChild(content);
    block.replaceWith(callout);

    const first = content.firstElementChild || content;
    placeCaretAtStart(first);
}
