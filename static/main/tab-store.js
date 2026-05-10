let nextTabId = 1;
const tabs = new Map();
const subs = [];

// Spec 3: host 별 별도 localStorage 키 — 각 chrome 탭이 다른 host 를
// 가리킬 때 탭 list 가 섞이지 않도록.
const _h = (typeof window !== 'undefined' && window.__INITIAL_HOST) || '';
const STORAGE_KEY = _h ? `cn-v2-tabs-${_h}` : 'cn-v2-tabs';
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
export function updateTab(id, patch) {
  const t = tabs.get(id); if (!t) return;
  Object.assign(t, patch);
  // persist 만 — fire() 호출하면 layout.render 가 mountEl.innerHTML='' 으로
  // iframe 을 잠시 detach 하면서 in-flight fetch 가 ERR_ABORTED 됨 (회귀
  // 발견). currentFile 같은 메타데이터 변경은 시각적 재렌더 불필요.
  persist();
}
export function moveTab(id, targetLeafId, targetIndex) {
  const t = tabs.get(id);
  if (!t) return;
  // Map 은 insertion order — 새 위치로 옮기려면 entries reordering
  const arr = [...tabs.values()];
  const movedIdx = arr.findIndex(x => x.id === id);
  if (movedIdx < 0) return;
  arr.splice(movedIdx, 1);
  t.leafId = targetLeafId;
  // targetIndex 는 같은 leaf 안의 위치 (다른 leaf 의 탭들은 카운트 안 함)
  if (typeof targetIndex !== 'number' || targetIndex < 0) {
    arr.push(t);  // 끝에
  } else {
    // 같은 leaf 의 N 번째 위치 = arr 에서 leaf 의 N 번째 entry 위치
    let inserted = false;
    let count = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].leafId === targetLeafId) {
        if (count === targetIndex) {
          arr.splice(i, 0, t);
          inserted = true;
          break;
        }
        count++;
      }
    }
    if (!inserted) arr.push(t);
  }
  tabs.clear();
  for (const x of arr) tabs.set(x.id, x);
  fire();
}
export function tabsForLeaf(leafId) {
  return [...tabs.values()].filter(t => t.leafId === leafId);
}
export function getAllTabs() { return [...tabs.values()]; }
