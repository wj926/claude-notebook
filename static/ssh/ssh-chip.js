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
    // Spec 3: URL ?host=<id> 로 진입한 경우 (또는 백엔드 inject __INITIAL_HOST)
    // 그 host 를 우선 사용. 그 외엔 서버 저장 current_id.
    const initial = window.__INITIAL_HOST;
    currentId = (initial && initial.length) ? initial : (data.current_id || 'local');
    window.__currentHostId = currentId;
    // 서버 current_id 와 다르면 PUT 으로 sync (다음 refresh 에서 같은 값)
    if (initial && initial !== data.current_id) {
      try {
        await fetch(`${BASE}/api/current_host`, mutFetchOpts({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: initial }),
        }));
      } catch (_) {}
    }
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
    const targetId = b.dataset.id;
    // 사용자 선택 (A): 다른 host 클릭 시 새 chrome 탭 으로 열기.
    // 현 탭 = 한 host (이미 그 host 인 거 클릭은 noop).
    if (targetId !== currentId) {
      const url = (targetId === 'local')
        ? (BASE || '/claude-notebook')
        : `${BASE || '/claude-notebook'}?host=${encodeURIComponent(targetId)}`;
      window.open(url, '_blank', 'noopener');
      return;
    }
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
    // Spec 3: host 변경 시 OUTER 트리 그 호스트 기준으로 reload
    try {
      const treeEl = document.getElementById('tree');
      if (treeEl) treeEl.innerHTML = '';
      // dynamic import — circular dep 회피
      import('../ui/tree.js').then(m => m.loadTree?.());
    } catch (_) {}
  }, 700);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
