/* === Claude Notebook — ui/history-modal.js ===
 *
 * Snapshot-history modal: lists past on-disk snapshots for the currently
 * open file, lets the user preview one, and restores it with a regular
 * save (which takes a fresh pre-restore snapshot on the server first).
 *
 * The module owns its own DOM + internal state (which snapshot is
 * selected, which one is currently previewed). App dependencies flow
 * in through `initHistoryModal({getFile, onRestored})`:
 *   - getFile():  { path, content, extension } for the open file, or null.
 *   - onRestored(content): fires after a successful restore so the app can
 *                          re-render the preview.
 */

import { BASE, fetchOpts, mutFetchOpts } from '../core/api.js';
import { escHtml, formatByteSize } from '../core/utils.js';
import {
    flushSave,
    setSavedBaseline,
    setSaveStatus,
} from '../editor/auto-save.js';

const previewHistoryBtn = document.getElementById('previewHistory');
const historyOverlay   = document.getElementById('historyOverlay');
const historyClose     = document.getElementById('historyClose');
const historyList      = document.getElementById('historyList');
const historyPreview   = document.getElementById('historyPreview');
const historyRestore   = document.getElementById('historyRestore');

let getFile = () => null;
let onRestored = (_content) => {};

let currentSnapshots = [];
let selectedTs = null;
let selectedContent = null;

/** "20260409-120543-123" → "2026-04-09 12:05:43" */
function formatTs(ts) {
    if (!ts || ts.length < 15) return ts;
    const y  = ts.slice(0, 4),  m  = ts.slice(4, 6),  d  = ts.slice(6, 8);
    const hh = ts.slice(9, 11), mm = ts.slice(11, 13), ss = ts.slice(13, 15);
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

async function openModal() {
    const file = getFile();
    if (!file) return;
    // Flush pending edits first so they're visible as the newest snapshot.
    await flushSave({ silent: true });

    selectedTs = null;
    selectedContent = null;
    historyRestore.disabled = true;
    historyPreview.innerHTML = '<div class="history-preview-empty">Select a snapshot to preview</div>';
    historyList.innerHTML = '<div class="history-list-empty">Loading…</div>';
    historyOverlay.classList.add('active');

    try {
        const res = await fetch(
            `${BASE}/api/snapshots?path=${encodeURIComponent(file.path)}`,
            fetchOpts,
        );
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        currentSnapshots = data.snapshots || [];
        if (currentSnapshots.length === 0) {
            historyList.innerHTML = '<div class="history-list-empty">No snapshots yet.<br>Make a change to create one.</div>';
            return;
        }
        historyList.innerHTML = currentSnapshots.map((s) => `
            <div class="history-item" data-ts="${escHtml(s.ts)}">
                <div class="history-item-ts">${formatTs(s.ts)}</div>
                <div class="history-item-size">${formatByteSize(s.size)}</div>
            </div>
        `).join('');
        historyList.querySelectorAll('.history-item').forEach(el => {
            el.addEventListener('click', () => {
                historyList.querySelectorAll('.history-item').forEach(x => x.classList.remove('active'));
                el.classList.add('active');
                loadSnapshot(el.dataset.ts);
            });
        });
    } catch (err) {
        historyList.innerHTML = `<div class="history-list-empty">Error: ${escHtml(err.message)}</div>`;
    }
}

async function loadSnapshot(ts) {
    const file = getFile();
    if (!file) return;
    selectedTs = ts;
    selectedContent = null;
    historyRestore.disabled = true;
    historyPreview.innerHTML = '<div class="history-preview-empty">Loading…</div>';
    try {
        const url = `${BASE}/api/snapshots/content?path=${encodeURIComponent(file.path)}&ts=${encodeURIComponent(ts)}`;
        const res = await fetch(url, fetchOpts);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        selectedContent = data.content;
        historyPreview.innerHTML = `<pre>${escHtml(data.content)}</pre>`;
        historyRestore.disabled = false;
    } catch (err) {
        historyPreview.innerHTML = `<div class="history-preview-empty">Error: ${escHtml(err.message)}</div>`;
    }
}

function closeModal() {
    historyOverlay.classList.remove('active');
    selectedTs = null;
    selectedContent = null;
}

async function restoreSelected() {
    const file = getFile();
    if (!file || selectedContent == null) return;
    // Save restores as a normal write — the server takes a fresh snapshot
    // of the current (pre-restore) content first, so the restore itself
    // is reversible.
    try {
        const res = await fetch(`${BASE}/api/save`, mutFetchOpts({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: file.path, content: selectedContent }),
        }));
        if (!res.ok) throw new Error(await res.text());
        file.content = selectedContent;
        setSavedBaseline(selectedContent);
        setSaveStatus('saved');
        closeModal();
        onRestored(selectedContent);
    } catch (err) {
        alert('Restore failed: ' + err.message);
    }
}

/** Wire DOM events. Call once on app startup. */
export function initHistoryModal(deps) {
    getFile = deps.getFile;
    if (deps.onRestored) onRestored = deps.onRestored;

    previewHistoryBtn.addEventListener('click', openModal);
    historyClose.addEventListener('click', closeModal);
    historyOverlay.addEventListener('click', (e) => {
        if (e.target === historyOverlay) closeModal();
    });
    historyRestore.addEventListener('click', restoreSelected);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && historyOverlay.classList.contains('active')) {
            closeModal();
        }
    });
}
