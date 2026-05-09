import { BASE, mutFetchOpts, fetchOpts } from '../core/api.js';
import { openAddModal } from './add-host-modal.js';

const subs = [];
export function onChange(fn) { subs.push(fn); }

let slotEl;
let hosts = [];
let currentId = 'local';
let conn = 'connected';
let outsideListenerInstalled = false;

export async function init(slot) {
  slotEl = slot;
  await refresh();
  render();
  if (!outsideListenerInstalled) {
    document.addEventListener('click', (e) => {
      if (!slotEl.contains(e.target)) {
        const dd = slotEl.querySelector('.ssh-dropdown');
        if (dd) dd.hidden = true;
      }
    });
    outsideListenerInstalled = true;
  }
}

async function refresh() {
  try {
    const r = await fetch(`${BASE}/api/hosts`, fetchOpts);
    if (!r.ok) return;
    const data = await r.json();
    hosts = data.hosts || [];
    currentId = data.current_id || 'local';
    window.__currentHostId = currentId;
  } catch (_) {}
}

function render() {
  const cur = hosts.find(h => h.id === currentId) || hosts[0] || { label: '?' };
  slotEl.innerHTML = `
    <span style="position:relative">
      <button class="ssh-chip" data-state="${conn}" type="button">
        <span class="ssh-dot"></span>
        <span>SSH: ${esc(cur.label)}</span>
        <span class="ssh-arrow">&#9660;</span>
      </button>
      <div class="ssh-dropdown" hidden></div>
    </span>
  `;
  const chip = slotEl.querySelector('.ssh-chip');
  const dd = slotEl.querySelector('.ssh-dropdown');
  chip.addEventListener('click', e => {
    e.stopPropagation();
    if (dd.hidden) openDD(dd);
    else dd.hidden = true;
  });
}

function openDD(dd) {
  dd.innerHTML = `
    <div class="dd-head">Connect to host</div>
    ${hosts.map(h => `
      <button class="dd-row ${h.id === currentId ? 'current' : ''}" data-id="${esc(h.id)}" type="button">
        <span class="dd-icon">${h.id === currentId ? '&#10003;' : '&#128187;'}</span>
        <span>${esc(h.label)}</span>
      </button>
    `).join('')}
    <div class="dd-divider"></div>
    <button class="dd-row" data-act="add" type="button"><span class="dd-icon">+</span><span>Add new SSH host&#x2026;</span></button>
  `;
  dd.hidden = false;
  dd.querySelectorAll('.dd-row').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.act === 'add') {
      dd.hidden = true;
      openAddModal({ onAdded: async () => { await refresh(); render(); } });
      return;
    }
    dd.hidden = true;
    await switchTo(b.dataset.id);
  }));
}

async function switchTo(id) {
  currentId = id;
  conn = 'connecting';
  render();
  try {
    await fetch(`${BASE}/api/current_host`, mutFetchOpts({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }));
  } catch (_) {}
  setTimeout(() => {
    conn = 'connected';
    render();
    window.__currentHostId = id;
    for (const fn of subs) fn(id);
    showFilesLocalNotice();
  }, 700);
}

function showFilesLocalNotice() {
  if (sessionStorage.getItem('files-local-notice-shown')) return;
  sessionStorage.setItem('files-local-notice-shown', '1');
  const sec = document.getElementById('files-section');
  if (!sec) return;
  const note = document.createElement('div');
  note.className = 'files-local-notice';
  note.innerHTML = `Files 트리는 local 그대로 유지됩니다. <button class="close" type="button">&times;</button>`;
  note.querySelector('.close').addEventListener('click', () => note.remove());
  sec.prepend(note);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
