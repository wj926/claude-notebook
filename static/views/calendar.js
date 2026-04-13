/* === Claude Notebook — views/calendar.js ===
 *
 * Two custom file types that use a calendar UI:
 *   - .timetable  — weekly schedule with people columns & time slots.
 *   - .datetable  — monthly calendar with per-day events per person.
 *
 * Each renderer owns its own parsed data (`_timetableData` /
 * `_datetableData`). The app reaches into the module through
 * `getTimetableJson()` / `getDatetableJson()` when auto-save needs to
 * serialize the current state to disk.
 */

import { escHtml } from '../core/utils.js';
import { scheduleSave } from '../editor/auto-save.js';

export const TIMETABLE_EXTS = ['.timetable'];
export const DATETABLE_EXTS = ['.datetable'];

const previewBody = document.getElementById('previewBody');

const TT_DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
const TT_DAY_LABELS = ['월','화','수','목','금','토','일'];
const TT_COLORS = ['#4A90D9','#E67E73','#61BD4F','#F5A623','#8E6EC8','#00BCD4','#FF7043','#AED581','#CE93D8','#FFD54F'];

// ---------- Timetable ----------

let _timetableData = null;

function ttTimeSlots() {
    const slots = [];
    for (let h = 9; h <= 22; h++) {
        slots.push(`${String(h).padStart(2,'0')}:00`);
        slots.push(`${String(h).padStart(2,'0')}:30`);
    }
    return slots; // 09:00 ~ 22:30, 28 slots
}

function ttSlotIndex(time) { return ttTimeSlots().indexOf(time); }

