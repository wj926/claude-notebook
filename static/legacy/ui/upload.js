/* === Claude Notebook — ui/upload.js ===
 *
 * File upload (drag-and-drop + finder toolbar). Handles both:
 *   - Small files: single XMLHttpRequest with upload-progress.
 *   - Large files (> 50 MB): chunked transfer with retry + resume-safe
 *     init/PUT/finalize protocol against /api/upload-chunk.
 *   - Empty folder drops: materialized server-side via /api/mkdir.
 *
 * Owns its own progress-bar DOM (injected into the finder container)
 * and a `cancel` button that aborts both XHR and the next chunk.
 */

import { BASE, XSRF, mutFetchOpts } from '../core/api.js';
import { formatSize } from '../core/utils.js';
import { loadTree } from './tree.js';

const CHUNK_SIZE = 50 * 1024 * 1024;          // 50 MB per chunk
const CHUNKED_THRESHOLD = 50 * 1024 * 1024;   // use chunked for files > 50 MB
const CHUNK_MAX_RETRIES = 3;
const MAX_UPLOAD_FILES = 100000;              // max files per DnD to avoid browser crash

let getCurrentDir = () => '';
let onUploaded = () => {};

// Progress-bar DOM (built once, attached to #finder)
const uploadProgressBar = document.createElement('div');
uploadProgressBar.className = 'upload-progress-bar';
uploadProgressBar.innerHTML = `
    <div class="upload-progress-info">
        <span class="upload-progress-label"></span>
        <span class="upload-progress-pct"></span>
        <button class="upload-cancel-btn" title="Cancel">&times;</button>
    </div>
    <div class="upload-progress-track"><div class="upload-progress-fill"></div></div>
`;
uploadProgressBar.style.display = 'none';

const uploadLabel    = uploadProgressBar.querySelector('.upload-progress-label');
const uploadPct      = uploadProgressBar.querySelector('.upload-progress-pct');
const uploadFill     = uploadProgressBar.querySelector('.upload-progress-fill');
const uploadCancelBtn = uploadProgressBar.querySelector('.upload-cancel-btn');

let uploadAborted = false;
let activeUploadId = null; // chunked upload_id (for cancel-cleanup)
let activeXhr = null;      // XHR for small-file cancel

uploadCancelBtn.addEventListener('click', () => {
    uploadAborted = true;
    if (activeXhr) { activeXhr.abort(); activeXhr = null; }
});

function showUploadProgress(label, pct) {
    uploadProgressBar.style.display = '';
    uploadLabel.textContent = label;
    uploadPct.textContent = pct < 100 ? `${pct}%` : 'Done';
    uploadFill.style.width = pct + '%';
    uploadCancelBtn.style.display = pct < 100 ? '' : 'none';
}

function hideUploadProgress() {
    uploadProgressBar.style.display = 'none';
    uploadFill.style.width = '0%';
    activeUploadId = null;
    activeXhr = null;
}

async function sendChunkWithRetry(url, opts, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, opts);
            if (res.ok) return res;
            if (attempt === retries) throw new Error(await res.text());
        } catch (err) {
            if (attempt === retries) throw err;
        }
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
}

async function uploadFileChunked(file, filename, targetDir, onProgress) {
    const initRes = await fetch(`${BASE}/api/upload-chunk`, mutFetchOpts({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-XSRFToken': XSRF },
        body: JSON.stringify({ filename, dir: targetDir || '', size: file.size }),
    }));
    if (!initRes.ok) throw new Error(await initRes.text());
    const { upload_id } = await initRes.json();
    activeUploadId = upload_id;

    let offset = 0;
    while (offset < file.size) {
        if (uploadAborted) {
            await fetch(
                `${BASE}/api/upload-chunk?id=${encodeURIComponent(upload_id)}&cancel=1`,
                mutFetchOpts({ method: 'DELETE' }),
            ).catch(() => {});
            throw new Error('Upload cancelled');
        }
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);
        await sendChunkWithRetry(
            `${BASE}/api/upload-chunk?id=${encodeURIComponent(upload_id)}`,
            mutFetchOpts({
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream', 'X-XSRFToken': XSRF },
                body: chunk,
            }),
            CHUNK_MAX_RETRIES,
        );
        offset = end;
        if (onProgress) onProgress(offset);
    }

    activeUploadId = null;
    const finRes = await fetch(
        `${BASE}/api/upload-chunk?id=${encodeURIComponent(upload_id)}`,
        mutFetchOpts({ method: 'DELETE' }),
    );
    if (!finRes.ok) throw new Error(await finRes.text());
}

