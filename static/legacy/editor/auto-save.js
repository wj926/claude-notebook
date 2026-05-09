/* === Claude Notebook — editor/auto-save.js ===
 *
 * Auto-save state machine for the preview editors (markdown, CSV,
 * timetable, datetable, plain text). The different editors disagree on
 * *how* to materialize their current content, so the module does not
 * look inside any of them — callers supply a `getContent()` callback
 * that returns a string (or null if the editor isn't ready).
 *
 * Responsibilities kept here:
 *   - 1.5s debounce on scheduleSave()
 *   - "dirty / saving / saved / error" status pill updates
 *   - dedup against a "last saved" baseline so repeated saves of the
 *     same content are no-ops (also the source of truth for Esc-revert)
 *   - serialization guard so two PUTs never run concurrently
 */

import { BASE, mutFetchOpts } from '../core/api.js';

export const AUTO_SAVE_DEBOUNCE_MS = 1500;

let statusEl = null;
let getContent = () => null;
let getPath = () => null;
let onSaved = (_content) => {};

let saveTimer = null;
let lastSavedContent = null;
let saveInFlight = false;

/** Must be called once on app startup (and once per tab/life).
 *  - statusEl: the pill element whose `data-state` reflects save status.
 *  - getContent(): returns the current editor's content as a string, or
 *    null if no editor is active.
 *  - getPath(): returns the workspace-absolute path, or null.
 *  - onSaved(content): optional — fired after each successful PUT so the
 *    app can keep any mirrored copies of the content in sync. */
export function initAutoSave(deps) {
    statusEl = deps.statusEl;
    getContent = deps.getContent;
    getPath = deps.getPath;
    if (deps.onSaved) onSaved = deps.onSaved;
}

/** Update the toolbar pill. No-op if the pill isn't in the DOM. */
export function setSaveStatus(state) {
    if (!statusEl) return;
    statusEl.dataset.state = state;
}

/** True when there is a debounced save pending. */
export function hasPendingSave() {
    return saveTimer != null;
}

/** Current "known-on-disk" baseline. Used by Esc-revert and by editor
 *  bootstrap code that wants to compare against what was loaded. */
export function getSavedBaseline() {
    return lastSavedContent;
}

/** Explicitly set the baseline. Callers use this when loading a file,
 *  restoring a snapshot, or after the Notion editor boots (so a pure
 *  round-trip through domToMarkdown doesn't flag as dirty). */
export function setSavedBaseline(content) {
    lastSavedContent = content;
}

/** Cancel any pending debounced save. Does not touch lastSavedContent. */
export function cancelPendingSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
}

/** Full reset — call when switching to a different file. */
export function resetAutoSave() {
    cancelPendingSave();
    lastSavedContent = null;
    saveInFlight = false;
}

/** Schedule a debounced save. Called on every user mutation. */
export function scheduleSave() {
    if (!getPath()) return;
    cancelPendingSave();
    setSaveStatus('dirty');
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flushSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
}

/** Write current content to disk immediately, bypassing the debounce. */
export async function flushSave({ silent = false } = {}) {
    cancelPendingSave();
    const path = getPath();
    if (!path) return;
    const content = getContent();
    if (content == null) return;
    if (content === lastSavedContent) {
        if (!silent) setSaveStatus('saved');
        return;
    }
    if (saveInFlight) {
        // Another save is running; re-schedule a short retry so the
        // latest content always gets written.
        saveTimer = setTimeout(() => {
            saveTimer = null;
            flushSave({ silent });
        }, 200);
        return;
    }
    saveInFlight = true;
    if (!silent) setSaveStatus('saving');
    try {
        const res = await fetch(`${BASE}/api/save`, mutFetchOpts({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content }),
        }));
        if (!res.ok) throw new Error(await res.text());
        lastSavedContent = content;
        onSaved(content);
        if (!silent) setSaveStatus('saved');
        return content;
    } catch (err) {
        console.warn('Auto-save failed:', err);
        if (!silent) setSaveStatus('error');
    } finally {
        saveInFlight = false;
    }
}