export function renderTimetable(content, filePath, opts) {
    const initial = opts && opts.initial;
    try { _timetableData = JSON.parse(content); } catch { _timetableData = { people: [], schedule: {} }; }
    if (!_timetableData.people) _timetableData.people = [];
    if (!_timetableData.schedule) _timetableData.schedule = {};
    TT_DAYS.forEach(d => { if (!_timetableData.schedule[d]) _timetableData.schedule[d] = {}; });
    if (!initial) scheduleSave();

    const people = _timetableData.people;
    const schedule = _timetableData.schedule;
    const slots = ttTimeSlots();

    people.forEach((p, i) => { if (!p.color) p.color = TT_COLORS[i % TT_COLORS.length]; });

    let html = '<div class="tt-container">';
    html += '<div class="tt-toolbar">';
    html += '<span class="tt-toolbar-label">인원:</span>';
    people.forEach((p, i) => {
        html += `<span class="tt-person-tag" style="background:${p.color}" data-idx="${i}">${escHtml(p.name)} <span class="tt-person-remove" data-idx="${i}">&times;</span></span>`;
    });
    html += `<button class="tt-add-person-btn" id="ttAddPerson">+ 추가</button>`;
    html += '</div>';

    html += '<div class="tt-scroll"><table class="tt-table">';
    html += '<thead><tr><th class="tt-day-header tt-corner">시간</th>';
    TT_DAY_LABELS.forEach(d => {
        html += `<th colspan="${people.length || 1}" class="tt-day-header">${d}</th>`;
    });
    html += '</tr>';
    html += '<tr><th class="tt-person-header tt-corner"></th>';
    TT_DAYS.forEach(d => {
        if (people.length === 0) {
            html += '<th class="tt-person-header">-</th>';
        } else {
            people.forEach(p => {
                html += `<th class="tt-person-header" style="color:${p.color}">${escHtml(p.name)}</th>`;
            });
        }
    });
    html += '</tr></thead>';

    html += '<tbody>';
    slots.forEach((slot, si) => {
        html += '<tr>';
        html += `<td class="tt-time-cell">${slot}</td>`;
        TT_DAYS.forEach((day) => {
            if (people.length === 0) {
                html += '<td class="tt-cell tt-empty"></td>';
            } else {
                people.forEach((p) => {
                    const blocks = schedule[day]?.[p.name] || [];
                    const block = blocks.find(b => {
                        const s = ttSlotIndex(b.start), e = ttSlotIndex(b.end);
                        return si >= s && si < e;
                    });
                    if (block) {
                        const s = ttSlotIndex(block.start);
                        if (si === s) {
                            const span = ttSlotIndex(block.end) - s;
                            html += `<td class="tt-cell tt-block" rowspan="${span}" style="background:${p.color}20;border-left:3px solid ${p.color}" data-day="${day}" data-person="${p.name}" data-start="${block.start}" data-end="${block.end}"><span class="tt-block-label">${escHtml(block.label || '')}</span></td>`;
                        }
                    } else {
                        const covered = blocks.some(b => {
                            const s = ttSlotIndex(b.start), e = ttSlotIndex(b.end);
                            return si > s && si < e;
                        });
                        if (!covered) {
                            html += `<td class="tt-cell" data-day="${day}" data-person="${p.name}" data-slot="${slot}"></td>`;
                        }
                    }
                });
            }
        });
        html += '</tr>';
    });
    html += '</tbody></table></div></div>';
    previewBody.innerHTML = html;

    const addBtn = previewBody.querySelector('#ttAddPerson');
    if (addBtn) addBtn.addEventListener('click', () => {
        const name = prompt('인원 이름을 입력하세요:');
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        if (people.some(p => p.name === trimmed)) { alert('이미 존재하는 이름입니다.'); return; }
        people.push({ name: trimmed, color: TT_COLORS[people.length % TT_COLORS.length] });
        renderTimetable(JSON.stringify(_timetableData), filePath);
    });

    previewBody.querySelectorAll('.tt-person-remove').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.idx);
            const pName = people[idx].name;
            if (!confirm(`"${pName}"을(를) 삭제하시겠습니까?`)) return;
            TT_DAYS.forEach(d => { delete schedule[d]?.[pName]; });
            people.splice(idx, 1);
            renderTimetable(JSON.stringify(_timetableData), filePath);
        });
    });

    previewBody.querySelectorAll('.tt-cell[data-slot]').forEach(td => {
        td.addEventListener('click', () => {
            const day = td.dataset.day, person = td.dataset.person, slot = td.dataset.slot;
            const label = prompt(`${TT_DAY_LABELS[TT_DAYS.indexOf(day)]} ${slot} - ${person}\n일정명을 입력하세요:`);
            if (label === null) return;
            const si = ttSlotIndex(slot);
            const slots2 = ttTimeSlots();
            const endTime = prompt(`종료 시간을 입력하세요 (예: ${slots2[Math.min(si+2, slots2.length-1)] || '23:00'}):`, slots2[Math.min(si + 2, slots2.length - 1)] || '23:00');
            if (!endTime) return;
            if (!schedule[day]) schedule[day] = {};
            if (!schedule[day][person]) schedule[day][person] = [];
            schedule[day][person].push({ start: slot, end: endTime, label: label.trim() });
            schedule[day][person].sort((a, b) => ttSlotIndex(a.start) - ttSlotIndex(b.start));
            renderTimetable(JSON.stringify(_timetableData), filePath);
        });
    });

    previewBody.querySelectorAll('.tt-block').forEach(td => {
        td.addEventListener('click', () => {
            const day = td.dataset.day, person = td.dataset.person;
            const start = td.dataset.start, end = td.dataset.end;
            const blocks = schedule[day]?.[person] || [];
            const block = blocks.find(b => b.start === start && b.end === end);
            if (!block) return;
            const action = prompt(`"${block.label}" (${start}~${end})\n수정: 새 이름 입력\n삭제: "delete" 입력`, block.label);
            if (action === null) return;
            if (action.toLowerCase() === 'delete') {
                schedule[day][person] = blocks.filter(b => b !== block);
            } else {
                block.label = action.trim();
            }
            renderTimetable(JSON.stringify(_timetableData), filePath);
        });
    });

    let dragStart = null;
    previewBody.querySelectorAll('.tt-cell[data-slot]').forEach(td => {
        td.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragStart = { day: td.dataset.day, person: td.dataset.person, slot: td.dataset.slot, el: td };
            td.classList.add('tt-drag-active');
        });
        td.addEventListener('mouseenter', () => {
            if (!dragStart) return;
            if (td.dataset.day !== dragStart.day || td.dataset.person !== dragStart.person) return;
            previewBody.querySelectorAll('.tt-drag-active').forEach(el => el.classList.remove('tt-drag-active'));
            const s = Math.min(ttSlotIndex(dragStart.slot), ttSlotIndex(td.dataset.slot));
            const e2 = Math.max(ttSlotIndex(dragStart.slot), ttSlotIndex(td.dataset.slot));
            previewBody.querySelectorAll(`.tt-cell[data-day="${dragStart.day}"][data-person="${dragStart.person}"]`).forEach(c => {
                const ci = ttSlotIndex(c.dataset.slot);
                if (ci >= s && ci <= e2) c.classList.add('tt-drag-active');
            });
        });
    });
    document.addEventListener('mouseup', () => {
        if (!dragStart) return;
        const activeCells = previewBody.querySelectorAll('.tt-drag-active');
        if (activeCells.length > 1) {
            const slotsArr = Array.from(activeCells).map(c => c.dataset.slot).sort();
            const startSlot = slotsArr[0];
            const endIdx = ttSlotIndex(slotsArr[slotsArr.length - 1]) + 1;
            const allSlots = ttTimeSlots();
            const endSlot = endIdx < allSlots.length ? allSlots[endIdx] : '23:00';
            const day = dragStart.day, person = dragStart.person;
            const label = prompt(`${TT_DAY_LABELS[TT_DAYS.indexOf(day)]} ${startSlot}~${endSlot} - ${person}\n일정명을 입력하세요:`);
            if (label !== null && label.trim()) {
                if (!schedule[day]) schedule[day] = {};
                if (!schedule[day][person]) schedule[day][person] = [];
                schedule[day][person].push({ start: startSlot, end: endSlot, label: label.trim() });
                schedule[day][person].sort((a, b) => ttSlotIndex(a.start) - ttSlotIndex(b.start));
                renderTimetable(JSON.stringify(_timetableData), filePath);
            }
        }
        activeCells.forEach(c => c.classList.remove('tt-drag-active'));
        dragStart = null;
    });
}

