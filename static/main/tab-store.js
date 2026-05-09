let nextTabId = 1;
const tabs = new Map();
const subs = [];

export function onChange(fn) { subs.push(fn); }
function fire() { for (const fn of subs) fn(); }

export function openTab({ kind, contentRef, leafId }) {
  // 같은 contentRef + 같은 leaf 면 기존 탭 활성화
  for (const t of tabs.values()) {
    if (t.kind === kind && t.contentRef === contentRef) {
      t.leafId = leafId;
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
