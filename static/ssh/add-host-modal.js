import { BASE, mutFetchOpts } from '../core/api.js';

const STATUS_UI = {
  key_ok:             { color: '🟢', text: 'Auto-login OK' },
  auth_prompt_likely: { color: '🟡', text: '비밀번호 prompt 필요 — 실 연결은 가능' },
  unreachable:        { color: '🔴', text: '호스트 도달 불가' },
  host_key_error:     { color: '🔴', text: '호스트 키 충돌 (~/.ssh/known_hosts)' },
  config_error:       { color: '🔴', text: 'SSH 설정 오류' },
  unknown_error:      { color: '⚠',  text: '알 수 없는 오류' },
};

export function openAddModal({ onAdded } = {}) {
  const m = document.getElementById('add-host-modal');
  if (!m) return;
  m.innerHTML = `
    <div class="modal-box">
      <header class="modal-head">Add SSH host</header>
      <div class="modal-body">
        <label>Name <input name="label" placeholder="my-server"></label>
        <label>Host <input name="connect" placeholder="user@host or alias"></label>
      </div>
      <div class="test-result" hidden></div>
      <footer class="modal-foot">
        <button data-act="cancel" type="button">Cancel</button>
        <button data-act="test" type="button">Auto-login test</button>
        <button data-act="add" class="primary" type="button">Add</button>
      </footer>
    </div>
  `;
  m.hidden = false;

  let testHostId = null;
  let testWasAdded = false;  // track if user accepts the tested host

  async function close() {
    if (testHostId && !testWasAdded) {
      // cleanup: Test 만 한 후 Cancel → 임시 host 삭제
      try {
        await fetch(`${BASE}/api/hosts/${encodeURIComponent(testHostId)}`, mutFetchOpts({ method: 'DELETE' }));
      } catch (_) {}
    }
    m.hidden = true;
    m.innerHTML = '';
  }

  // outside click
  m.addEventListener('click', e => { if (e.target === m) close(); });
  m.querySelector('[data-act=cancel]').addEventListener('click', close);

  m.querySelector('[data-act=test]').addEventListener('click', async () => {
    const label = m.querySelector('input[name=label]').value.trim();
    const connect = m.querySelector('input[name=connect]').value.trim() || null;
    if (!label) { alert('Name 을 입력하세요'); return; }
    // 기존 testHostId 있으면 변경 가능성 — 매번 새로 등록 (DELETE 후 POST)
    if (testHostId) {
      try { await fetch(`${BASE}/api/hosts/${encodeURIComponent(testHostId)}`, mutFetchOpts({ method: 'DELETE' })); } catch (_) {}
      testHostId = null;
    }
    let r;
    try {
      r = await fetch(`${BASE}/api/hosts`, mutFetchOpts({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, connect }),
      }));
    } catch (err) { alert('네트워크 오류'); return; }
    if (!r.ok) { alert('등록 실패 (status ' + r.status + ')'); return; }
    testHostId = (await r.json()).id;
    let tr;
    try {
      tr = await fetch(`${BASE}/api/hosts/${encodeURIComponent(testHostId)}/test`,
        mutFetchOpts({ method: 'POST' }));
    } catch (err) { alert('테스트 실패'); return; }
    const j = await tr.json();
    const ui = STATUS_UI[j.status] || STATUS_UI.unknown_error;
    const box = m.querySelector('.test-result');
    box.hidden = false;
    box.innerHTML = `<strong>${ui.color} ${ui.text}</strong><pre style="white-space:pre-wrap;font-size:11px;color:#666;margin-top:6px">${esc(j.stderr_excerpt || '')}</pre>`;
  });

  m.querySelector('[data-act=add]').addEventListener('click', async () => {
    const label = m.querySelector('input[name=label]').value.trim();
    const connect = m.querySelector('input[name=connect]').value.trim() || null;
    if (!label) { alert('Name 을 입력하세요'); return; }
    if (!testHostId) {
      // Test 안 한 채로 직접 Add — 등록만
      let r;
      try {
        r = await fetch(`${BASE}/api/hosts`, mutFetchOpts({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, connect }),
        }));
      } catch (err) { alert('네트워크 오류'); return; }
      if (!r.ok) { alert('등록 실패 (status ' + r.status + ')'); return; }
    }
    testWasAdded = true;  // close() 가 cleanup 안 하도록
    onAdded?.();
    close();
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
