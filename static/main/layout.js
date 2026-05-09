import * as tabStore from './tab-store.js';

let nextLeafId = 1;
const state = {
  leaves: [{ id: `leaf-${nextLeafId++}`, size: 1, activeTabId: null }],
  activeLeafId: null,
};
state.activeLeafId = state.leaves[0].id;

let mountEl;
const subs = [];
export function onChange(fn) { subs.push(fn); }
function fire() { for (const fn of subs) fn(); render(); }

export function init(mainEl) {
  mountEl = mainEl;
  tabStore.onChange(render);
  render();
}

export function getLeavesInVisualOrder() { return [...state.leaves]; }
export function getActiveLeafId() { return state.activeLeafId; }
export function activateLeaf(id) { state.activeLeafId = id; fire(); }

export function activateTab(tabId) {
  const t = tabStore.getTab(tabId);
  if (!t) return;
  const leaf = state.leaves.find(l => l.id === t.leafId);
  if (leaf) { leaf.activeTabId = tabId; state.activeLeafId = leaf.id; }
  fire();
}

export function addLeafAfter(id, opts = {}) {
  if (window.matchMedia('(max-width: 720px)').matches) return null;
  if (state.leaves.length >= 4) return null;
  const i = state.leaves.findIndex(l => l.id === id);
  if (i < 0) return null;
  const leaf = { id: `leaf-${nextLeafId++}`, size: 1, activeTabId: null };
  state.leaves.splice(i + 1, 0, leaf);
  state.activeLeafId = leaf.id;
  if (opts.kind && opts.contentRef) {
    const tabId = tabStore.openTab({ kind: opts.kind, contentRef: opts.contentRef, leafId: leaf.id });
    leaf.activeTabId = tabId;
  }
  fire();
  return leaf;
}

export function removeLeaf(id) {
  if (state.leaves.length <= 1) return;
  const i = state.leaves.findIndex(l => l.id === id);
  if (i < 0) return;
  for (const t of tabStore.tabsForLeaf(id)) tabStore.closeTab(t.id);
  state.leaves.splice(i, 1);
  if (state.activeLeafId === id) state.activeLeafId = state.leaves[Math.max(0, i - 1)].id;
  fire();
}

export function setLeafSize(idOrEdge, size) {
  if (typeof idOrEdge === 'string') {
    const l = state.leaves.find(x => x.id === idOrEdge);
    if (l) l.size = size;
  } else {
    const { leftId, rightId } = idOrEdge;
    const L = state.leaves.find(x => x.id === leftId);
    const R = state.leaves.find(x => x.id === rightId);
    if (L && R) {
      const total = L.size + R.size;
      L.size = total * size;
      R.size = total - L.size;
    }
  }
  fire();
}

export function serializeLayout() {
  return JSON.stringify({ leaves: state.leaves, activeLeafId: state.activeLeafId });
}
export function restoreLayout(json) {
  try {
    const o = JSON.parse(json);
    state.leaves = o.leaves;
    state.activeLeafId = o.activeLeafId;
    nextLeafId = Math.max(...state.leaves.map(l => parseInt(l.id.split('-')[1]))) + 1;
    fire();
  } catch (_) {}
}

function render() {
  if (!mountEl) return;
  // Reuse existing leaf DOM where possible (avoid re-render churn)
  const existing = new Map();
  mountEl.querySelectorAll('.leaf').forEach(el => existing.set(el.dataset.leafId, el));
  mountEl.innerHTML = '';
  for (const leaf of state.leaves) {
    let sec = existing.get(leaf.id);
    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'leaf';
      sec.dataset.leafId = leaf.id;
      sec.innerHTML = '<div class="tabbar"></div><div class="leaf-body"></div>';
      sec.addEventListener('mousedown', () => activateLeaf(leaf.id));
    }
    sec.classList.toggle('active', leaf.id === state.activeLeafId);
    sec.style.flex = `${leaf.size} 1 0`;

    const bar = sec.querySelector('.tabbar');
    bar.innerHTML = '';
    for (const t of tabStore.tabsForLeaf(leaf.id)) {
      const tEl = document.createElement('button');
      tEl.type = 'button';
      tEl.className = 'tab' + (t.id === leaf.activeTabId ? ' active' : '');
      tEl.innerHTML = '<span class="tab-name"></span><span class="tab-close" title="닫기">×</span>';
      tEl.querySelector('.tab-name').textContent = t.contentRef;
      tEl.addEventListener('click', e => {
        if (e.target.classList.contains('tab-close')) {
          tabStore.closeTab(t.id);
        } else {
          leaf.activeTabId = t.id;
          activateLeaf(leaf.id);
        }
      });
      bar.appendChild(tEl);
    }
    if (state.leaves.length > 1) {
      const closeLeaf = document.createElement('button');
      closeLeaf.type = 'button';
      closeLeaf.className = 'leaf-close';
      closeLeaf.textContent = '✕';
      closeLeaf.title = '이 패널 닫기';
      closeLeaf.addEventListener('click', e => { e.stopPropagation(); removeLeaf(leaf.id); });
      bar.appendChild(closeLeaf);
    }

    const body = sec.querySelector('.leaf-body');
    const activeTab = tabStore.tabsForLeaf(leaf.id).find(t => t.id === leaf.activeTabId);
    if (activeTab) {
      sec.dispatchEvent(new CustomEvent('mount-tab', {
        detail: { tab: activeTab, hostEl: body },
        bubbles: true,
      }));
    } else {
      body.innerHTML = '<div class="leaf-empty" style="padding:40px;text-align:center;color:var(--text-secondary,#888);font-style:italic">사이드바에서 터미널이나 파일을 선택하세요</div>';
    }
    mountEl.appendChild(sec);
  }
}
