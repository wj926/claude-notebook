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
// codex round 7: lost-update 보호 — read 시 받은 version, save 시 send + 409 시 confirm
let lastVersion = null;
export function setLastVersion(v) { lastVersion = v || null; }
export function getLastVersion() { return lastVersion; }

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
        const _h = window.__HOST || window.__currentHostId;
        const _hq = (_h && _h !== 'local') ? `?host=${encodeURIComponent(_h)}` : '';
        const doPut = async (force) => fetch(`${BASE}/api/save${_hq}`, mutFetchOpts({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path, content,
                version: lastVersion,
                ...(force ? { force: true } : {}),
            }),
        }));
        let res = await doPut(false);
        if (res.status === 409) {
            // Lost-update — 다른 곳에서 수정됨
            const data = await res.json().catch(() => ({}));
            if (silent) {
                // beforeunload flush 등 silent 컨텍스트는 force 로 보냄 (사용자
                // 응답 받을 시간 없음)
                res = await doPut(true);
            } else {
                const ok = confirm(
                    '이 파일이 다른 곳에서 변경되었습니다.\n' +
                    `(현재 디스크 version: ${data.actual || '?'})\n\n` +
                    '확인 = 내 변경으로 덮어쓰기\n취소 = 새로 받기 (편집 내용 잃음)'
                );
                if (!ok) {
                    setSaveStatus('error');
                    saveInFlight = false;
                    return null;
                }
                res = await doPut(true);
            }
        }
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json().catch(() => ({}));
        if (data.version) lastVersion = data.version;
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
