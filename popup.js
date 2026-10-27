document.addEventListener('DOMContentLoaded', async () => {
  const albumSidInput = document.getElementById('albumSid');
  const songSidInput = document.getElementById('songSid');
  const accountInput = document.getElementById('accountInput');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnDownLog = document.getElementById('btnDownLog');
  const btnClearLog = document.getElementById('btnClearLog');
  const logViewer = document.getElementById('logViewer');

  // 초기 저장 데이터 불러오기
  const saved = await chrome.storage.local.get(['albumSid', 'songSid', 'rawAccounts', 'logs']);
  if (saved.albumSid) albumSidInput.value = saved.albumSid;
  if (saved.songSid) songSidInput.value = saved.songSid;
  if (saved.rawAccounts) accountInput.value = saved.rawAccounts;
  renderLogs(saved.logs || []);

  // 실시간 로그 업데이트 감지
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.logs) {
      renderLogs(changes.logs.newValue || []);
    }
  });

  function renderLogs(logs) {
    if (!logs || logs.length === 0) {
      logViewer.innerHTML = '<span style="color:#777;">기록된 로그가 없습니다.</span>';
      return;
    }
    logViewer.innerHTML = logs.map(line => {
      let cls = 'log-info';
      if (line.includes('[SUCCESS]')) cls = 'log-success';
      else if (line.includes('[ERROR]')) cls = 'log-error';
      return `<div class="${cls}">${escapeHtml(line)}</div>`;
    }).join('');
    logViewer.scrollTop = logViewer.scrollHeight;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // [자동화 시작] 버튼 클릭
  btnStart.addEventListener('click', async () => {
    const albumSid = albumSidInput.value.trim();
    const songSid = songSidInput.value.trim();
    const rawAccounts = accountInput.value.trim();

    if (!albumSid || !songSid) {
      alert('앨범 SID와 음원 SID를 모두 입력해주세요.');
      return;
    }
    if (!rawAccounts) {
      alert('계정 목록을 입력해주세요.');
      return;
    }

    // 탭(Tab) 또는 공백 기준으로 아이디/비번 파싱
    const accounts = rawAccounts.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const parts = line.split(/\t|\s+/);
        return { id: parts[0]?.trim(), pw: parts[1]?.trim() };
      })
      .filter(acc => acc.id && acc.pw);

    if (accounts.length === 0) {
      alert('유효한 계정 형식이 없습니다. (아이디[탭]비밀번호 형식으로 입력)');
      return;
    }

    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const startLog = `[${now}] [INFO] (System) 자동화 시작 - 총 ${accounts.length}개 계정 | 앨범:${albumSid}, 곡:${songSid}`;
    const existing = await chrome.storage.local.get({ logs: [] });
    const updatedLogs = [...existing.logs, startLog];

    // 현재 활성 탭 확인
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.storage.local.set({
      albumSid,
      songSid,
      rawAccounts,
      accounts,
      currentIndex: 0,
      isRunning: true,
      currentStep: 'WAIT_LOGOUT', // 기존 세션 정리(로그아웃)부터 깔끔하게 시작
      stepRetry: 0,
      mainTabId: activeTab ? activeTab.id : null,
      logs: updatedLogs
    });

    if (activeTab) {
      chrome.tabs.update(activeTab.id, { url: "https://www.genie.co.kr/member/logout" });
    }
  });

  // [정지] 버튼 클릭
  btnStop.addEventListener('click', async () => {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const data = await chrome.storage.local.get({ logs: [] });
    data.logs.push(`[${now}] [ERROR] (System) 사용자에 의해 작업이 중지되었습니다.`);
    await chrome.storage.local.set({
      isRunning: false,
      currentStep: 'IDLE',
      logs: data.logs
    });
  });

  // [로그 .txt 내려받기] 버튼 클릭
  btnDownLog.addEventListener('click', async () => {
    const data = await chrome.storage.local.get({ logs: [] });
    if (!data.logs || data.logs.length === 0) {
      alert('다운로드할 로그 내역이 없습니다.');
      return;
    }
    const blob = new Blob([data.logs.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `genie_automation_log_${timestamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // [초기화] 버튼 클릭
  btnClearLog.addEventListener('click', async () => {
    await chrome.storage.local.set({ logs: [] });
  });
});