export function getTimetableJson() {
    return JSON.stringify(_timetableData, null, 2);
}

// ---------- Datetable ----------

let _datetableData = null;
let _dtCurrentMonth = null;

export function renderDatetable(content, filePath, opts) {
    const initial = opts && opts.initial;
    try { _datetableData = JSON.parse(content); } catch { _datetableData = { people: [], events: {} }; }
    if (!_datetableData.people) _datetableData.people = [];
    if (!_datetableData.events) _datetableData.events = {};
    if (!initial) scheduleSave();

    const people = _datetableData.people;
    people.forEach((p, i) => { if (!p.color) p.color = TT_COLORS[i % TT_COLORS.length]; });

    const today = new Date();
    if (!_dtCurrentMonth) _dtCurrentMonth = { year: today.getFullYear(), month: today.getMonth() };
    const { year, month } = _dtCurrentMonth;

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const monthNames = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

    let html = '<div class="dt-container">';
    html += '<div class="dt-toolbar">';
    html += '<span class="tt-toolbar-label">인원:</span>';
    people.forEach((p, i) => {
        html += `<span class="tt-person-tag" style="background:${p.color}" data-idx="${i}">${escHtml(p.name)} <span class="dt-person-remove" data-idx="${i}">&times;</span></span>`;
    });
    html += `<button class="tt-add-person-btn" id="dtAddPerson">+ 추가</button>`;
    html += '</div>';

    html += '<div class="dt-input-form">';
    html += '<span class="tt-toolbar-label">일정 추가:</span>';
    html += `<input type="date" id="dtInputDate" class="dt-input" value="${year}-${String(month+1).padStart(2,'0')}-01">`;
    html += '<span class="dt-input-sep">~</span>';
    html += `<input type="date" id="dtInputDateEnd" class="dt-input">`;
    html += `<select id="dtInputPerson" class="dt-input"><option value="">인원 선택</option>`;
    people.forEach((p, i) => { html += `<option value="${i}">${escHtml(p.name)}</option>`; });
    html += '</select>';
    html += `<input type="text" id="dtInputReason" class="dt-input dt-input-reason" placeholder="사유 입력">`;
    html += `<button class="dt-input-btn" id="dtInputAdd">추가</button>`;
    html += '</div>';

    html += '<div class="dt-nav">';
    html += `<button class="dt-nav-btn" id="dtPrev">◀</button>`;
    html += `<span class="dt-nav-title">${year}년 ${monthNames[month]}</span>`;
    html += `<button class="dt-nav-btn" id="dtNext">▶</button>`;
    html += '</div>';

    html += '<div class="dt-drag-hint" id="dtDragHint" style="display:none;"></div>';

    html += '<div class="dt-grid">';
    const dowLabels = ['일','월','화','수','목','금','토'];
    dowLabels.forEach((d, i) => {
        const cls = i === 0 ? 'dt-dow dt-sun' : i === 6 ? 'dt-dow dt-sat' : 'dt-dow';
        html += `<div class="${cls}">${d}</div>`;
    });

    function dtMakeDateStr(d) {
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const dtRunMap = {};
    const seenPairs = new Set();
    for (let d = 1; d <= daysInMonth; d++) {
        const ds = dtMakeDateStr(d);
        (_datetableData.events[ds] || []).forEach(ev => seenPairs.add(ev.person + '|||' + ev.reason));
    }
    seenPairs.forEach(pairKey => {
        const [person, reason] = pairKey.split('|||');
        let runStartDay = null;
        for (let d = 1; d <= daysInMonth + 1; d++) {
            const ds = d <= daysInMonth ? dtMakeDateStr(d) : null;
            const hasEvent = ds && (_datetableData.events[ds] || []).some(ev => ev.person === person && ev.reason === reason);
            if (hasEvent) {
                if (runStartDay === null) runStartDay = d;
            } else {
                if (runStartDay !== null) {
                    const runEndDay = d - 1;
                    const runLen = runEndDay - runStartDay + 1;
                    for (let rd = runStartDay; rd <= runEndDay; rd++) {
                        const rds = dtMakeDateStr(rd);
                        if (!dtRunMap[rds]) dtRunMap[rds] = [];
                        let pos = 'single';
                        if (runLen > 1) {
                            if (rd === runStartDay) pos = 'start';
                            else if (rd === runEndDay) pos = 'end';
                            else pos = 'mid';
                        }
                        const dow = (startDow + rd - 1) % 7;
                        let visualPos = pos;
                        if (pos === 'mid' && dow === 0) visualPos = 'week-start';
                        else if (pos === 'mid' && dow === 6) visualPos = 'week-end';
                        else if (pos === 'start' && dow === 6) visualPos = 'start-end-row';
                        else if (pos === 'end' && dow === 0) visualPos = 'start-end-row';
                        dtRunMap[rds].push({ person, reason, pos, visualPos, runLen, runStart: runStartDay, runEnd: runEndDay });
                    }
                    runStartDay = null;
                }
            }
        }
    });

    for (let i = 0; i < startDow; i++) html += '<div class="dt-cell dt-empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = dtMakeDateStr(d);
        const dow = (startDow + d - 1) % 7;
        const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
        let cls = 'dt-cell';
        if (dow === 0) cls += ' dt-sun';
        if (dow === 6) cls += ' dt-sat';
        if (isToday) cls += ' dt-today';

        const events = _datetableData.events[dateStr] || [];
        html += `<div class="${cls}" data-date="${dateStr}" data-day="${d}">`;
        html += `<div class="dt-date-num">${d}</div>`;
        html += '<div class="dt-events">';

        const rendered = new Set();
        events.forEach((ev, ei) => {
            const pairKey = ev.person + '|||' + ev.reason;
            if (rendered.has(pairKey)) return;
            rendered.add(pairKey);
            const person = people.find(p => p.name === ev.person);
            const color = person ? person.color : '#999';
            const runInfo = (dtRunMap[dateStr] || []).find(r => r.person === ev.person && r.reason === ev.reason);
            let evCls = 'dt-event';
            let showLabel = true;
            if (runInfo && runInfo.runLen > 1) {
                const pos = runInfo.pos;
                if (pos === 'start') {
                    evCls += dow === 6 ? ' dt-ev-single' : ' dt-ev-start';
                } else if (pos === 'end') {
                    evCls += dow === 0 ? ' dt-ev-single' : ' dt-ev-end';
                    showLabel = dow === 0;
                } else if (pos === 'mid') {
                    if (dow === 0) { evCls += ' dt-ev-start'; showLabel = true; }
                    else if (dow === 6) { evCls += ' dt-ev-end'; showLabel = false; }
                    else { evCls += ' dt-ev-mid'; showLabel = false; }
                }
            }
            const label = showLabel ? `${escHtml(ev.person)}(${escHtml(ev.reason)})` : '';
            html += `<div class="${evCls}" style="background:${color}20;border-color:${color}" data-date="${dateStr}" data-eidx="${ei}">${label}</div>`;
        });
        html += '</div></div>';
    }

    const totalCells = startDow + daysInMonth;
    const remaining = (7 - totalCells % 7) % 7;
    for (let i = 0; i < remaining; i++) html += '<div class="dt-cell dt-empty"></div>';

    html += '</div>';

    if (people.length > 0) {
        html += '<div class="dt-summary">';
        html += '<div class="dt-summary-title">인원별 일정</div>';
        people.forEach(p => {
            const personEvents = [];
            for (let d = 1; d <= daysInMonth; d++) {
                const dateStr = dtMakeDateStr(d);
                const evts = (_datetableData.events[dateStr] || []).filter(ev => ev.person === p.name);
                evts.forEach(ev => personEvents.push({ day: d, reason: ev.reason }));
            }
            const runs = [];
            let curRun = null;
            personEvents.forEach(ev => {
                if (curRun && ev.reason === curRun.reason && ev.day === curRun.endDay + 1) {
                    curRun.endDay = ev.day;
                    curRun.count++;
                } else {
                    if (curRun) runs.push(curRun);
                    curRun = { startDay: ev.day, endDay: ev.day, reason: ev.reason, count: 1 };
                }
            });
            if (curRun) runs.push(curRun);
            const totalDays = personEvents.length;
            html += `<div class="dt-summary-person">`;
            html += `<div class="dt-summary-name" style="border-left:4px solid ${p.color};padding-left:8px;">${escHtml(p.name)} <span class="dt-summary-count">(${totalDays}일)</span></div>`;
            if (runs.length === 0) {
                html += `<div class="dt-summary-empty">이번 달 일정 없음</div>`;
            } else {
                html += '<div class="dt-summary-list">';
                runs.forEach(r => {
                    const dateLabel = r.startDay === r.endDay ? `${r.startDay}일` : `${r.startDay}~${r.endDay}일`;
                    html += `<div class="dt-summary-item"><span class="dt-summary-date">${dateLabel}</span> ${escHtml(r.reason || '-')}</div>`;
                });
                html += '</div>';
            }
            html += '</div>';
        });
        html += '</div>';
    }

    html += '</div>';
    previewBody.innerHTML = html;

    const addBtn = previewBody.querySelector('#dtAddPerson');
    if (addBtn) addBtn.addEventListener('click', () => {
        const name = prompt('인원 이름을 입력하세요:');
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        if (people.some(p => p.name === trimmed)) { alert('이미 존재하는 이름입니다.'); return; }
        people.push({ name: trimmed, color: TT_COLORS[people.length % TT_COLORS.length] });
        renderDatetable(JSON.stringify(_datetableData), filePath);
    });

    previewBody.querySelectorAll('.dt-person-remove').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.idx);
            const pName = people[idx].name;
            if (!confirm(`"${pName}"을(를) 삭제하시겠습니까?`)) return;
            for (const date in _datetableData.events) {
                _datetableData.events[date] = _datetableData.events[date].filter(ev => ev.person !== pName);
                if (_datetableData.events[date].length === 0) delete _datetableData.events[date];
            }
            people.splice(idx, 1);
            renderDatetable(JSON.stringify(_datetableData), filePath);
        });
    });

    previewBody.querySelector('#dtPrev')?.addEventListener('click', () => {
        _dtCurrentMonth.month--;
        if (_dtCurrentMonth.month < 0) { _dtCurrentMonth.month = 11; _dtCurrentMonth.year--; }
        renderDatetable(JSON.stringify(_datetableData), filePath);
    });
    previewBody.querySelector('#dtNext')?.addEventListener('click', () => {
        _dtCurrentMonth.month++;
        if (_dtCurrentMonth.month > 11) { _dtCurrentMonth.month = 0; _dtCurrentMonth.year++; }
        renderDatetable(JSON.stringify(_datetableData), filePath);
    });

    // Mobile swipe
    const dtContainerEl = previewBody.querySelector('.dt-container');
    if (dtContainerEl) {
        let dtTouchStartX = 0, dtTouchStartY = 0, dtTouchActive = false;
        dtContainerEl.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) { dtTouchActive = false; return; }
            dtTouchStartX = e.touches[0].clientX;
            dtTouchStartY = e.touches[0].clientY;
            dtTouchActive = true;
        }, { passive: true });
        dtContainerEl.addEventListener('touchmove', () => {}, { passive: true });
        dtContainerEl.addEventListener('touchend', (e) => {
            if (!dtTouchActive) return;
            dtTouchActive = false;
            const t = e.changedTouches[0];
            const dx = t.clientX - dtTouchStartX;
            const dy = t.clientY - dtTouchStartY;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (e.cancelable) e.preventDefault();
                if (dx < 0) {
                    _dtCurrentMonth.month++;
                    if (_dtCurrentMonth.month > 11) { _dtCurrentMonth.month = 0; _dtCurrentMonth.year++; }
                } else {
                    _dtCurrentMonth.month--;
                    if (_dtCurrentMonth.month < 0) { _dtCurrentMonth.month = 11; _dtCurrentMonth.year--; }
                }
                renderDatetable(JSON.stringify(_datetableData), filePath);
            }
        });
    }

    // Direct input form
    previewBody.querySelector('#dtInputAdd')?.addEventListener('click', () => {
        const dateStart = previewBody.querySelector('#dtInputDate').value;
        const dateEnd = previewBody.querySelector('#dtInputDateEnd').value;
        const personIdx = previewBody.querySelector('#dtInputPerson').value;
        const reason = previewBody.querySelector('#dtInputReason').value;
        if (!dateStart || personIdx === '') { alert('날짜와 인원을 선택하세요.'); return; }
        const idx = parseInt(personIdx);
        const pName = people[idx].name;
        const start = new Date(dateStart);
        const end = dateEnd ? new Date(dateEnd) : start;
        if (end < start) { alert('종료일이 시작일보다 빠릅니다.'); return; }
        for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
            const ds = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
            if (!_datetableData.events[ds]) _datetableData.events[ds] = [];
            _datetableData.events[ds].push({ person: pName, reason: reason.trim() || '' });
        }
        renderDatetable(JSON.stringify(_datetableData), filePath);
    });

    // Drag selection
    let dtDragStart = null;
    let dtDragCells = new Set();
    const dragHint = previewBody.querySelector('#dtDragHint');

    function dtClearDragHighlight() {
        previewBody.querySelectorAll('.dt-cell.dt-drag-selected').forEach(c => c.classList.remove('dt-drag-selected'));
        dtDragCells.clear();
    }

    function dtGetDateRange(startDate, endDate) {
        const s = Math.min(parseInt(startDate), parseInt(endDate));
        const e = Math.max(parseInt(startDate), parseInt(endDate));
        return { start: s, end: e };
    }

    previewBody.querySelectorAll('.dt-cell[data-date]').forEach(cell => {
        cell.addEventListener('mousedown', (e) => {
            if (e.target.closest('.dt-event')) return;
            e.preventDefault();
            dtDragStart = cell.dataset.day;
            dtClearDragHighlight();
            cell.classList.add('dt-drag-selected');
            dtDragCells.add(cell.dataset.day);
        });
        cell.addEventListener('mouseenter', () => {
            if (!dtDragStart) return;
            dtClearDragHighlight();
            const { start, end } = dtGetDateRange(dtDragStart, cell.dataset.day);
            previewBody.querySelectorAll('.dt-cell[data-day]').forEach(c => {
                const d = parseInt(c.dataset.day);
                if (d >= start && d <= end) {
                    c.classList.add('dt-drag-selected');
                    dtDragCells.add(c.dataset.day);
                }
            });
            if (dtDragCells.size > 1) {
                dragHint.style.display = '';
                dragHint.textContent = `${start}일 ~ ${end}일 (${dtDragCells.size}일간)`;
            } else {
                dragHint.style.display = 'none';
            }
        });
    });

    const dtMouseUp = () => {
        if (!dtDragStart) return;
        if (dtDragCells.size > 1) {
            if (people.length === 0) { alert('먼저 인원을 추가하세요.'); dtDragStart = null; dtClearDragHighlight(); dragHint.style.display = 'none'; return; }
            const personList = people.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
            const days = Array.from(dtDragCells).map(Number).sort((a, b) => a - b);
            const choice = prompt(`${days[0]}일 ~ ${days[days.length-1]}일\n인원 번호를 선택하세요:\n${personList}`);
            if (choice) {
                const idx = parseInt(choice) - 1;
                if (idx >= 0 && idx < people.length) {
                    const reason = prompt(`${people[idx].name}의 사유를 입력하세요:`);
                    if (reason !== null) {
                        days.forEach(d => {
                            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                            if (!_datetableData.events[dateStr]) _datetableData.events[dateStr] = [];
                            _datetableData.events[dateStr].push({ person: people[idx].name, reason: reason.trim() || '' });
                        });
                        renderDatetable(JSON.stringify(_datetableData), filePath);
                    }
                }
            }
        } else if (dtDragCells.size === 1) {
            const day = Array.from(dtDragCells)[0];
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(parseInt(day)).padStart(2, '0')}`;
            if (people.length === 0) { alert('먼저 인원을 추가하세요.'); } else {
                const personList = people.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
                const choice = prompt(`${dateStr}\n인원 번호를 선택하세요:\n${personList}`);
                if (choice) {
                    const idx = parseInt(choice) - 1;
                    if (idx >= 0 && idx < people.length) {
                        const reason = prompt(`${people[idx].name}의 사유를 입력하세요:`);
                        if (reason !== null) {
                            if (!_datetableData.events[dateStr]) _datetableData.events[dateStr] = [];
                            _datetableData.events[dateStr].push({ person: people[idx].name, reason: reason.trim() || '' });
                            renderDatetable(JSON.stringify(_datetableData), filePath);
                        }
                    }
                }
            }
        }
        dtDragStart = null;
        dtClearDragHighlight();
        dragHint.style.display = 'none';
    };
    document.addEventListener('mouseup', dtMouseUp);

    previewBody.querySelectorAll('.dt-event').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const dateStr = el.dataset.date;
            const eidx = parseInt(el.dataset.eidx);
            const ev = _datetableData.events[dateStr]?.[eidx];
            if (!ev) return;
            const action = prompt(`${ev.person}(${ev.reason})\n수정: 새 사유 입력\n삭제: "delete" 입력`, ev.reason);
            if (action === null) return;
            if (action.toLowerCase() === 'delete') {
                _datetableData.events[dateStr].splice(eidx, 1);
                if (_datetableData.events[dateStr].length === 0) delete _datetableData.events[dateStr];
            } else {
                ev.reason = action.trim();
            }
            renderDatetable(JSON.stringify(_datetableData), filePath);
        });
    });
}

export function getDatetableJson() {
    return JSON.stringify(_datetableData, null, 2);
}
