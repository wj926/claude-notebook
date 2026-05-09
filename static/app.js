// 통합 페이지 부트.
import { BASE, mutFetchOpts } from './core/api.js';
import * as layout from './main/layout.js';
import * as tabStore from './main/tab-store.js';
import { TerminalInstance } from './terminals/term-instance.js';
import { FileViewerInstance } from './viewers/file-instance.js';
import { initTree, loadTree } from './ui/tree.js';
import { initSidebar } from './ui/sidebar.js';
import { init as initTermList } from './terminals/term-list.js';
import { init as initSshChip } from './ssh/ssh-chip.js';
// §5.7 보존: finder / history / file-ops / keyboard-help
import { initFinder, loadFinderGrid, getCurrentDir } from './ui/finder.js';
import { initFileOpsButtons } from './ui/file-ops.js';
import { initKeyboardHelp } from './editor/keyboard-help.js';
import { initHistoryModal } from './ui/history-modal.js';

const JUPYTER_BASE = window.__JUPYTER_BASE !== undefined ? window.__JUPYTER_BASE : BASE;

// instances: tabId → instance (lifecycle bound to tab)
const instances = new Map();

// 한 init 이 실패해도 다른 거 살아남게 — runtime error 격리
function safe(name, fn) {
  try { fn(); } catch (e) { console.error(`[init] ${name} failed:`, e); }
}

// localStorage 에서 탭/leaf 상태 먼저 복원 — layout.init() 의 initial render
// 가 복원된 상태로 그려져야 F5 후에 탭 그대로 보임. 복원 결과는 아래 boot
// 시점에서 "Files 자동 오픈" 가드에 사용됨.
const layoutRestored = layout.restoreFromStorage();
const tabsRestored = tabStore.restoreFromStorage();

safe('layout', () => layout.init(document.getElementById('main')));
safe('initSidebar', initSidebar);

// §5.7 보존 모듈 초기화 ─────────────────────────────────────────────────────

