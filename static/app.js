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
// 가 복원된 상태로 그려져야 F5 후에 탭 그대로 보임.
const layoutRestored = layout.restoreFromStorage();
const tabsRestored = tabStore.restoreFromStorage();

// IMPORTANT: mount-tab 리스너는 layout.init() 보다 먼저 등록해야 함. init 의
// initial render 가 복원된 탭에 대해 mount-tab 을 dispatch 하므로, 늦게 등록
// 하면 F5 후 iframe/터미널이 안 만들어짐 (회귀 발견).
document.addEventListener('mount-tab', onMountTab);

safe('layout', () => layout.init(document.getElementById('main')));
safe('initSidebar', initSidebar);

// §5.7 보존 모듈 초기화 ─────────────────────────────────────────────────────

// openFileTab: finder / outer tree / 기타 모듈에서 파일 여는 공통 핸들러.
// FileViewerInstance 가 아직 PDF/text/풀 인터랙션 미구현이므로 (spec 1
// §5.4.2 미완), spec §5.7 "legacy 풀세트 보존" 정신에 따라 활성 'files' 탭의
// legacy iframe 에 hash deep-link 로 위임. iframe 이 마운트 안 됐으면 새로
// 만들고 load 직후 hash 설정.
const openFileTab = (path) => {
  // 1) 우선 순위:
  //    a) 현재 활성 leaf 의 활성 탭이 'files' 면 그거 (사용자가 그 탭에서 작업 중)
  //    b) 없으면 활성 leaf 의 첫 'files' 탭
  //    c) 없으면 아무 leaf 의 첫 'files' 탭
  //    d) 없으면 새로 만듦
  const activeLeafId = layout.getActiveLeafId();
  const activeLeaf = layout.getLeavesInVisualOrder().find(l => l.id === activeLeafId);
  const activeTab = activeLeaf?.activeTabId ? tabStore.getTab(activeLeaf.activeTabId) : null;
  let filesTab = (activeTab?.kind === 'files') ? activeTab : null;
  if (!filesTab) filesTab = tabStore.tabsForLeaf(activeLeafId).find(t => t.kind === 'files');
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
    if (!ifr || !ifr.contentWindow ||
        !ifr.contentWindow.__cnReady ||
        typeof ifr.contentWindow.__cnOpenFile !== 'function') {
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

// outer previewHistory/previewHelp 버튼은 legacy iframe 안에 동일한 게
// 이미 있어서 중복. 항상 hide (codex P2 — getFile dead path).
const previewHistory = document.getElementById('previewHistory');
const previewHelp    = document.getElementById('previewHelp');
function syncPreviewBtns() {
  const isFiletab = false;
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
function onMountTab(e) {
  const { tab, hostEl } = e.detail;

  // 'files' kind: legacy file 브라우저 (Notion 식 + 폴더 그리드 + 토글 등 기존 기능 풀세트) 를 iframe 으로
  if (tab.kind === 'files') {
    if (hostEl.querySelector('iframe[data-files-frame]')) return;  // 이미 마운트됨
    const ifr = document.createElement('iframe');
    ifr.dataset.filesFrame = '1';
    ifr.dataset.tabId = tab.id;  // postMessage e.source 역매핑용
    ifr.src = `${BASE}/legacy-files`;
    ifr.style.cssText = 'width:100%;height:100%;border:0;display:block;background:var(--bg)';
    hostEl.appendChild(ifr);
    // F5 후 복원: tab 에 currentFile 저장돼 있으면 iframe 부팅 후 자동 오픈.
    // iframe.src 가 막 set 된 직후라 load 가 비동기로 발화 — listener 등록 시점
    // 까지는 안 fire 됐어야 하지만 안전하게 contentWindow 도 같이 폴링.
    if (tab.currentFile) {
      const restorePath = tab.currentFile;
      let done = false;
      const tryRestore = () => {
        if (done) return true;
        try {
          const cw = ifr.contentWindow;
          if (cw?.__cnReady && typeof cw.__cnOpenFile === 'function') {
            cw.__cnOpenFile(restorePath);
            done = true;
            return true;
          }
        } catch (_) {}
        return false;
      };
      let tries = 0;
      const tick = () => {
        if (tryRestore() || ++tries > 60) return;
        setTimeout(tick, 100);
      };
      tick();
      ifr.addEventListener('load', () => { tries = 0; tick(); }, { once: true });
    }
    return;
  }

  // 'term' kind: 옛 legacy 터미널 페이지 (chat 토글 + 파일 attach + 가상키보드
  // + textarea input bar 풀세트) 를 iframe 으로. terminal.js 의 connectFromHash
  // 가 #<name> 보고 자동 연결.
  if (tab.kind === 'term') {
    if (hostEl.querySelector('iframe[data-term-frame]')) return;
    const ifr = document.createElement('iframe');
    ifr.dataset.termFrame = '1';
    ifr.dataset.tabId = tab.id;
    ifr.src = `${BASE}/legacy-terminal#${encodeURIComponent(tab.contentRef)}`;
    ifr.style.cssText = 'width:100%;height:100%;border:0;display:block;background:var(--bg)';
    hostEl.appendChild(ifr);
    // F5 복원 시 tab.host 가 없으면 term-hosts 조회해서 라벨 갱신
    if (!tab.host) {
      fetch(`${BASE}/api/term-hosts`, { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : {})
        .then(map => {
          const host = map[tab.contentRef] || 'local';
          tabStore.updateTab(tab.id, { host });
          const tabEl = document.querySelector(`[data-tab-id="${tab.id}"]`);
          if (tabEl) {
            const nameEl = tabEl.querySelector('.tab-name');
            const label = `Terminal ${tab.contentRef}` + (host && host !== 'local' ? ` · ${host}` : '');
            if (nameEl) nameEl.textContent = label;
            tabEl.title = label;
          }
        })
        .catch(() => {});
    }
    return;
  }

  let inst = instances.get(tab.id);
  if (inst && inst._mountedHost === hostEl) {
    inst.fit?.();
    return;
  }
  if (!inst) {
    inst = new FileViewerInstance();  // dead path (kind:'file' 안 씀, B 방향)
    instances.set(tab.id, inst);
  }
  inst.mount(hostEl, tab.contentRef);
  inst._mountedHost = hostEl;
}

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

// 'files' iframe 의 legacy app 이 파일 열 때 알림 → tab.currentFile +
// contentRef (탭 타이틀) 업데이트. F5 후 자동 복원도 지원.
window.addEventListener('message', (e) => {
  if (!e.data) return;
  // 'files' iframe — 파일 열림 알림 → contentRef = 파일명
  if (e.data.type === 'cn-file-opened') {
    for (const ifr of document.querySelectorAll('iframe[data-files-frame]')) {
      if (ifr.contentWindow === e.source) {
        const tabId = ifr.dataset.tabId;
        if (!tabId) break;
        const path = e.data.path;
        const fname = path.split('/').pop() || path;
        tabStore.updateTab(tabId, { currentFile: path, contentRef: fname });
        const tabEl = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabEl) {
          const nameEl = tabEl.querySelector('.tab-name');
          if (nameEl) nameEl.textContent = fname;
          tabEl.title = path;
        }
        break;
      }
    }
    return;
  }
  // 'term' iframe — 사용자가 iframe 안 사이드바로 다른 터미널 전환 시 외부
  // 탭 라벨 동기화. legacy 의 updateHash 가 iframe URL hash 자체 갱신하므로
  // F5 후 복원도 자동 (mount-tab 시 ifr.src 새로 만들지만 contentRef 가
  // 이미 업데이트된 name 이라 그 hash 로 마운트됨).
  if (e.data.type === 'cn-term-switched') {
    const name = e.data.name;
    for (const ifr of document.querySelectorAll('iframe[data-term-frame]')) {
      if (ifr.contentWindow === e.source) {
        const tabId = ifr.dataset.tabId;
        if (!tabId) break;
        // host 도 함께 sync — 사용자 요청: 탭 라벨에 어떤 서버 터미널인지 표시
        fetch(`${BASE}/api/term-hosts`, { credentials: 'same-origin' })
          .then(r => r.ok ? r.json() : {})
          .then(map => {
            const host = map[name] || 'local';
            tabStore.updateTab(tabId, { contentRef: name, host });
            const tabEl = document.querySelector(`[data-tab-id="${tabId}"]`);
            if (tabEl) {
              const nameEl = tabEl.querySelector('.tab-name');
              const label = `Terminal ${name}` + (host && host !== 'local' ? ` · ${host}` : '');
              if (nameEl) nameEl.textContent = label;
              tabEl.title = label;
            }
          })
          .catch(() => {});
        break;
      }
    }
    return;
  }
});

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
