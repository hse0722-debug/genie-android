function extractId(input, paramName) {
  if (!input) return "";
  const str = input.trim();
  if (str.includes('genie.co.kr')) {
    try {
      const url = new URL(str.startsWith('http') ? str : 'https://' + str);
      return url.searchParams.get(paramName)?.replace(/[^0-9]/g, '') || "";
    } catch (e) {}
  }
  return str.replace(/[^0-9]/g, '');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// 페이지 전역 함수(MAIN world) 호출 헬퍼
function callPageFunction(fnName, args = []) {
  window.dispatchEvent(new CustomEvent('GENIE_CALL_PAGE_FN', {
    detail: { fnName, args }
  }));
}

// URL 생성 공통 헬퍼
const getUrl = (t, id) =>
  `https://www.genie.co.kr/detail/${t === 'album' ? 'albumInfo?axnm=' : 'songInfo?xgnm='}${encodeURIComponent(id)}`;

// 다음 단계의 첫 번째 목적지 계산
function getNextStageUrl(nextStep, data) {
  if (nextStep === 'ALBUM_LIKE') {
    if (data.albums && data.albums.length > 0) {
      return { step: 'ALBUM_LIKE', url: getUrl('album', data.albums[0]) };
    }
    nextStep = 'SONG_LIKE';
  }
  if (nextStep === 'SONG_LIKE') {
    if (data.songs && data.songs.length > 0) {
      return { step: 'SONG_LIKE', url: getUrl('song', data.songs[0]) };
    }
    nextStep = 'NEXT_ACCOUNT_LOGIN';
  }
  return {
    step: 'NEXT_ACCOUNT_LOGIN',
    url: "https://www.genie.co.kr/member/logout?page_rfr=" + encodeURIComponent("https://www.genie.co.kr/")
  };
}

// 실시간 로그 및 상태 저장 함수
async function saveLog(text, type = 'INFO') {
  const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const data = await chrome.storage.local.get({ logs: [], accounts: [], currentIndex: 0 });
  const accId = data.accounts[data.currentIndex]?.id || 'System';
  const entry = `[${now}] [${type}] (${accId}) ${text}`;
  const updatedLogs = [...(data.logs || []), entry];

  await chrome.storage.local.set({
    logs: updatedLogs,
    lastActionText: `${text} (${now})`
  });
}

// 단계별 결과(o, x) 기록 헬퍼 함수
async function updateStepResult(accId, key, val) {
  if (!accId) return;
  const data = await chrome.storage.local.get({ accountResults: {} });
  const results = data.accountResults || {};
  if (!results[accId]) results[accId] = { album: '-', song: '-', down: '-' };
  results[accId][key] = val;
  await chrome.storage.local.set({ accountResults: results });
}

// 로그인 상태 확인 헬퍼
function isUserLoggedIn() {
  const myInfoBtn = document.querySelector('button.btn[onclick*="getMyProductInfo"]');
  const logoutBtn = document.querySelector('a.btn-logout[onclick*="logout"], a.btn-logout');
  return Boolean(myInfoBtn || logoutBtn);
}

// 지정된 구글 시트에서 고정 시드를 읽습니다.
async function loadSheetSeeds() {
  const status = document.getElementById('sheet-seed-status');
  if (status) status.textContent = '구글 시트에서 불러오는 중...';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'GET_SHEET_SEEDS' });
    if (!result?.ok) throw new Error(result?.error || '시트 응답을 받지 못했습니다.');
    const seeds = result.seeds;
    const previous = await chrome.storage.local.get(['albums', 'songs']);
    const changed = previous.albums?.[0] !== seeds.albumSid || previous.songs?.[0] !== seeds.songSid;
    await chrome.storage.local.set({
      albums: [seeds.albumSid], songs: [seeds.songSid],
      sheetAlbumName: seeds.albumName, sheetSongName: seeds.songName,
      ...(changed ? { step: 'CHECK_OR_LOGIN', albumIndex: 0, songIndex: 0 } : {})
    });
    await updateDashboardUI();
    if (status) status.textContent = '';
    return true;
  } catch (err) {
    if (status) status.textContent = '시트 로드 실패: ' + err.message;
    await saveLog('❌ 구글 시트 로드 실패: ' + err.message, 'ERROR');
    return false;
  }
}

