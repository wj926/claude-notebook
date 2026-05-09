// 통합 페이지 부트.
import { BASE, mutFetchOpts } from './core/api.js';
import * as layout from './main/layout.js';
import * as tabStore from './main/tab-store.js';
import { TerminalInstance } from './terminals/term-instance.js';
import { FileViewerInstance } from './viewers/file-instance.js';
import { initTree, loadTree } from './ui/tree.js';
import { initSidebar } from './ui/sidebar.js';

const JUPYTER_BASE = window.__JUPYTER_BASE !== undefined ? window.__JUPYTER_BASE : BASE;

// instances: tabId → instance (lifecycle bound to tab)
const instances = new Map();

layout.init(document.getElementById('main'));

// Sidebar (existing module — needs the IDs we put in index.html)
initSidebar();

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

// New terminal button in sidebar
const newTermBtn = document.getElementById('new-term-btn');
if (newTermBtn) {
  newTermBtn.addEventListener('click', () => {
    fetch(`${JUPYTER_BASE}/api/terminals`, mutFetchOpts({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })).then(r => r.json()).then(data => {
      const name = data.name || data.id;
      if (!name) throw new Error('no name in response');
      const leafId = layout.getActiveLeafId();
      const tabId = tabStore.openTab({ kind: 'term', contentRef: name, leafId });
      layout.activateTab(tabId);
    }).catch(err => console.error('create terminal failed', err));
  });
}

// resize → fit terminals
window.addEventListener('resize', () => {
  for (const inst of instances.values()) inst.fit?.();
});
layout.onChange(() => {
  for (const inst of instances.values()) inst.fit?.();
});
