/* === Claude Notebook — views/csv.js ===
 *
 * CSV viewer + editor + per-file preferences (column widths, row
 * colors, conditional rules, checkbox columns) + color-rule modal.
 *
 * The module owns its own DOM lookups and transient state (the
 * currently-edited row/col matrix, the context-menu element, the cache
 * of server-side preferences). The only app-level dependency is the
 * path of the currently-open file, which app.js passes via an init-time
 * callback so the module can persist preferences per file.
 */

import { BASE, fetchOpts, mutFetchOpts } from '../core/api.js';
import { escHtml } from '../core/utils.js';
import { scheduleSave } from '../editor/auto-save.js';

export const CSV_EXTS = ['.csv'];

const previewBody = document.getElementById('previewBody');
const previewColorRules = document.getElementById('previewColorRules');

let getFilePath = () => '';

// ---------- Parser & serializer (RFC 4180) ----------

export function parseCsv(text) {
    const rows = [];
    let i = 0;
    const len = text.length;
    while (i < len) {
        const row = [];
        while (i < len) {
            let val = '';
            if (text[i] === '"') {
                i++;
                while (i < len) {
                    if (text[i] === '"') {
                        if (i + 1 < len && text[i + 1] === '"') { val += '"'; i += 2; }
                        else { i++; break; }
                    } else { val += text[i]; i++; }
                }
            } else {
                while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
                    val += text[i]; i++;
                }
            }
            row.push(val);
            if (i < len && text[i] === ',') { i++; }
            else break;
        }
        if (i < len && text[i] === '\r') i++;
        if (i < len && text[i] === '\n') i++;
        if (row.length > 1 || row[0] !== '' || i < len) rows.push(row);
    }
    return rows;
}

export function csvStringify(rows) {
    return rows.map(row => row.map(cell => {
        if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
            return '"' + cell.replace(/"/g, '""') + '"';
        }
        return cell;
    }).join(',')).join('\n');
}

// ---------- Per-file preferences (server config API) ----------

const CONFIG_API = BASE + '/api/config';
let csvConfigCache = null;

export async function loadCsvConfig() {
    if (csvConfigCache) return csvConfigCache;
    try {
        const res = await fetch(`${CONFIG_API}?key=csv-preferences`, fetchOpts);
        if (res.ok) csvConfigCache = await res.json();
    } catch (_) {}
    if (!csvConfigCache || typeof csvConfigCache !== 'object') csvConfigCache = {};
    if (!csvConfigCache.colWidths)    csvConfigCache.colWidths = {};
    if (!csvConfigCache.rowColors)    csvConfigCache.rowColors = {};
    if (!csvConfigCache.colorRules)   csvConfigCache.colorRules = {};
    if (!csvConfigCache.checkboxCols) csvConfigCache.checkboxCols = {};
    return csvConfigCache;
}

function saveCsvConfig() {
    if (!csvConfigCache) return;
    fetch(CONFIG_API, mutFetchOpts({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'csv-preferences', data: csvConfigCache }),
    })).catch(() => {});
}

function ensureCache() {
    if (!csvConfigCache) csvConfigCache = { colWidths: {}, rowColors: {}, colorRules: {}, checkboxCols: {} };
    return csvConfigCache;
}

function saveCsvColWidths(path, widths)    { ensureCache().colWidths[path] = widths;       saveCsvConfig(); }
function loadCsvColWidths(path)            { return (csvConfigCache && csvConfigCache.colWidths) ? csvConfigCache.colWidths[path] || null : null; }
function saveCsvColorRules(path, rules)    { ensureCache().colorRules[path] = rules;        saveCsvConfig(); }
function loadCsvColorRules(path)           { return (csvConfigCache && csvConfigCache.colorRules) ? csvConfigCache.colorRules[path] || null : null; }
function saveCsvCheckboxCols(path, cols)   { ensureCache().checkboxCols[path] = cols;       saveCsvConfig(); }
function loadCsvCheckboxCols(path)         { return (csvConfigCache && csvConfigCache.checkboxCols) ? csvConfigCache.checkboxCols[path] || null : null; }