// =========================================================
// 1. 플로팅 리모컨 대시보드 UI (결제/다운로드 팝업창 제외 처리)
// =========================================================
async function createFloatingPanel() {
  const url = window.location.href;
  
  if (
    window !== window.top ||
    url.includes('popLogin') ||
    url.includes('/buy/') ||
    url.includes('Popup') ||
    url.includes('pop')
  ) {
    return;
  }

  if (!document.body) {
    setTimeout(createFloatingPanel, 100);
    return;
  }

  chrome.runtime.sendMessage({ action: 'REGISTER_MAIN_TAB' }).catch(() => {});

  if (!document.getElementById('genie-open-btn')) {
    const openBtn = document.createElement('button');
    openBtn.id = 'genie-open-btn';
    openBtn.innerHTML = '🎵 도우미 열기';
    openBtn.style.cssText = `
      position: fixed; bottom: 15px; right: 15px; z-index: 2147483646;
      background: #2980b9; color: white; border: none; padding: 10px 15px;
      border-radius: 25px; font-weight: bold; font-size: 12px; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); font-family: 'Malgun Gothic', sans-serif;
    `;
    openBtn.onclick = async () => {
      const dash = document.getElementById('genie-helper-dashboard');
      if (dash) {
        dash.style.display = 'block';
        await chrome.storage.local.set({ panelHidden: false });
      }
    };
    document.body.appendChild(openBtn);
  }

  if (document.getElementById('genie-helper-dashboard')) return;

  const posData = await chrome.storage.local.get(['panelPos', 'panelHidden']);
  const panel = document.createElement('div');
  panel.id = 'genie-helper-dashboard';

  let posStyle = 'bottom: 60px; right: 15px;';
  if (posData.panelPos && posData.panelPos.left && posData.panelPos.top) {
    posStyle = `left: ${posData.panelPos.left}; top: ${posData.panelPos.top};`;
  }
  const displayStyle = posData.panelHidden ? 'none' : 'block';

  panel.style.cssText = `
    position: fixed; ${posStyle} display: ${displayStyle};
    width: 430px; max-width: calc(100vw - 30px); box-sizing: border-box; max-height: 85vh; overflow-y: auto;
    background: #ffffff; color: #333333; border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.35); z-index: 2147483647;
    font-family: 'Malgun Gothic', sans-serif; border: 2px solid #2c3e50; text-align: left;
  `;

  panel.innerHTML = `
    <div id="dash-header" style="background:#2c3e50; color:white; padding:10px 14px; cursor:move; display:flex; justify-content:space-between; align-items:center; border-radius:7px 7px 0 0; user-select:none;">
      <span style="font-weight:bold; font-size:13px;">🎵 지니 다운 도우미 ${globalThis.__genieRuntimeVersion || "9.0.0"} [포레스텔라음원총공팀 제작]</span>
      <button id="btn-close-dash" style="background:#e74c3c; color:white; border:none; padding:3px 8px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:11px;">숨기기 _</button>
    </div>

    <div style="padding: 12px;">
      <!-- 상단 상태 알림 및 시작/중단 버튼 -->
      <div style="background:#f8f9fa; padding:10px; border:1px solid #ddd; border-radius:6px; margin-bottom:10px;">
        <div style="margin-bottom:8px; font-size:11px; line-height:1.4;">
          <b>상태 알림:</b> <span id="dash-last-log" style="color:#d35400; font-weight:bold;">대기 중</span><br>
          <span id="dash-summary" style="color:#2980b9; font-weight:bold;">데이터 로드 중...</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button id="btn-resume" style="flex:1; padding:8px; background:#2980b9; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer; font-size:12px;">▶ 시작 (이어서 열기)</button>
          <button id="btn-stop" style="flex:1; padding:8px; background:#c0392b; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer; font-size:12px;">⏸ 중단 · 위치저장</button>
        </div>
      </div>

      <!-- 계정 파일 버튼 및 구글 시트 고정 SID 표시 -->
      <div style="margin-bottom:10px; border:1px solid #ddd; border-radius:6px; padding:8px; background:#fafafa;">
        <div style="display:flex; gap:4px; margin-bottom:6px;">
          <button id="btn-load-acc" style="flex:1; padding:6px 4px; background:#ecf0f1; border:1px solid #bdc3c7; border-radius:4px; cursor:pointer; font-weight:bold; font-size:11px;">📁 계정(.txt)</button>
          <input type="file" id="file-acc" accept=".txt" style="display:none;">
          <button id="btn-reset-all" style="padding:6px 8px; background:#95a5a6; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold; font-size:11px;">초기화</button>
        </div>
        <!-- C3: C4, D3: D4 형식의 읽기 전용 표시 -->
        <div style="font-size:12px; line-height:1.6; overflow-wrap:anywhere;">
          <div id="sheet-album-seed">앨범 정보 불러오는 중...</div>
          <div id="sheet-song-seed">곡 정보 불러오는 중...</div>
          <div id="sheet-seed-status" role="status" style="font-size:11px; color:#666;"></div>
        </div>
      </div>

      <!-- 계정별 진행 현황 테이블 -->
      <div id="dash-table-wrap" style="max-height: 150px; overflow-y: auto; border:1px solid #ddd; display:block; margin-bottom:10px;">
        <table style="width:100%; border-collapse:collapse; font-size:11px; text-align:center;">
          <thead style="position: sticky; top: 0; background:#ecf0f1; z-index:2;">
            <tr>
              <th style="padding:5px; border:1px solid #ddd;">아이디</th>
              <th style="padding:5px; border:1px solid #ddd;">순서</th>
              <th style="padding:5px; border:1px solid #ddd;">앨범 좋아요</th>
              <th style="padding:5px; border:1px solid #ddd;">곡 좋아요</th>
              <th style="padding:5px; border:1px solid #ddd;">다운</th>
            </tr>
          </thead>
          <tbody id="dash-table-body">
            <tr><td colspan="5" style="padding:10px;">계정 파일을 불러오세요.</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 실시간 성공/에러 로그 뷰어 및 .txt 다운로드 -->
      <div style="border:1px solid #ddd; border-radius:6px; padding:8px; background:#f8f9fa;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
          <b style="font-size:11px; color:#2c3e50;">📋 실시간 성공 / 에러 로그</b>
          <div style="display:flex; gap:4px;">
            <button id="btn-down-log" style="background:#2980b9; color:white; border:none; padding:3px 8px; border-radius:3px; cursor:pointer; font-size:11px; font-weight:bold;">💾 로그 .txt 저장</button>
            <button id="btn-clear-log" style="background:#7f8c8d; color:white; border:none; padding:3px 6px; border-radius:3px; cursor:pointer; font-size:11px;">지우기</button>
          </div>
        </div>
        <div id="dash-log-box" style="height:100px; overflow-y:auto; background:#1e272e; color:#d2dae2; padding:6px; border-radius:4px; font-family:Consolas, monospace; font-size:11px; line-height:1.4; white-space:pre-wrap; word-break:break-all;">로그 대기 중...</div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const header = document.getElementById('dash-header');
  let isDragging = false, offsetX = 0, offsetY = 0;

  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'btn-close-dash') return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.bottom = 'auto';
    panel.style.right = 'auto';
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.left = (e.clientX - offsetX) + 'px';
    panel.style.top = (e.clientY - offsetY) + 'px';
  });

  document.addEventListener('mouseup', async () => {
    if (isDragging) {
      isDragging = false;
      await chrome.storage.local.set({ panelPos: { left: panel.style.left, top: panel.style.top } });
    }
  });

  document.getElementById('btn-close-dash').onclick = async () => {
    panel.style.display = 'none';
    await chrome.storage.local.set({ panelHidden: true });
  };

  async function handleAccountFile(file) {
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    
    // 탭, 쉼표, 스페이스바 공백을 모두 구분자로 처리
    const result = lines.map(l => {
      const p = l.split(/[\t, ]+/);
      return { id: p[0]?.trim(), pw: p[1]?.trim() };
    }).filter(a => a.id && a.pw);

    await chrome.storage.local.set({ accounts: result, accountResults: {} });
    await saveLog(`📁 계정 데이터 ${result.length}개 로드 완료`, 'SUCCESS');
    updateDashboardUI();
  }

  document.getElementById('btn-load-acc').onclick = () => document.getElementById('file-acc').click();
  document.getElementById('file-acc').onchange = (e) => {
    handleAccountFile(e.target.files[0]);
    e.target.value = '';
  };

  document.getElementById('btn-resume').onclick = async () => {
    const startBtn = document.getElementById('btn-resume');
    if (startBtn.disabled || navigationPending) return;
    startBtn.disabled = true;
    let loaded;
    try { loaded = await loadSheetSeeds(); }
    finally { startBtn.disabled = false; }
    if (!loaded) return;

    const data = await chrome.storage.local.get(['accounts', 'step', 'currentIndex', 'albumIndex', 'songIndex', 'albums', 'songs']);
    if (!data.accounts || data.accounts.length === 0) {
      await saveLog('⚠️ 계정 파일을 먼저 등록해주세요!', 'ERROR');
      return;
    }
    if (!data.songs || data.songs.length === 0) {
      await saveLog('⚠️ 구글 시트의 곡 시드를 확인해주세요!', 'ERROR');
      return;
    }

    chrome.runtime.sendMessage({ action: 'REGISTER_MAIN_TAB' }).catch(() => {});

    const pausedDownload = ['SONG_DOWNLOAD', 'PAY_POPUP_STEP1', 'WAIT_DOWNLOAD_STREAM', 'DOWNLOAD_RECEIVED'].includes(data.step);
    const step = pausedDownload ? 'SONG_LIKE' : (data.step && !['IDLE', 'ACCOUNT_ROLLOVER'].includes(data.step)) ? data.step : 'CHECK_OR_LOGIN';
    const cIdx = data.currentIndex || 0;
    const albIdx = data.albumIndex || 0;
    const sIdx = data.songIndex || 0;

    await chrome.storage.local.set({
      isRunning: true,
      runId: crypto.randomUUID(),
      actionClaims: {},
      downloadWaitStartedAt: 0,
      step,
      currentIndex: cIdx,
      albumIndex: albIdx,
      songIndex: sIdx,
      waitRetry: 0
    });

    await saveLog(`▶ 자동화 작업 시작 (${cIdx + 1}번 계정: ${data.accounts[cIdx]?.id})`, 'INFO');

    const firstStage = getNextStageUrl('ALBUM_LIKE', data);
    let targetUrl = "https://www.genie.co.kr/member/popLogin?page_rfr=" + encodeURIComponent(firstStage.url);

    if (step === 'ALBUM_LIKE' && data.albums?.length) {
      targetUrl = getUrl('album', data.albums[albIdx] || data.albums[0]);
    } else if ((step === 'SONG_LIKE' || step === 'SONG_DOWNLOAD') && data.songs?.length) {
      targetUrl = getUrl('song', data.songs[sIdx] || data.songs[0]);
    }

    navigateTask(targetUrl);
  };

  document.getElementById('btn-stop').onclick = async () => {
    await chrome.storage.local.set({ isRunning: false });
    await saveLog('⏸ 작업 중단됨 (현재 위치 저장 완료)', 'ERROR');
    updateDashboardUI();
  };

  let resetConfirm = false;
  const resetBtn = document.getElementById('btn-reset-all');
  resetBtn.onclick = async () => {
    if (!resetConfirm) {
      resetConfirm = true;
      resetBtn.textContent = '정말 초기화?';
      resetBtn.style.background = '#e74c3c';
      setTimeout(() => {
        resetConfirm = false;
        if (resetBtn) {
          resetBtn.textContent = '초기화';
          resetBtn.style.background = '#95a5a6';
        }
      }, 3000);
      return;
    }
    resetConfirm = false;
    resetBtn.textContent = '초기화';
    resetBtn.style.background = '#95a5a6';
    await chrome.storage.local.clear();
    updateDashboardUI();
  };

  document.getElementById('btn-down-log').onclick = async () => {
    const data = await chrome.storage.local.get({ logs: [] });
    if (!data.logs || data.logs.length === 0) {
      await saveLog('⚠️ 저장할 로그 내역이 없습니다.', 'ERROR');
      return;
    }
    const blob = new Blob([data.logs.join('\n')], { type: 'text/plain;charset=utf-8' });
    const urlObj = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = urlObj;
    a.download = `genie_download_log_${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(urlObj);
  };

  document.getElementById('btn-clear-log').onclick = async () => {
    await chrome.storage.local.set({ logs: [] });
    updateDashboardUI();
  };

  document.getElementById('dash-table-body').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-idx]');
    if (!tr) return;
    const idx = parseInt(tr.getAttribute('data-idx'), 10);
    if (isNaN(idx)) return;
    await chrome.storage.local.set({
      currentIndex: idx,
      step: 'CHECK_OR_LOGIN',
      albumIndex: 0,
      songIndex: 0,
      isRunning: false,
      waitRetry: 0
    });
    await saveLog(`📌 ${idx + 1}번 계정(${tr.children[0]?.textContent})으로 시작 위치 변경됨`, 'INFO');
    updateDashboardUI();
  });

  await updateDashboardUI();
  const state = await chrome.storage.local.get(['isRunning']);
  if (!state.isRunning) await loadSheetSeeds();
}

