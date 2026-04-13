/* === Claude Notebook — ui/file-ops.js ===
 *
 * CRUD operations on workspace files/folders that talk to the server.
 * Each function is a small, single-responsibility unit: send a request,
 * handle failure with a user-facing alert, and (optionally) call back
 * to the app so it can refresh downstream UI.
 *
 * Selection state stays in app.js; this module deals only with paths.
 */

import { BASE, XSRF, fetchOpts, mutFetchOpts } from '../core/api.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF };

function trigger(href, filename) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function saveBlobAs(blob, filename) {
    const url = URL.createObjectURL(blob);
    trigger(url, filename);
    URL.revokeObjectURL(url);
}

function filenameFromDisposition(disposition, fallback) {
    const utf8Match = disposition.match(/filename\*=UTF-8''(.+)/i);
    if (utf8Match) return decodeURIComponent(utf8Match[1]);
    const plainMatch = disposition.match(/filename="(.+?)"/);
    if (plainMatch) return plainMatch[1];
    return fallback;
}

// ---------- Download ----------

export async function downloadFile(path) {
    try {
        const res = await fetch(`${BASE}/api/download?path=${encodeURIComponent(path)}`, fetchOpts);
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        saveBlobAs(blob, filenameFromDisposition(disposition, path.split('/').pop()));
    } catch (err) {
        alert('Download failed: ' + err.message);
    }
}

export async function downloadPaths(paths) {
    try {
        const res = await fetch(`${BASE}/api/download-multi`, mutFetchOpts({
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ paths }),
        }));
        if (!res.ok) throw new Error('Download failed');
        saveBlobAs(await res.blob(), 'selected-files.zip');
    } catch (err) {
        alert('Download failed: ' + err.message);
    }
}

// ---------- Delete ----------

export async function deleteItem(item, onChanged) {
    if (!confirm(`Delete "${item.name}"?`)) return;
    try {
        const res = await fetch(`${BASE}/api/delete?path=${encodeURIComponent(item.path)}`,
            mutFetchOpts({ method: 'DELETE' }));
        if (!res.ok) throw new Error(await res.text());
        onChanged && onChanged();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
}

export async function deletePaths(paths, onChanged) {
    if (!confirm(`Delete ${paths.length} item(s)?`)) return false;
    try {
        const res = await fetch(`${BASE}/api/delete-multi`, mutFetchOpts({
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ paths }),
        }));
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (data.errors && data.errors.length) {
            alert('Some items failed to delete:\n' + data.errors.map(e => e.path + ': ' + e.error).join('\n'));
        }
        onChanged && onChanged();
        return true;
    } catch (err) {
        alert('Delete failed: ' + err.message);
        return false;
    }
}

// ---------- Rename ----------

export async function renameItem(item, onChanged) {
    const newName = prompt('Rename to:', item.name);
    if (!newName || !newName.trim() || newName.trim() === item.name) return;
    const parentPath = item.path.includes('/')
        ? item.path.substring(0, item.path.lastIndexOf('/'))
        : '';
    const newPath = parentPath ? parentPath + '/' + newName.trim() : newName.trim();
    try {
        const res = await fetch(`${BASE}/api/rename`, mutFetchOpts({
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ old_path: item.path, new_path: newPath }),
        }));
        if (!res.ok) throw new Error(await res.text());
        onChanged && onChanged();
    } catch (err) {
        alert('Rename failed: ' + err.message);
    }
}

// ---------- Create ----------

async function createEntry(endpoint, targetDir, promptMsg, errPrefix, onChanged) {
    const name = prompt(promptMsg);
    if (!name || !name.trim()) return;
    const path = targetDir ? targetDir + '/' + name.trim() : name.trim();
    try {
        const res = await fetch(`${BASE}/api/${endpoint}`, mutFetchOpts({
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ path }),
        }));
        if (!res.ok) throw new Error(await res.text());
        onChanged && onChanged();
    } catch (err) {
        alert(errPrefix + ': ' + err.message);
    }
}

export function createFile(targetDir, onChanged) {
    return createEntry('newfile', targetDir, 'New file name (e.g. note.md):', 'Failed to create file', onChanged);
}

export function createFolder(targetDir, onChanged) {
    return createEntry('mkdir', targetDir, 'New folder name:', 'Failed to create folder', onChanged);
}

/** Wire the finder-toolbar "+" buttons. Caller provides a `getCurrentDir`
 *  so the buttons always target the folder the user is currently viewing. */
export function initFileOpsButtons({ getCurrentDir, onChanged }) {
    document.getElementById('newFileBtn').addEventListener('click',
        () => createFile(getCurrentDir(), onChanged));
    document.getElementById('newFolderBtn').addEventListener('click',
        () => createFolder(getCurrentDir(), onChanged));
}