const ROW_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const RULE_OPS = [
    { value: 'equals',   label: 'equals'   },
    { value: 'contains', label: 'contains' },
    { value: 'gt',       label: '>'        },
    { value: 'lt',       label: '<'        },
    { value: 'empty',    label: 'is empty' },
];

function matchColorRule(rule, cellValue) {
    const val = (cellValue || '').trim();
    switch (rule.op) {
        case 'equals':   return val.toLowerCase() === rule.value.toLowerCase();
        case 'contains': return val.toLowerCase().includes(rule.value.toLowerCase());
        case 'gt':       return !isNaN(parseFloat(val)) && parseFloat(val) > parseFloat(rule.value);
        case 'lt':       return !isNaN(parseFloat(val)) && parseFloat(val) < parseFloat(rule.value);
        case 'empty':    return val === '';
        default:         return false;
    }
}

function getConditionalColor(row, headers, rules) {
    if (!rules || rules.length === 0) return '';
    for (const rule of rules) {
        const colIdx = headers.indexOf(rule.column);
        if (colIdx < 0) continue;
        if (matchColorRule(rule, row[colIdx])) return rule.color;
    }
    return '';
}

// ---------- Color rules modal ----------

function showColorRulesModal(filePath, headers, colorRules, onSave) {
    let rules = JSON.parse(JSON.stringify(colorRules || []));
    const overlay = document.createElement('div');
    overlay.className = 'color-rules-overlay';

    function renderModal() {
        let rulesHtml = '';
        rules.forEach((rule, i) => {
            const colOpts = headers.map(h => `<option value="${escHtml(h)}"${rule.column === h ? ' selected' : ''}>${escHtml(h)}</option>`).join('');
            const opOpts = RULE_OPS.map(o => `<option value="${o.value}"${rule.op === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
            const colorDots = ROW_COLORS.map(c =>
                `<div class="csv-color-dot${rule.color === c ? ' active' : ''}" data-color="${c}" data-rule="${i}"></div>`
            ).join('');
            const needsValue = rule.op !== 'empty';
            rulesHtml += `
                <div class="color-rule-row" data-idx="${i}">
                    <select class="rule-col" data-idx="${i}">${colOpts}</select>
                    <select class="rule-op" data-idx="${i}">${opOpts}</select>
                    <input class="rule-val" data-idx="${i}" placeholder="value" value="${escHtml(rule.value || '')}" ${needsValue ? '' : 'style="display:none"'}>
                    <div class="rule-colors">${colorDots}</div>
                    <button class="rule-delete" data-idx="${i}" title="Delete">&times;</button>
                </div>`;
        });

        overlay.innerHTML = `
            <div class="color-rules-modal">
                <h3>Color Rules</h3>
                <div class="color-rules-list">${rulesHtml || '<div class="color-rules-empty">No rules defined</div>'}</div>
                <div class="color-rules-actions">
                    <button class="color-rules-add">+ Add Rule</button>
                    <button class="color-rules-reset-rules" title="Remove all rules">Reset Rules</button>
                </div>
                <div class="color-rules-buttons">
                    <button class="color-rules-cancel">Cancel</button>
                    <button class="color-rules-save">Save</button>
                </div>
            </div>`;

        overlay.querySelectorAll('.rule-col').forEach(sel => {
            sel.addEventListener('change', () => { rules[parseInt(sel.dataset.idx)].column = sel.value; });
        });
        overlay.querySelectorAll('.rule-op').forEach(sel => {
            sel.addEventListener('change', () => {
                const idx = parseInt(sel.dataset.idx);
                rules[idx].op = sel.value;
                const valInput = overlay.querySelector(`.rule-val[data-idx="${idx}"]`);
                valInput.style.display = sel.value === 'empty' ? 'none' : '';
            });
        });
        overlay.querySelectorAll('.rule-val').forEach(inp => {
            inp.addEventListener('input', () => { rules[parseInt(inp.dataset.idx)].value = inp.value; });
        });
        overlay.querySelectorAll('.csv-color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                const idx = parseInt(dot.dataset.rule);
                rules[idx].color = dot.dataset.color;
                overlay.querySelectorAll(`.csv-color-dot[data-rule="${idx}"]`).forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
            });
        });
        overlay.querySelectorAll('.rule-delete').forEach(btn => {
            btn.addEventListener('click', () => {
                rules.splice(parseInt(btn.dataset.idx), 1);
                renderModal();
            });
        });
        overlay.querySelector('.color-rules-add').addEventListener('click', () => {
            rules.push({ column: headers[0] || '', op: 'equals', value: '', color: 'red' });
            renderModal();
        });
        overlay.querySelector('.color-rules-reset-rules').addEventListener('click', () => {
            if (confirm('Remove all color rules?')) {
                rules = [];
                renderModal();
            }
        });
        overlay.querySelector('.color-rules-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.color-rules-save').addEventListener('click', () => {
            onSave(rules);
            overlay.remove();
        });
    }

    renderModal();
    document.body.appendChild(overlay);
}

// ---------- Viewer (read-only with sort, filter, color) ----------

export function renderCsvViewer(content) {
    const rows = parseCsv(content);
    if (rows.length === 0) {
        previewBody.innerHTML = '<p style="padding:20px;color:var(--text-secondary);">Empty CSV</p>';
        return;
    }

    // Keep csvEditRows in sync with the viewer's initial state so
    // csvTableToString() can serialize even before editor mode is shown.
    csvEditRows = rows.map(r => [...r]);

    const headers = rows[0];
    let dataRows = rows.slice(1);
    let sortCol = -1, sortAsc = true;
    let filters = headers.map(() => '');
    const filePath = getFilePath();

    let colWidths = loadCsvColWidths(filePath);
    if (!colWidths || colWidths.length !== headers.length) {
        colWidths = headers.map(() => 150);
    }

    let colorRules = loadCsvColorRules(filePath) || [];
    const checkboxCols = loadCsvCheckboxCols(filePath) || [];

    previewColorRules.onclick = () => {
        showColorRulesModal(filePath, headers, colorRules, (newRules) => {
            colorRules = newRules;
            saveCsvColorRules(filePath, colorRules);
            render();
        });
    };

    function render() {
        let filtered = dataRows.map((row, i) => ({ row, origIdx: i })).filter(({ row }) =>
            headers.every((_, ci) => {
                if (!filters[ci]) return true;
                return (row[ci] || '').toLowerCase().includes(filters[ci].toLowerCase());
            })
        );
        if (sortCol >= 0) {
            filtered.sort((a, b) => {
                const va = a.row[sortCol] || '', vb = b.row[sortCol] || '';
                const na = Number(va), nb = Number(vb);
                let cmp = (va.trim() !== '' && vb.trim() !== '' && !isNaN(na) && !isNaN(nb))
                    ? na - nb : va.localeCompare(vb);
                return sortAsc ? cmp : -cmp;
            });
        }

        const totalW = colWidths.reduce((s, w) => s + w, 0);
        let html = `<div class="csv-viewer"><table class="csv-table" style="width:${totalW}px"><colgroup>`;
        headers.forEach((_, ci) => { html += `<col style="width:${colWidths[ci]}px">`; });
        html += '</colgroup><thead><tr>';
        headers.forEach((h, ci) => {
            const arrow = sortCol === ci ? (sortAsc ? ' &#9650;' : ' &#9660;') : '';
            html += `<th data-col="${ci}">${escHtml(h)}${arrow}<span class="csv-resize-handle" data-col="${ci}"></span></th>`;
        });
        html += '</tr><tr class="csv-filter-row">';
        headers.forEach((_, ci) => {
            html += `<th><input class="csv-filter" data-col="${ci}" placeholder="Filter..." value="${escHtml(filters[ci])}"></th>`;
        });
        html += '</tr></thead><tbody>';
        filtered.forEach(({ row, origIdx }) => {
            checkboxCols.forEach(ci => {
                if (ci < row.length) {
                    const v = (row[ci] || '').toLowerCase();
                    if (v !== 'true') row[ci] = 'false';
                }
            });
            const color = getConditionalColor(row, headers, colorRules);
            const colorAttr = color && color !== 'none' ? ` data-color="${color}"` : '';
            html += `<tr${colorAttr} data-orig="${origIdx}">`;
            headers.forEach((_, ci) => {
                const val = row[ci] || '';
                if (checkboxCols.includes(ci)) {
                    const checked = val.toLowerCase() === 'true';
                    html += `<td class="csv-checkbox-cell"><input type="checkbox" class="csv-viewer-cb" data-orig="${origIdx}" data-col="${ci}"${checked ? ' checked' : ''}></td>`;
                } else {
                    const num = parseFloat(val);
                    const cls = !isNaN(num) && val.trim() !== '' ? ' num' : '';
                    html += `<td class="${cls}"><span class="csv-cell-text">${escHtml(val)}</span><button class="csv-cell-copy" title="Copy">&#x2398;</button></td>`;
                }
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        html += `<div class="csv-status">${filtered.length} of ${dataRows.length} rows</div>`;

        previewBody.innerHTML = html;

        previewBody.querySelectorAll('.csv-table thead th[data-col]').forEach(th => {
            th.style.cursor = 'pointer';
            th.addEventListener('click', (e) => {
                if (e.target.classList.contains('csv-resize-handle')) return;
                const ci = parseInt(th.dataset.col);
                if (sortCol === ci) sortAsc = !sortAsc;
                else { sortCol = ci; sortAsc = true; }
                render();
            });
        });
        previewBody.querySelectorAll('.csv-filter').forEach(input => {
            input.addEventListener('input', () => {
                filters[parseInt(input.dataset.col)] = input.value;
                render();
            });
        });
        previewBody.querySelectorAll('.csv-resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const ci = parseInt(handle.dataset.col);
                const startX = e.clientX;
                const startW = colWidths[ci];
                handle.classList.add('active');
                const table = previewBody.querySelector('.csv-table');
                const onMove = (me) => {
                    colWidths[ci] = Math.max(40, startW + me.clientX - startX);
                    const col = previewBody.querySelector(`col:nth-child(${ci + 1})`);
                    if (col) col.style.width = colWidths[ci] + 'px';
                    if (table) table.style.width = colWidths.reduce((s, w) => s + w, 0) + 'px';
                };
                const onUp = () => {
                    handle.classList.remove('active');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    saveCsvColWidths(filePath, colWidths);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
        previewBody.querySelectorAll('.csv-cell-copy').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const td = btn.parentElement;
                const text = td.querySelector('.csv-cell-text').textContent;
                navigator.clipboard.writeText(text).then(() => {
                    btn.classList.add('copied');
                    btn.innerHTML = '&#10003;';
                    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = '&#x2398;'; }, 1000);
                });
            });
        });
        previewBody.querySelectorAll('.csv-cell-text').forEach(span => {
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                renderCsvEditor(csvStringify(csvEditRows));
            });
        });
        previewBody.querySelectorAll('.csv-viewer-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                const origIdx = parseInt(cb.dataset.orig);
                const ci = parseInt(cb.dataset.col);
                dataRows[origIdx][ci] = cb.checked ? 'true' : 'false';
                csvEditRows = [headers, ...dataRows].map(r => [...r]);
                scheduleSave();
                render();
            });
        });
    }
    render();
}