function renderMark(val) {
  if (val === 'o') return "<b style='color:#27ae60;'>o</b>";
  if (val === 'x') return "<b style='color:#e74c3c;'>x</b>";
  return "<span style='color:#95a5a6;'>-</span>";
}

async function updateDashboardUI() {
  const tbody = document.getElementById('dash-table-body');
  const summary = document.getElementById('dash-summary');
  const lastLog = document.getElementById('dash-last-log');
  const logBox = document.getElementById('dash-log-box');
  const sheetAlbum = document.getElementById('sheet-album-seed');
  const sheetSong = document.getElementById('sheet-song-seed');
  if (!tbody) return;

  const data = await chrome.storage.local.get([
    'accounts', 'albums', 'songs', 'currentIndex', 'albumIndex', 'songIndex', 'isRunning', 'step', 'lastActionText', 'logs', 'accountResults', 'sheetAlbumName', 'sheetSongName'
  ]);
  const accs = data.accounts || [];
  const cIdx = data.currentIndex || 0;
  const albLen = (data.albums || []).length;
  const sonLen = (data.songs || []).length;
  const results = data.accountResults || {};

  if (sheetAlbum) sheetAlbum.textContent = data.sheetAlbumName && data.albums?.[0]
    ? data.sheetAlbumName + ': ' + data.albums[0] : '앨범 정보 없음';
  if (sheetSong) sheetSong.textContent = data.sheetSongName && data.songs?.[0]
    ? data.sheetSongName + ': ' + data.songs[0] : '곡 정보 없음';

  lastLog.textContent = data.lastActionText || '대기 중';
  summary.textContent = `전체 ${accs.length}계정 | 완료 ${Math.min(cIdx, accs.length)} · 진행 ${data.isRunning ? 1 : 0} (앨범:${albLen}개, 곡:${sonLen}개)`;

  const logs = data.logs || [];
  if (logBox) {
    if (logs.length === 0) {
      logBox.innerHTML = '<span style="color:#888;">기록된 로그가 없습니다.</span>';
    } else {
      logBox.innerHTML = logs.map(line => {
        let color = '#d2dae2';
        if (line.includes('[SUCCESS]')) color = '#0be881';
        else if (line.includes('[ERROR]')) color = '#ff5e57';
        return `<div style="color:${color};">${escapeHtml(line)}</div>`;
      }).join('');
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  if (accs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:10px;">계정 파일을 불러오세요.</td></tr>`;
    return;
  }

  let rowsHtml = '';
  accs.forEach((acc, i) => {
    const res = results[acc.id] || { album: '-', song: '-', down: '-' };
    let albMark = res.album || '-';
    let sonMark = res.song || '-';
    let downMark = res.down || '-';

    if (i < cIdx) {
      if (albMark === '-') albMark = 'x';
      if (sonMark === '-') sonMark = 'x';
      if (downMark === '-') downMark = 'x';
    }

    const bg = i === cIdx ? '#ebf5fb' : (i < cIdx ? '#f9f9f9' : '#ffffff');
    rowsHtml += `
      <tr data-idx="${i}" style="background:${bg}; border-bottom:1px solid #eee; cursor:pointer;" title="클릭하면 이 계정부터 시작합니다">
        <td style="padding:4px; border:1px solid #ddd; font-weight:bold;">${escapeHtml(acc.id)}</td>
        <td style="padding:4px; border:1px solid #ddd;">${i + 1}</td>
        <td style="padding:4px; border:1px solid #ddd;">${renderMark(albMark)}</td>
        <td style="padding:4px; border:1px solid #ddd;">${renderMark(sonMark)}</td>
        <td style="padding:4px; border:1px solid #ddd;">${renderMark(downMark)}</td>
      </tr>
    `;
  });
  tbody.innerHTML = rowsHtml;

  const activeRow = tbody.children[cIdx];
  if (activeRow) {
    activeRow.scrollIntoView({ block: 'nearest' });
  }
}

chrome.storage.onChanged.addListener(updateDashboardUI);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "SHOW_REMOTE") {
    createFloatingPanel();
    const panel = document.getElementById('genie-helper-dashboard');
    if (panel) {
      panel.style.display = 'block';
      chrome.storage.local.set({ panelHidden: false });
    }
  }
});