// openFileTab: finder / outer tree / 기타 모듈에서 파일 여는 공통 핸들러.
// FileViewerInstance 가 아직 PDF/text/풀 인터랙션 미구현이므로 (spec 1
// §5.4.2 미완), spec §5.7 "legacy 풀세트 보존" 정신에 따라 활성 'files' 탭의
// legacy iframe 에 hash deep-link 로 위임. iframe 이 마운트 안 됐으면 새로
// 만들고 load 직후 hash 설정.
const openFileTab = (path) => {
  // 1) 활성 leaf 의 'files' 탭 우선, 없으면 아무 'files' 탭, 그것도 없으면 새로 만듦
  const activeLeafId = layout.getActiveLeafId();
  let filesTab = tabStore.tabsForLeaf(activeLeafId).find(t => t.kind === 'files');
  if (!filesTab) filesTab = tabStore.getAllTabs().find(t => t.kind === 'files');
  if (!filesTab) {
    filesCount = Math.max(1, filesCount + 1);
    const id = tabStore.openTab({ kind: 'files', contentRef: `Files ${filesCount}`, leafId: activeLeafId });
    filesTab = tabStore.getTab(id);
  }
  layout.activateTab(filesTab.id);

  // 2) iframe 의 legacy app 이 노출한 __cnOpenFile 직접 호출. hash 기반은
  // legacy 의 onNavigate→updateHash('') 와 충돌해서 hash 가 즉시 비워지는
  // 회귀가 있었음.
  const tryInvoke = () => {
    const ifr = document.querySelector(
      `[data-tab-content-id="${filesTab.id}"] iframe[data-files-frame]`
    );
    if (!ifr || !ifr.contentWindow || typeof ifr.contentWindow.__cnOpenFile !== 'function') {
      return false;
    }
    try { ifr.contentWindow.__cnOpenFile(path); return true; } catch (_) { return false; }
  };
  if (tryInvoke()) return;
  // iframe 아직 mount/load 전 — load 후 다시 시도. 최대 ~3초 폴링 후 실패하면
  // 콘솔 + alert 로 가시화 (silent failure 방지 — codex round 4 권장).
  requestAnimationFrame(() => {
    if (tryInvoke()) return;
    const ifr = document.querySelector(
      `[data-tab-content-id="${filesTab.id}"] iframe[data-files-frame]`
    );
    if (!ifr) {
      console.error('[openFileTab] iframe element not found for tab', filesTab.id);
      return;
    }
    const onReady = () => {
      let tries = 0;
      const tick = () => {
        if (tryInvoke()) return;
        if (++tries > 30) {
          // 3초 폴링 실패 — legacy app __cnOpenFile 노출 안 됨
          console.error('[openFileTab] __cnOpenFile not exposed after iframe load — path:', path);
          alert(`파일 열기 실패: legacy 페이지 초기화 미완. 새로고침 후 다시 시도해주세요. (${path})`);
          return;
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    };
    ifr.addEventListener('load', onReady, { once: true });
  });
};

safe('initFinder', () => initFinder({ openFile: openFileTab, onNavigate: () => {} }));
safe('initFileOpsButtons', () => initFileOpsButtons({
  getCurrentDir,
  onChanged: () => loadFinderGrid(getCurrentDir()),
}));
safe('initKeyboardHelp', initKeyboardHelp);

// Snapshot history modal (#historyOverlay / #previewHistory 버튼)
// getFile: 현재 활성 파일 탭의 { path, content, extension } 반환
safe('initHistoryModal', () => initHistoryModal({
  getFile: () => {
    const activeLeafId = layout.getActiveLeafId();
    const leaf = layout.getLeavesInVisualOrder().find(l => l.id === activeLeafId);
    if (!leaf || !leaf.activeTabId) return null;
    const tab = tabStore.getTab(leaf.activeTabId);
    if (!tab || tab.kind !== 'file') return null;
    // instances Map 에서 FileViewerInstance 를 통해 현재 파일 정보 가져오기
    const inst = instances.get(tab.id);
    if (!inst || !inst._currentFile) return null;
    return inst._currentFile; // { path, content, extension }
  },
  onRestored: (content) => {
    // 복원 후 활성 파일 탭 리로드
    const activeLeafId = layout.getActiveLeafId();
    const leaf = layout.getLeavesInVisualOrder().find(l => l.id === activeLeafId);
    if (!leaf || !leaf.activeTabId) return;
    const inst = instances.get(leaf.activeTabId);
    if (inst && typeof inst.mount === 'function' && inst.path) {
      inst.mount(inst.dom, inst.path);
    }
    console.log('[history] restored, content length:', content?.length);
  },
}));

// 파일 탭 활성화 시 previewHistory / previewHelp 버튼 표시
const previewHistory = document.getElementById('previewHistory');
const previewHelp    = document.getElementById('previewHelp');
function syncPreviewBtns() {
  const activeLeafId = layout.getActiveLeafId();
  const leaf = layout.getLeavesInVisualOrder().find(l => l.id === activeLeafId);
  const isFiletab = leaf && leaf.activeTabId && (() => {
    const t = tabStore.getTab(leaf.activeTabId);
    return t && t.kind === 'file';
  })();
  if (previewHistory) previewHistory.style.display = isFiletab ? '' : 'none';
  if (previewHelp)    previewHelp.style.display    = isFiletab ? '' : 'none';
}
layout.onChange(syncPreviewBtns);
tabStore.onChange(syncPreviewBtns);

// ─────────────────────────────────────────────────────────────────────────────

safe('initTree', () => {
  initTree({
    openFile: openFileTab,  // legacy iframe 에 위임 (PDF/text/finder/history 풀세트)
    openDir: () => {},
  });
  loadTree();
});

// Mount tab → create instance, mount on host element ONCE.
document.addEventListener('mount-tab', e => {
  const { tab, hostEl } = e.detail;

  // 'files' kind: legacy file 브라우저 (Notion 식 + 폴더 그리드 + 토글 등 기존 기능 풀세트) 를 iframe 으로
  if (tab.kind === 'files') {
    if (hostEl.querySelector('iframe[data-files-frame]')) return;  // 이미 마운트됨
    const ifr = document.createElement('iframe');
    ifr.dataset.filesFrame = '1';
    ifr.src = `${BASE}/legacy-files`;
    ifr.style.cssText = 'width:100%;height:100%;border:0;display:block;background:var(--bg)';
    hostEl.appendChild(ifr);
    return;
  }

  let inst = instances.get(tab.id);
  if (inst && inst._mountedHost === hostEl) {
    inst.fit?.();
    return;
  }
  if (!inst) {
    if (tab.kind === 'term') {
      inst = new TerminalInstance({ name: tab.contentRef });
    } else {
      inst = new FileViewerInstance();
    }
    instances.set(tab.id, inst);
  }
  if (tab.kind === 'term') {
    inst.mount(hostEl);
  } else {
    inst.mount(hostEl, tab.contentRef);
  }
  inst._mountedHost = hostEl;
});

// Tab close → dispose instance
tabStore.onChange(() => {
  for (const [id, inst] of instances) {
    if (!tabStore.getTab(id)) {
      inst.flushUnsaved?.();
      inst.dispose();
      instances.delete(id);
    }
  }
});

// hash deep link `#<term-name>`
const hash = location.hash.replace('#', '');
if (hash) {
  const leafId = layout.getActiveLeafId();
  const tabId = tabStore.openTab({ kind: 'term', contentRef: hash, leafId });
  layout.activateTab(tabId);
}

// Files 탭 카운터 — 복원된 'Files N' 탭의 max N 부터 이어 매김
let filesCount = 0;
for (const t of tabStore.getAllTabs()) {
  const m = String(t.contentRef || '').match(/^Files (\d+)$/);
  if (m) filesCount = Math.max(filesCount, parseInt(m[1]));
}

// 기본 — 첫 진입 + 복원할 탭이 없을 때만 Files 탭 자동 오픈
if (!hash && tabsRestored === 0) {
  filesCount = 1;
  const leafId = layout.getActiveLeafId();
  const tabId = tabStore.openTab({ kind: 'files', contentRef: 'Files 1', leafId });
  layout.activateTab(tabId);
}

// focus query (옛 URL redirect 결과) — 한 번만 처리 후 URL 정리, 안 그러면
// 매 F5 마다 새 터미널이 무한 누적됨 (P0 버그). URL path 자체에 /terminal
// 이 있으면 서버가 focus=terminal 주입하므로, 처리 직후 history.replaceState
// 로 root path 로 바꿔야 다음 F5 에서 안 들어감.
const focus = window.__FOCUS;
if (focus === 'terminal' && !hash) {
  // URL 먼저 정리 (실패하든 성공하든 다음 F5 에 영향 안 주게)
  try { history.replaceState({}, '', BASE || '/claude-notebook'); } catch (_) {}
  // 현재 host_id 로 새 터미널 자동 생성
  fetch(`${JUPYTER_BASE}/api/terminals`, mutFetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })).then(r => r.json()).then(data => {
    const name = data.name || data.id;
    if (!name) throw new Error('no name in response');
    const leafId = layout.getActiveLeafId();
    const tabId = tabStore.openTab({ kind: 'term', contentRef: name, leafId });
    layout.activateTab(tabId);
  }).catch(err => console.error('auto-create terminal failed', err));
}