async function uploadFiles(filesWithPaths, targetDir) {
    // Separate empty-folder placeholders (file === null) from real files
    const emptyDirs = filesWithPaths.filter(f => f.file === null);
    const realFiles = filesWithPaths.filter(f => f.file !== null);

    const totalSize = realFiles.reduce((s, f) => s + f.file.size, 0);
    const useChunked = realFiles.some(f => f.file.size > CHUNKED_THRESHOLD);
    uploadAborted = false;

    try {
        for (const { relativePath } of emptyDirs) {
            const dirPath = (targetDir ? targetDir + '/' : '') + relativePath.replace(/\/$/, '');
            await fetch(`${BASE}/api/mkdir`, mutFetchOpts({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: dirPath }),
            })).catch(() => {});
        }

        if (realFiles.length === 0) {
            onUploaded();
            return;
        }

        if (useChunked) {
            let bytesSent = 0;
            for (const { file, relativePath } of realFiles) {
                if (uploadAborted) throw new Error('Upload cancelled');
                const fname = relativePath || file.name;
                if (file.size > CHUNKED_THRESHOLD) {
                    const baseBytes = bytesSent;
                    await uploadFileChunked(file, fname, targetDir, (fileOffset) => {
                        const current = baseBytes + fileOffset;
                        const pct = Math.round((current / totalSize) * 100);
                        showUploadProgress(`${fname} (${formatSize(current)} / ${formatSize(totalSize)})`, pct);
                    });
                    bytesSent += file.size;
                } else {
                    const form = new FormData();
                    form.append('file', file, fname);
                    const res = await fetch(`${BASE}/api/upload?dir=${encodeURIComponent(targetDir || '')}`,
                        mutFetchOpts({ method: 'POST', body: form }));
                    if (!res.ok) throw new Error(await res.text());
                    bytesSent += file.size;
                }
                showUploadProgress(
                    `${fname} (${formatSize(bytesSent)} / ${formatSize(totalSize)})`,
                    Math.round((bytesSent / totalSize) * 100),
                );
            }
        } else {
            const form = new FormData();
            for (const { file, relativePath } of realFiles) {
                form.append('file', file, relativePath || file.name);
            }
            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                activeXhr = xhr;
                xhr.open('POST', `${BASE}/api/upload?dir=${encodeURIComponent(targetDir || '')}`);
                xhr.withCredentials = true;
                xhr.setRequestHeader('X-XSRFToken', XSRF);
                xhr.setRequestHeader('ngrok-skip-browser-warning', '1');
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        showUploadProgress(`${formatSize(e.loaded)} / ${formatSize(e.total)}`, pct);
                    }
                };
                xhr.onload = () => {
                    activeXhr = null;
                    (xhr.status >= 200 && xhr.status < 300)
                        ? resolve()
                        : reject(new Error(xhr.responseText));
                };
                xhr.onerror = () => { activeXhr = null; reject(new Error('Network error')); };
                xhr.onabort = () => { activeXhr = null; reject(new Error('Upload cancelled')); };
                xhr.send(form);
            });
        }
        onUploaded();
    } catch (err) {
        if (err.message !== 'Upload cancelled') alert('Upload failed: ' + err.message);
    } finally {
        setTimeout(hideUploadProgress, 1500);
    }
}

// Recursively collect files from a DataTransferItem entry
function readEntryRecursive(entry, counter) {
    return new Promise((resolve) => {
        if (counter.count > MAX_UPLOAD_FILES) return resolve([]);
        if (entry.isFile) {
            counter.count++;
            entry.file(
                (f) => resolve([{ file: f, relativePath: entry.fullPath.replace(/^\//, '') }]),
                () => resolve([]),
            );
        } else if (entry.isDirectory) {
            const dirPath = entry.fullPath.replace(/^\//, '');
            const reader = entry.createReader();
            const allEntries = [];
            const readBatch = () => {
                reader.readEntries(
                    async (entries) => {
                        if (entries.length === 0) {
                            const results = [];
                            for (const e of allEntries) {
                                if (counter.count > MAX_UPLOAD_FILES) break;
                                results.push(...await readEntryRecursive(e, counter));
                            }
                            // Empty folder → placeholder so server creates the directory
                            if (results.length === 0) {
                                results.push({ file: null, relativePath: dirPath + '/' });
                            }
                            resolve(results);
                        } else {
                            allEntries.push(...entries);
                            readBatch();
                        }
                    },
                    () => resolve([]),
                );
            };
            readBatch();
        } else {
            resolve([]);
        }
    });
}

async function collectDroppedFiles(dataTransfer) {
    const items = dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
        const allFiles = [];
        const counter = { count: 0 };
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry();
            if (entry) allFiles.push(...await readEntryRecursive(entry, counter));
            if (counter.count > MAX_UPLOAD_FILES) {
                alert(`파일 수가 ${counter.count.toLocaleString()}개를 초과했습니다.\n브라우저 업로드는 최대 ${MAX_UPLOAD_FILES.toLocaleString()}개까지 지원됩니다.\n대용량 폴더는 서버에서 직접 복사해주세요.`);
                return [];
            }
        }
        return allFiles;
    }
    const result = [];
    for (const f of dataTransfer.files) {
        result.push({ file: f, relativePath: f.name });
    }
    return result;
}

/** Wire the finder toolbar upload button + finder-area drag/drop.
 *  `getCurrentDir` lets callers target the directory the user currently
 *  has open; `onUploaded` fires after each successful upload batch so
 *  the app can refresh the finder / tree. */
export function initUpload(deps) {
    const finder = document.getElementById('finder');
    const finderUpload = document.getElementById('finderUpload');
    if (deps.getCurrentDir) getCurrentDir = deps.getCurrentDir;
    if (deps.onUploaded) onUploaded = deps.onUploaded;

    finder.appendChild(uploadProgressBar);

    finderUpload.addEventListener('change', async () => {
        const files = finderUpload.files;
        if (!files.length) return;
        const wrapped = Array.from(files).map(f => ({ file: f, relativePath: f.name }));
        await uploadFiles(wrapped, getCurrentDir());
        finderUpload.value = '';
    });

    // Prevent the browser from opening dropped files outside the finder area
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop',     (e) => e.preventDefault());

    finder.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        finder.classList.add('dragover');
    });
    finder.addEventListener('dragleave', (e) => {
        if (!finder.contains(e.relatedTarget)) finder.classList.remove('dragover');
    });
    finder.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        finder.classList.remove('dragover');
        const files = await collectDroppedFiles(e.dataTransfer);
        if (files.length) await uploadFiles(files, getCurrentDir());
    });
}
