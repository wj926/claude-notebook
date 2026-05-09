/* === Claude Notebook — views/xlsx.js ===
 *
 * Read-only multi-sheet preview for .xlsx / .xls files. The server side
 * (WorkspaceXlsxHandler) reads the workbook with openpyxl and returns
 * one JSON payload per file: { sheets: [{name, rows: string[][]}] }.
 *
 * UI: a tab strip on top, the active sheet rendered as a plain table
 * (same styling family as the CSV viewer).
 */

import { BASE, fetchOpts } from '../core/api.js';
import { escHtml } from '../core/utils.js';

export const XLSX_EXTS = ['.xlsx', '.xls'];

const previewBody = document.getElementById('previewBody');

export async function renderXlsxViewer(filePath) {
    previewBody.innerHTML = '<div class="xlsx-loading">Loading…</div>';
    let data;
    try {
        const res = await fetch(`${BASE}/api/xlsx?path=${encodeURIComponent(filePath)}`, fetchOpts);
        if (!res.ok) throw new Error(await res.text());
        data = await res.json();
    } catch (err) {
        previewBody.innerHTML = `<p style="padding:20px;color:var(--text-secondary);">XLSX 미리보기 실패: ${escHtml(err.message || String(err))}</p>`;
        return;
    }

    const sheets = data.sheets || [];
    if (sheets.length === 0) {
        previewBody.innerHTML = '<p style="padding:20px;color:var(--text-secondary);">시트가 없습니다.</p>';
        return;
    }

    // Tab strip + a body slot the active sheet renders into.
    const tabStrip = sheets.length > 1
        ? '<div class="xlsx-tabs">' +
            sheets.map((s, i) =>
                `<button class="xlsx-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${escHtml(s.name)}</button>`
            ).join('') +
          '</div>'
        : '';
    previewBody.innerHTML = `
        <div class="xlsx-viewer">
            ${tabStrip}
            <div class="xlsx-sheet-body" id="xlsxSheetBody"></div>
        </div>`;

    const body = previewBody.querySelector('#xlsxSheetBody');
    let active = 0;

    function renderSheet(idx) {
        const sheet = sheets[idx];
        if (!sheet || !sheet.rows.length) {
            body.innerHTML = '<p class="xlsx-empty">빈 시트</p>';
            return;
        }
        const headers = sheet.rows[0];
        const dataRows = sheet.rows.slice(1);
        const colCount = Math.max(headers.length, ...dataRows.map(r => r.length));
        let html = '<div class="xlsx-scroll"><table class="csv-table xlsx-table"><thead><tr>';
        for (let ci = 0; ci < colCount; ci++) {
            html += `<th>${escHtml(headers[ci] || '')}</th>`;
        }
        html += '</tr></thead><tbody>';
        for (const row of dataRows) {
            html += '<tr>';
            for (let ci = 0; ci < colCount; ci++) {
                const val = row[ci] || '';
                const num = parseFloat(val);
                const cls = !isNaN(num) && val.trim() !== '' && /^-?\d+(\.\d+)?$/.test(val) ? ' num' : '';
                html += `<td class="${cls}">${escHtml(val)}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        html += `<div class="csv-status">${dataRows.length} rows × ${colCount} cols</div>`;
        body.innerHTML = html;
    }

    if (sheets.length > 1) {
        previewBody.querySelectorAll('.xlsx-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx, 10);
                if (idx === active) return;
                active = idx;
                previewBody.querySelectorAll('.xlsx-tab').forEach(b => b.classList.toggle('active', b === btn));
                renderSheet(idx);
            });
        });
    }
    renderSheet(0);
}