// ---------- Editor (add/delete row/col, drag reorder, checkbox columns) ----------

let csvEditRows = [];
let csvContextEl = null;

function showCsvContextMenu(x, y, rowIdx, colIdx) {
    hideCsvContextMenu();
    csvContextEl = document.createElement('div');
    csvContextEl.className = 'finder-context';
    csvContextEl.style.left = x + 'px';
    csvContextEl.style.top = y + 'px';
    const actions = [];
    if (csvEditRows.length > 1) {
        actions.push({ label: 'Delete Row', cls: 'danger', action: () => {
            csvEditRows.splice(rowIdx, 1);
            scheduleSave();
            renderCsvEditTable();
        }});
    }
    if (csvEditRows[0].length > 1) {
        actions.push({ label: 'Delete Column', cls: 'danger', action: () => {
            csvEditRows.forEach(r => r.splice(colIdx, 1));
            const filePath = getFilePath();
            let cbCols = loadCsvCheckboxCols(filePath);
            if (cbCols) {
                cbCols = cbCols.filter(c => c !== colIdx).map(c => c > colIdx ? c - 1 : c);
                saveCsvCheckboxCols(filePath, cbCols);
            }
            scheduleSave();
            renderCsvEditTable();
        }});
    }
    actions.forEach(({ label, cls, action }) => {
        const el = document.createElement('div');
        el.className = 'finder-context-item' + (cls ? ' ' + cls : '');
        el.textContent = label;
        el.addEventListener('click', () => { hideCsvContextMenu(); action(); });
        csvContextEl.appendChild(el);
    });
    document.body.appendChild(csvContextEl);
    const rect = csvContextEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) csvContextEl.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) csvContextEl.style.top = (y - rect.height) + 'px';
}

