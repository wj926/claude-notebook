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

layout.init(document.getElementById('main'));

// Sidebar (existing module — needs the IDs we put in index.html)
initSidebar();

// §5.7 보존 모듈 초기화 ─────────────────────────────────────────────────────

// openFileTab: finder / 여러 모듈에서 파일 여는 공통 핸들러
const openFileTab = (path) => {
  const leafId = layout.getActiveLeafId();
  const tabId = tabStore.openTab({ kind: 'file', contentRef: path, leafId });
  layout.activateTab(tabId);
};

// Finder — #finder DOM 은 index.html에 hidden 으로 존재 (tree.js 가 탐색 역할)
// openFile: 파일 클릭 시 탭으로 열기, onNavigate: 디렉토리 탐색 유지
initFinder({ openFile: openFileTab, onNavigate: loadFinderGrid });

// File ops 버튼 (#newFileBtn / #newFolderBtn) — finder toolbar 에 있음
initFileOpsButtons({
  getCurrentDir,
  onChanged: () => loadFinderGrid(getCurrentDir()),
});

// 키보드 단축키 help modal (#helpOverlay / #previewHelp 버튼)
initKeyboardHelp();

// Snapshot history modal (#historyOverlay / #previewHistory 버튼)
// getFile: 현재 활성 파일 탭의 { path, content, extension } 반환
initHistoryModal({
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
});

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

// Tree — uses #tree
initTree({
  openFile: (path) => {
    const leafId = layout.getActiveLeafId();
    const tabId = tabStore.openTab({ kind: 'file', contentRef: path, leafId });
    layout.activateTab(tabId);
  },
  openDir: () => {},
});
loadTree();

// Mount tab → create instance, mount on host element
document.addEventListener('mount-tab', e => {
  const { tab, hostEl } = e.detail;
  let inst = instances.get(tab.id);
  if (!inst) {
    if (tab.kind === 'term') {
      inst = new TerminalInstance({ name: tab.contentRef });
    } else {
      inst = new FileViewerInstance();
    }
    instances.set(tab.id, inst);
  }
  hostEl.innerHTML = '';
  if (tab.kind === 'term') {
    inst.mount(hostEl);
  } else {
    inst.mount(hostEl, tab.contentRef);
  }
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

// focus query (옛 URL redirect 결과)
const focus = window.__FOCUS;
if (focus === 'terminal' && !hash) {
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

// Split button (Task 10 fully wires; here just placeholder)
const splitBtn = document.getElementById('split-btn');
if (splitBtn) {
  splitBtn.addEventListener('click', () => {
    const activeId = layout.getActiveLeafId();
    layout.addLeafAfter(activeId);
  });
}

// SSH 칩 (topbar ssh-slot)
initSshChip(document.getElementById('ssh-slot'));

// Terminals sidebar section — 5s polling + pending command UI
initTermList({
  listEl: document.getElementById('term-list'),
  addBtn: document.getElementById('new-term-btn'),
});

// resize → fit terminals
window.addEventListener('resize', () => {
  for (const inst of instances.values()) inst.fit?.();
});
layout.onChange(() => {
  for (const inst of instances.values()) inst.fit?.();
});