// =========================================================
// 2. 자동화 진행 로직
// =========================================================
function setInputValue(el, val) {
  if (!el) return;
  el.focus();
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const taskDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function performLikeWithCheck(onComplete) {
  const countEl = document.querySelector('#emLikeCount');
  const likeBtn = (countEl && countEl.closest('a, button')) ||
    document.querySelector('a.btn-like') || document.querySelector('a[onclick*="like"]');
  let ok = false, message = '좋아요 버튼 없음', delay = 700;
  if (likeBtn) {
    ok = true;
    const liked = likeBtn.classList.contains('on') || likeBtn.classList.contains('active') ||
      likeBtn.parentElement?.classList.contains('on');
    message = liked ? '이미 좋아요 상태(스킵)' : '좋아요 클릭 성공';
    if (!liked) { likeBtn.click(); delay = 1200; }
  }
  await taskDelay(delay);
  await onComplete(ok, message);
}

async function claimTaskAction(action, data) {
  const reply = await chrome.runtime.sendMessage({ action: 'CLAIM_TASK_ACTION', taskAction: action,
    expected: { runId: data.runId, currentIndex: data.currentIndex || 0,
      albumIndex: data.albumIndex || 0, songIndex: data.songIndex || 0 } });
  return reply?.granted === true;
}

async function isTaskCurrent(data, allowedSteps) {
  const now = await chrome.storage.local.get(['isRunning', 'runId', 'currentIndex', 'albumIndex', 'songIndex', 'step']);
  return now.isRunning && now.runId === data.runId &&
    (now.currentIndex || 0) === (data.currentIndex || 0) &&
    (now.albumIndex || 0) === (data.albumIndex || 0) &&
    (now.songIndex || 0) === (data.songIndex || 0) &&
    !['DOWNLOAD_RECEIVED', 'ACCOUNT_ROLLOVER'].includes(now.step) &&
    (!allowedSteps || allowedSteps.includes(now.step));
}

function actionable(el) {
  return Boolean(el && el.getClientRects().length && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
}

// 결제창은 앞으로만 진행합니다. 버튼 클릭 후 동일 함수를 다시 호출하지 않습니다.
async function handlePayment(data) {
  if (!['SONG_DOWNLOAD', 'PAY_POPUP_STEP1', 'WAIT_DOWNLOAD_STREAM'].includes(data.step)) return false;
  if (data.step === 'WAIT_DOWNLOAD_STREAM') return false;
  const cash = document.querySelector('input#name-genie[name="selectPay"][value="8"], #name-genie');
  const agree = document.querySelector('input#name-agree');
  const purchase = document.querySelector('input#name-payment');
  const finalSelector = 'a.def-btn.radius.btn-blue[onclick*="fnCashPay"], a[onclick*="fnCashPay"]';
  const final = document.querySelector(finalSelector);
  const controls = [cash, agree, purchase].filter(actionable);
  if (controls.length || actionable(final)) {
    let changed = false;
    for (const control of controls) {
      if (!control.checked) { control.click(); changed = true; }
    }
    if (changed) await saveLog('[결제 2~4단계] 지니캐시 선택 및 약관·구매 동의 체크', 'INFO');
    const button = document.querySelector(finalSelector);
    if (controls.some(el => !el.checked) || !actionable(button)) return false;
    if (!await claimTaskAction('PAY_FINAL', data)) return false;
    // 기존 최종 결제 전 대기시간을 유지하고, 중단/계정 변경 시 클릭하지 않습니다.
    await taskDelay(900);
    if (!await isTaskCurrent(data)) return true;
    const readyButton = document.querySelector(finalSelector);
    const currentControls = [
      document.querySelector('input#name-genie[name="selectPay"][value="8"], #name-genie'),
      document.querySelector('input#name-agree'), document.querySelector('input#name-payment')
    ].filter(actionable);
    if (!actionable(readyButton) || currentControls.some(el => !el.checked)) {
      await chrome.storage.local.set({ isRunning: false });
      await saveLog('결제 화면이 변경되어 중단했습니다. 화면 확인 후 다시 시작해주세요.', 'ERROR');
      return true;
    }
    await saveLog('[결제 최종단계] "결제하기" 버튼 1회 클릭 → 다운로드 대기', 'INFO');
    if (await isTaskCurrent(data, ['WAIT_DOWNLOAD_STREAM'])) readyButton.click();
    return true;
  }
  const first = document.querySelector('#btnPaySong');
  if (data.step === 'SONG_DOWNLOAD' && actionable(first) && await claimTaskAction('PAY_SONG', data)) {
    if (!await isTaskCurrent(data, ['PAY_POPUP_STEP1'])) return true;
    await saveLog('[결제 1단계] 개별 곡 결제하기 버튼 1회 클릭', 'INFO');
    if (await isTaskCurrent(data, ['PAY_POPUP_STEP1'])) first.click();
    return true;
  }
  return false;
}

let navigationPending = false;
function navigateTask(url, replace = false) {
  navigationPending = true;
  if (replace) window.location.replace(url);
  else window.location.href = url;
}

let isStepRunning = false;

async function processTask() {
  if (isStepRunning || navigationPending) return;
  isStepRunning = true;

  try {
    createFloatingPanel();

    const data = await chrome.storage.local.get([
      'accounts', 'currentIndex', 'albums', 'songs', 'albumIndex', 'songIndex', 'isRunning', 'step', 'waitRetry', 'runId', 'downloadWaitStartedAt'
    ]);
    if (!data.isRunning || !data.accounts || data.accounts.length === 0) {
      isStepRunning = false;
      return;
    }

    const { accounts, currentIndex, albums, songs, albumIndex, songIndex, step } = data;
    if (currentIndex >= accounts.length) {
      await chrome.storage.local.set({ isRunning: false, step: 'IDLE' });
      await saveLog('✅ 모든 계정 작업 완료!', 'SUCCESS');
      isStepRunning = false;
      return;
    }

    if (['DOWNLOAD_RECEIVED', 'ACCOUNT_ROLLOVER'].includes(step)) return;
    const currentAccount = accounts[currentIndex];
    const currentUrl = window.location.href;

    if (await handlePayment(data)) return;

    // 비밀번호 변경 캠페인(myInfoPwdChangeMsg) 추가 
    if (currentUrl.includes('popLoginSuccess') || currentUrl.toLowerCase().includes('loginsuccess') || currentUrl.includes('myInfoPwdChangeMsg')) {
      const next = getNextStageUrl('ALBUM_LIKE', data);
      await chrome.storage.local.set({ step: next.step, waitRetry: 0 });
      navigateTask(next.url, true);
      isStepRunning = false;
      return;
    }

    const idInput =
      document.querySelector('#gnb_uxd') ||
      document.querySelector('#gnb_uxd_id') ||
      document.querySelector('#uxd_id') ||
      document.querySelector('input[name="gnb_uxd"]');
    const pwInput =
      document.querySelector('#gnb_uxx') ||
      document.querySelector('#gnb_uxd_pw') ||
      document.querySelector('#uxd_pw') ||
      document.querySelector('input[name="gnb_uxx"]');

    if (currentUrl.includes('/member/popLogin') || currentUrl.includes('/member/login') || (idInput && pwInput && idInput.offsetParent !== null)) {
      if (document.body && (document.body.innerText.includes('일치하지 않습니다') || document.body.innerText.includes('다시 확인해주세요'))) {
        if (!await claimTaskAction('LOGIN_FAILURE', data)) return;
        await saveLog(`❌ ${currentAccount.id} - 로그인 실패(아이디/비번 오류 스킵)`, 'ERROR');
        await updateStepResult(currentAccount.id, 'album', 'x');
        await updateStepResult(currentAccount.id, 'song', 'x');
        await updateStepResult(currentAccount.id, 'down', 'x');
        const nextStage = getNextStageUrl('ALBUM_LIKE', data);
        await chrome.storage.local.set({
          currentIndex: currentIndex + 1,
          step: 'CHECK_OR_LOGIN',
          albumIndex: 0,
          songIndex: 0
        });
        navigateTask("https://www.genie.co.kr/member/popLogin?page_rfr=" + encodeURIComponent(nextStage.url));
        isStepRunning = false;
        return;
      }

      if (idInput && pwInput) {
        if (!await claimTaskAction('LOGIN', data)) return;
        setInputValue(idInput, currentAccount.id);
        setInputValue(pwInput, currentAccount.pw);

        const nextStage = getNextStageUrl('ALBUM_LIKE', data);
        if (!step || step === 'CHECK_OR_LOGIN' || step === 'IDLE' || step === 'NEXT_ACCOUNT_LOGIN') {
          await chrome.storage.local.set({
            step: nextStage.step,
            albumIndex: 0,
            songIndex: 0,
            waitRetry: 0
          });
        }

        await saveLog(`🔑 로그인 시도 중 (${currentAccount.id})`, 'INFO');

        // 딜레이 0.3초 증가 (600 -> 900)
        await taskDelay(900);
        if (!await isTaskCurrent(data)) return;
        {
          const loginBtn =
            document.querySelector('input.btn-submit[value="로그인"]') ||
            document.querySelector('input.btn-submit') ||
            document.querySelector('input[type="submit"]') ||
            document.querySelector('button[type="submit"]') ||
            document.querySelector('.btn-login');
          if (loginBtn) {
            loginBtn.click();
          } else {
            callPageFunction('loginID');
          }
        }
        isStepRunning = false;
        return;
      }
    }

    if (window !== window.top) {
      isStepRunning = false;
      return;
    }

    if (step === 'CHECK_OR_LOGIN') {
      if (isUserLoggedIn()) {
        const next = getNextStageUrl('ALBUM_LIKE', data);
        await chrome.storage.local.set({ step: next.step, waitRetry: 0 });
        navigateTask(next.url);
        isStepRunning = false;
        return;
      }

      if (!await claimTaskAction('OPEN_LOGIN', data)) return;
      const genieLoginBtn = document.querySelector('a.btn-login[onclick*="loginPopup"]');
      const openLayerBtn = Array.from(document.querySelectorAll('button.btn, a.btn')).find(el =>
        el.textContent.includes('로그인/회원가입')
      );

      if (genieLoginBtn && genieLoginBtn.offsetParent !== null) {
        genieLoginBtn.click();
      } else if (openLayerBtn) {
        openLayerBtn.click();
        // 딜레이 0.3초 증가 (400 -> 700)
        await taskDelay(700);
        if (!await isTaskCurrent(data)) return;
        {
          const gBtn = document.querySelector('a.btn-login[onclick*="loginPopup"]');
          if (gBtn) gBtn.click();
          else callPageFunction('loginPopup');
        }
      } else {
        const next = getNextStageUrl('ALBUM_LIKE', data);
        navigateTask("https://www.genie.co.kr/member/popLogin?page_rfr=" + encodeURIComponent(next.url));
      }
      isStepRunning = false;
      return;
    }

    // 앨범 좋아요 단계
    if (step === 'ALBUM_LIKE') {
      if (albums && albumIndex < albums.length) {
        if (!currentUrl.includes('/detail/albumInfo') || !currentUrl.includes(albums[albumIndex])) {
          navigateTask(getUrl('album', albums[albumIndex]));
          isStepRunning = false;
          return;
        }
        if (!await claimTaskAction('ALBUM_LIKE', data)) return;
        await performLikeWithCheck(async (ok, msg) => {
          if (!await isTaskCurrent(data)) return;
          await updateStepResult(currentAccount.id, 'album', ok ? 'o' : 'x');
          const nextIdx = albumIndex + 1;
          await saveLog(`💿 앨범(${albums[albumIndex]}) ${msg}`, ok ? 'SUCCESS' : 'ERROR');
          if (nextIdx < albums.length) {
            await chrome.storage.local.set({ albumIndex: nextIdx });
            navigateTask(getUrl('album', albums[nextIdx]));
          } else {
            const next = getNextStageUrl('SONG_LIKE', data);
            await chrome.storage.local.set({ albumIndex: nextIdx, step: next.step });
            navigateTask(next.url);
          }
          isStepRunning = false;
        });
        return;
      } else {
        const next = getNextStageUrl('SONG_LIKE', data);
        await chrome.storage.local.set({ step: next.step });
        navigateTask(next.url);
        isStepRunning = false;
        return;
      }
    }

    // 곡 좋아요 및 다운로드 단계
    if (step === 'SONG_LIKE') {
      if (songs && songIndex < songs.length) {
        const currentSongSid = songs[songIndex];
        if (!currentUrl.includes('/detail/songInfo') || !currentUrl.includes(currentSongSid)) {
          navigateTask(getUrl('song', currentSongSid));
          isStepRunning = false;
          return;
        }

        if (!await claimTaskAction('SONG_LIKE', data)) return;
        await performLikeWithCheck(async (ok, msg) => {
          if (!await isTaskCurrent(data)) return;
          await updateStepResult(currentAccount.id, 'song', ok ? 'o' : 'x');
          await saveLog(`🎵 음원(${currentSongSid}) ${msg}`, ok ? 'SUCCESS' : 'ERROR');
          await chrome.storage.local.set({ step: 'SONG_DOWNLOAD', waitRetry: 0, downloadWaitStartedAt: Date.now() });

          const downBtn = document.querySelector(
            'a.btn-down, a[onclick*="fnBuySong"], a[onclick*="fnDownSong"], .song-main-infos a[title*="다운로드"]'
          );
          if (downBtn) {
            await saveLog(`📥 음원(${currentSongSid}) 다운로드 버튼 클릭 -> 결제 팝업창 호출`, 'INFO');
            downBtn.click();
          } else {
            await saveLog(`📥 음원(${currentSongSid}) fnDownSong 함수 직접 호출`, 'INFO');
            callPageFunction('fnDownSong', [currentSongSid]);
          }
          isStepRunning = false;
        });
        return;
      } else {
        const next = getNextStageUrl('NEXT_ACCOUNT_LOGIN', data);
        await chrome.storage.local.set({ step: next.step });
        navigateTask(next.url);
        isStepRunning = false;
        return;
      }
    }

    if (['SONG_DOWNLOAD', 'PAY_POPUP_STEP1', 'WAIT_DOWNLOAD_STREAM'].includes(step)) {
      if (window !== window.top) return;
      const retry = (data.waitRetry || 0) + 1;
      if (retry > 25) {
        await saveLog(`❌ 결제/다운로드 대기 시간 초과 -> 다음 계정 스킵`, 'ERROR');
        chrome.runtime.sendMessage({ action: 'FORCE_ROLLOVER', reason: '결제/다운로드 타임아웃',
          expected: { runId: data.runId, currentIndex: data.currentIndex || 0, songIndex: data.songIndex || 0 } });
      } else {
        await chrome.storage.local.set({ waitRetry: retry });
      }
      isStepRunning = false;
      return;
    }

    if (step === 'NEXT_ACCOUNT_LOGIN') {
      const firstStage = getNextStageUrl('ALBUM_LIKE', data);
      await chrome.storage.local.set({
        step: firstStage.step,
        albumIndex: 0,
        songIndex: 0,
        waitRetry: 0
      });
      navigateTask("https://www.genie.co.kr/member/popLogin?page_rfr=" + encodeURIComponent(firstStage.url));
      isStepRunning = false;
      return;
    }
  } catch (err) {
    await saveLog(`❌ 오류 발생: ${err.message}`, 'ERROR');
  } finally {
    isStepRunning = false;
  }
}

createFloatingPanel();
setInterval(processTask, 1000);