function hideCsvContextMenu() {
    if (csvContextEl) { csvContextEl.remove(); csvContextEl = null; }
}

export function renderCsvEditor(content) {
    csvEditRows = parseCsv(content);
    if (csvEditRows.length === 0) csvEditRows = [['']];
    renderCsvEditTable();
}

function renderCsvEditTable() {
    const oldScroll = previewBody.querySelector('.csv-edit-scroll');
    const scrollTop = oldScroll ? oldScroll.scrollTop : 0;
    const scrollLeft = oldScroll ? oldScroll.scrollLeft : 0;

    const rows = csvEditRows;
    const maxCols = Math.max(...rows.map(r => r.length));
    rows.forEach(r => { while (r.length < maxCols) r.push(''); });

    const filePath = getFilePath();
    let colWidths = loadCsvColWidths(filePath);
    if (!colWidths || colWidths.length !== maxCols) {
        colWidths = new Array(maxCols).fill(150);
    }
    let checkboxCols = loadCsvCheckboxCols(filePath) || [];

    let html = '<div class="csv-editor"><div class="csv-edit-toolbar">';
    html += '<button class="csv-edit-btn" id="csvAddRow">+ Row</button>';
    html += '<button class="csv-edit-btn" id="csvAddCol">+ Column</button>';
    html += '</div>';
    const totalW = 36 + colWidths.reduce((s, w) => s + w, 0);
    html += `<div class="csv-edit-scroll"><table class="csv-table csv-edit-table" style="width:${totalW}px"><colgroup>`;
    html += '<col style="width:36px">';
    for (let ci = 0; ci < maxCols; ci++) { html += `<col style="width:${colWidths[ci]}px">`; }
    html += '</colgroup><thead><tr class="csv-col-drag-row"><td></td>';
    for (let ci = 0; ci < maxCols; ci++) {
        const isCb = checkboxCols.includes(ci);
        html += `<td class="csv-col-actions"><span class="csv-drag-handle csv-col-drag" data-col="${ci}" title="Drag to reorder">&#8801;</span><button class="csv-cb-toggle${isCb ? ' active' : ''}" data-col="${ci}" title="Toggle checkbox column">&#9745;</button></td>`;
    }
    html += '</tr></thead><tbody>';
    rows.forEach((row, ri) => {
        html += '<tr>';
        html += `<td class="csv-row-actions"><span class="csv-drag-handle csv-row-drag" data-row="${ri}" title="Drag to reorder">&#9776;</span></td>`;
        row.forEach((cell, ci) => {
            const isHeader = ri === 0 ? ' csv-header-cell' : '';
            const resizer = ri === 0 ? `<span class="csv-resize-handle" data-col="${ci}"></span>` : '';
            if (checkboxCols.includes(ci) && ri > 0) {
                const checked = cell.toLowerCase() === 'true';
                html += `<td class="csv-cell csv-checkbox-cell" data-row="${ri}" data-col="${ci}"><input type="checkbox" class="csv-checkbox" data-row="${ri}" data-col="${ci}"${checked ? ' checked' : ''}></td>`;
            } else {
                html += `<td class="csv-cell${isHeader}" contenteditable="true" data-row="${ri}" data-col="${ci}">${escHtml(cell)}${resizer}</td>`;
            }
        });
        html += '</tr>';
    });
    html += '</tbody></table></div></div>';

    previewBody.innerHTML = html;

    const newScroll = previewBody.querySelector('.csv-edit-scroll');
    if (newScroll) { newScroll.scrollTop = scrollTop; newScroll.scrollLeft = scrollLeft; }

    previewBody.querySelectorAll('.csv-cell').forEach(td => {
        td.addEventListener('blur', () => {
            const ri = parseInt(td.dataset.row), ci = parseInt(td.dataset.col);
            const newVal = td.textContent;
            if (csvEditRows[ri][ci] !== newVal) {
                csvEditRows[ri][ci] = newVal;
                scheduleSave();
            }
        });
        td.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                td.blur();
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                const ri = parseInt(td.dataset.row), ci = parseInt(td.dataset.col);
                const next = e.shiftKey
                    ? previewBody.querySelector(`.csv-cell[data-row="${ci > 0 ? ri : ri - 1}"][data-col="${ci > 0 ? ci - 1 : csvEditRows[0].length - 1}"]`)
                    : previewBody.querySelector(`.csv-cell[data-row="${ci < csvEditRows[0].length - 1 ? ri : ri + 1}"][data-col="${ci < csvEditRows[0].length - 1 ? ci + 1 : 0}"]`);
                if (next) { td.blur(); next.focus(); }
            }
        });
    });

    document.getElementById('csvAddRow').addEventListener('click', () => {
        csvEditRows.push(new Array(csvEditRows[0].length).fill(''));
        scheduleSave();
        renderCsvEditTable();
    });
    document.getElementById('csvAddCol').addEventListener('click', () => {
        csvEditRows.forEach(r => r.push(''));
        scheduleSave();
        renderCsvEditTable();
    });
    previewBody.querySelectorAll('.csv-cell').forEach(td => {
        td.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showCsvContextMenu(e.clientX, e.clientY, parseInt(td.dataset.row), parseInt(td.dataset.col));
        });
    });
    previewBody.querySelectorAll('.csv-cb-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const ci = parseInt(btn.dataset.col);
            previewBody.querySelectorAll('.csv-cell[contenteditable]').forEach(td => {
                csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
            });
            const headerName = csvEditRows[0][ci] || '';
            if (checkboxCols.includes(ci)) {
                checkboxCols = checkboxCols.filter(c => c !== ci);
                let rules = loadCsvColorRules(filePath) || [];
                rules = rules.filter(r => !(r.column === headerName && r._checkbox));
                saveCsvColorRules(filePath, rules);
            } else {
                checkboxCols.push(ci);
                for (let ri = 1; ri < csvEditRows.length; ri++) {
                    csvEditRows[ri][ci] = 'false';
                }
                let rules = loadCsvColorRules(filePath) || [];
                rules.push({ column: headerName, op: 'equals', value: 'true',  color: 'red',  _checkbox: true });
                rules.push({ column: headerName, op: 'equals', value: 'false', color: 'none', _checkbox: true });
                saveCsvColorRules(filePath, rules);
            }
            saveCsvCheckboxCols(filePath, checkboxCols);
            scheduleSave();
            renderCsvEditTable();
        });
    });
    previewBody.querySelectorAll('.csv-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
            const ri = parseInt(cb.dataset.row), ci = parseInt(cb.dataset.col);
            csvEditRows[ri][ci] = cb.checked ? 'true' : 'false';
            scheduleSave();
        });
    });
    previewBody.querySelectorAll('.csv-row-drag').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            previewBody.querySelectorAll('.csv-cell').forEach(td => {
                csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
            });
            const fromIdx = parseInt(handle.dataset.row);
            const table = previewBody.querySelector('.csv-edit-table');
            const tbody = table.querySelector('tbody');
            const allRows = Array.from(tbody.querySelectorAll('tr')).filter(tr => !tr.classList.contains('csv-col-actions-row'));
            const dragRow = allRows[fromIdx];
            if (!dragRow) return;

            dragRow.classList.add('csv-dragging');
            let toIdx = fromIdx;

            const onMove = (me) => {
                allRows.forEach((tr, i) => {
                    tr.classList.remove('csv-drag-over-top', 'csv-drag-over-bottom');
                    const rect = tr.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    if (me.clientY >= rect.top && me.clientY < rect.bottom) {
                        toIdx = me.clientY < midY ? i : i;
                        if (i !== fromIdx) {
                            tr.classList.add(me.clientY < midY ? 'csv-drag-over-top' : 'csv-drag-over-bottom');
                        }
                    }
                });
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                allRows.forEach(tr => tr.classList.remove('csv-dragging', 'csv-drag-over-top', 'csv-drag-over-bottom'));
                if (toIdx !== fromIdx) {
                    const [moved] = csvEditRows.splice(fromIdx, 1);
                    csvEditRows.splice(toIdx, 0, moved);
                    scheduleSave();
                    renderCsvEditTable();
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
    previewBody.querySelectorAll('.csv-col-drag').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            previewBody.querySelectorAll('.csv-cell').forEach(td => {
                csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
            });
            const fromIdx = parseInt(handle.dataset.col);
            const table = previewBody.querySelector('.csv-edit-table');
            const headerRow = table.querySelector('tbody tr');
            const headerCells = Array.from(headerRow.querySelectorAll('.csv-cell'));
            let toIdx = fromIdx;

            const highlightCol = (ci, cls) => {
                table.querySelectorAll(`td.csv-cell[data-col="${ci}"]`).forEach(td => td.classList.add(cls));
            };
            const clearHighlights = () => {
                table.querySelectorAll('.csv-drag-over-left, .csv-drag-over-right, .csv-col-dragging').forEach(td =>
                    td.classList.remove('csv-drag-over-left', 'csv-drag-over-right', 'csv-col-dragging'));
            };
            highlightCol(fromIdx, 'csv-col-dragging');

            const onMove = (me) => {
                clearHighlights();
                highlightCol(fromIdx, 'csv-col-dragging');
                headerCells.forEach((cell, i) => {
                    const rect = cell.getBoundingClientRect();
                    if (me.clientX >= rect.left && me.clientX < rect.right) {
                        toIdx = i;
                        if (i !== fromIdx) {
                            const cls = me.clientX < rect.left + rect.width / 2 ? 'csv-drag-over-left' : 'csv-drag-over-right';
                            highlightCol(i, cls);
                        }
                    }
                });
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                clearHighlights();
                if (toIdx !== fromIdx) {
                    csvEditRows.forEach(r => {
                        const [moved] = r.splice(fromIdx, 1);
                        r.splice(toIdx, 0, moved);
                    });
                    scheduleSave();
                    renderCsvEditTable();
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
    previewBody.querySelectorAll('.csv-edit-table .csv-resize-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ci = parseInt(handle.dataset.col);
            const startX = e.clientX;
            const startW = colWidths[ci];
            handle.classList.add('active');
            const table = previewBody.querySelector('.csv-edit-table');
            const onMove = (me) => {
                colWidths[ci] = Math.max(40, startW + me.clientX - startX);
                const col = previewBody.querySelector(`.csv-edit-table col:nth-child(${ci + 2})`);
                if (col) col.style.width = colWidths[ci] + 'px';
                if (table) table.style.width = (36 + colWidths.reduce((s, w) => s + w, 0)) + 'px';
            };
            const onUp = () => {
                handle.classList.remove('active');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                saveCsvColWidths(filePath, colWidths);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

/** Serialize the current editor state for auto-save. Also called from
 *  the viewer path where csvEditRows mirrors the rendered data. */
export function csvTableToString() {
    previewBody.querySelectorAll('.csv-cell[contenteditable]').forEach(td => {
        csvEditRows[parseInt(td.dataset.row)][parseInt(td.dataset.col)] = td.textContent;
    });
    return csvStringify(csvEditRows);
}

/** True when the CSV editor/viewer currently holds rows — the app uses
 *  this to decide whether `csvTableToString()` has something meaningful
 *  to serialize. */
export function hasCsvRows() {
    return csvEditRows && csvEditRows.length > 0;
}

export function initCsv(deps) {
    if (deps.getFilePath) getFilePath = deps.getFilePath;
    document.addEventListener('click', hideCsvContextMenu);
}
