/* === Claude Notebook — core/api.js ===
 *
 * Server-injected globals + fetch helpers + URL builders for the workspace
 * file API. Everything that needs to know about BASE / XSRF should funnel
 * through here so the rest of the app stays transport-agnostic.
 */

/** Mount path of the Jupyter extension (empty string when standalone). */
export const BASE = window.__VIEWER_BASE || '';

/** XSRF token injected by the server template; required by Jupyter for
 *  any state-mutating request. */
export const XSRF = window.__XSRF_TOKEN || '';

/** Default fetch options for safe (GET) requests. */
export const fetchOpts = {
    headers: { 'ngrok-skip-browser-warning': '1' },
    credentials: 'same-origin',
};

/** Merge XSRF + ngrok bypass headers into a fetch init for mutating
 *  requests (POST/PUT/DELETE). Caller-provided headers win on collision. */
export function mutFetchOpts(extra) {
    return {
        ...extra,
        credentials: 'same-origin',
        headers: {
            'ngrok-skip-browser-warning': '1',
            'X-XSRFToken': XSRF,
            ...(extra && extra.headers),
        },
    };
}

/** Build the raw-stream URL for a workspace-absolute path (used by
 *  <img>/<audio>/<video> src and direct download links). */
export function apiRawUrl(workspacePath) {
    return `${BASE}/api/file?path=${encodeURIComponent(workspacePath)}&raw=1`;
}

/** Normalize backslashes to forward slashes (Windows-side paths). */
export function normPath(p) {
    return p ? p.replace(/\\/g, '/') : p;
}

/** Fetch one tree level (children of `dirPath`) from the workspace API. */
export async function fetchTreeLevel(dirPath) {
    const url = dirPath
        ? `${BASE}/api/tree?path=${encodeURIComponent(dirPath)}`
        : `${BASE}/api/tree`;
    const res = await fetch(url, fetchOpts);
    if (!res.ok) throw new Error('Failed to load tree');
    const items = await res.json();
    items.forEach(item => { item.path = normPath(item.path); });
    return items;
}