// Split button
const splitBtn = document.getElementById('split-btn');
if (splitBtn) {
  splitBtn.addEventListener('click', () => {
    const activeId = layout.getActiveLeafId();
    layout.addLeafAfter(activeId);
  });
}

// Files button — 활성 leaf 에 새 Files 탭 (매 클릭마다 새 탭)
const filesBtn = document.getElementById('files-btn');
if (filesBtn) {
  filesBtn.addEventListener('click', () => {
    filesCount++;
    const leafId = layout.getActiveLeafId();
    const tabId = tabStore.openTab({ kind: 'files', contentRef: `Files ${filesCount}`, leafId });
    layout.activateTab(tabId);
  });
}

// SSH 칩 (topbar ssh-slot)
safe('initSshChip', () => initSshChip(document.getElementById('ssh-slot')));

// Terminals sidebar section — 5s polling + pending command UI
safe('initTermList', () => initTermList({
  listEl: document.getElementById('term-list'),
  addBtn: document.getElementById('new-term-btn'),
}));

// Spec §5.7.4 S7 — 모든 'files' iframe 의 unsaved 검사 후 confirm prompt.
// legacy 자체 beforeunload 는 keepalive flush 만 하고 confirm 안 띄우므로
// outer 에서 추가 가드. 사용자가 OK 하면 그대로 unload (legacy 가 flush).
window.addEventListener('beforeunload', (e) => {
  let anyDirty = false;
  for (const ifr of document.querySelectorAll('iframe[data-files-frame]')) {
    try {
      if (ifr.contentWindow?.__cnIsDirty?.()) { anyDirty = true; break; }
    } catch (_) {}
  }
  if (anyDirty) {
    e.preventDefault();
    e.returnValue = '저장되지 않은 변경 사항이 있습니다. 정말 떠나시겠습니까?';
    return e.returnValue;
  }
});

// resize → fit terminals
window.addEventListener('resize', () => {
  for (const inst of instances.values()) inst.fit?.();
});
layout.onChange(() => {
  for (const inst of instances.values()) inst.fit?.();
});
