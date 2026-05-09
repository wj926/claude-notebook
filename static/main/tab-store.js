let nextTabId = 1;
const tabs = new Map();
const subs = [];

const STORAGE_KEY = 'cn-v2-tabs';
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tabs: [...tabs.values()],
      nextTabId,
    }));
  } catch (_) {}
}
export function restoreFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.tabs)) return 0;
    tabs.clear();
    for (const t of o.tabs) tabs.set(t.id, t);
    if (o.nextTabId) nextTabId = o.nextTabId;
    return tabs.size;
  } catch (_) { return 0; }
}

export function onChange(fn) { subs.push(fn); }
function fire() { persist(); for (const fn of subs) fn(); }

export function openTab({ kind, contentRef, leafId }) {
  // 같은 kind+contentRef 가 이미 어느 leaf 에든 열려있으면 거기서 활성화 (이동 X)
  // — 사용자가 사이드바 터미널 클릭 시 split 구조가 망가지지 않게.
  for (const t of tabs.values()) {
    if (t.kind === kind && t.contentRef === contentRef) {
      fire();
      return t.id;
    }
  }
  const id = `tab-${nextTabId++}`;
  tabs.set(id, { id, kind, contentRef, leafId });
  fire();
  return id;
}

export function closeTab(id) { tabs.delete(id); fire(); }
export function getTab(id) { return tabs.get(id); }
export function moveTab(id, targetLeafId, _index) {
  // Spec 2 (DnD) 가 호출. Spec 1 미사용.
  const t = tabs.get(id); if (!t) return;
  t.leafId = targetLeafId;
  fire();
}
export function tabsForLeaf(leafId) {
  return [...tabs.values()].filter(t => t.leafId === leafId);
}
export function getAllTabs() { return [...tabs.values()]; }
