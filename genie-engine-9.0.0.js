// 확장 프로그램 아이콘 클릭 시 지니 탭 활성화 및 리모컨 표시 (원본 기능 유지)
chrome.action.onClicked.addListener(async () => {
  const genieTabs = await chrome.tabs.query({ url: "*://*.genie.co.kr/*" });
  if (genieTabs.length > 0) {
    await chrome.tabs.update(genieTabs[0].id, { active: true });
    chrome.tabs.sendMessage(genieTabs[0].id, { action: "SHOW_REMOTE" }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: "https://www.genie.co.kr/" });
  }
});

// 실시간 및 파일 저장용 로그 기록 헬퍼
async function appendLog(type, text) {
  const data = await chrome.storage.local.get({ logs: [], accounts: [], currentIndex: 0 });
  const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const accId = data.accounts[data.currentIndex]?.id || 'System';
  const entry = `[${now}] [${type}] (${accId}) ${text}`;
  const updatedLogs = [...(data.logs || []), entry];

  await chrome.storage.local.set({
    logs: updatedLogs,
    lastActionText: `${text} (${now})`
  });
}

// content.js와 메시지 통신
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'CLAIM_TASK_ACTION') {
    claimTaskAction(msg.taskAction, msg.expected).then(
      granted => sendResponse({ granted }),
      () => sendResponse({ granted: false })
    );
    return true;
  }
  if (msg.action === 'GET_SHEET_SEEDS') {
    getSheetSeeds().then(
      seeds => sendResponse({ ok: true, seeds }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
  if (msg.action === 'REGISTER_MAIN_TAB') {
    if (sender.tab && sender.tab.id) {
      chrome.storage.local.set({ mainTabId: sender.tab.id });
    }
  } else if (msg.action === 'FORCE_ROLLOVER') {
    handleAccountRollover(msg.reason || '시간 초과/오류 스킵', true, msg.expected).then(() => sendResponse({status: 'ok'}), error => sendResponse({error: error.message}));
    return true;
  }
  sendResponse({ status: 'ok' });
  return true;
});

// 다운로드 이벤트가 겹쳐도 한 곡의 결과와 계정 전환은 한 번만 처리합니다.
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const data = await withStateLock(async () => {
    const current = await chrome.storage.local.get(['isRunning', 'step', 'songs', 'songIndex', 'accounts', 'currentIndex', 'accountResults', 'runId', 'downloadEventId', 'downloadReceivedAt', 'logs']);
    if (!current.isRunning || (downloadItem.expected && !sameTask(current, downloadItem.expected))) return null;
    const replay = current.step === 'DOWNLOAD_RECEIVED' && current.downloadEventId === downloadItem.id;
    if (!replay && !downloadSteps.includes(current.step)) return null;
    const index = current.songIndex || 0;
    if (index >= (current.songs || []).length) return null;
    if (!replay) {
      const results = current.accountResults || {}, account = current.accounts?.[current.currentIndex];
      if (account) {
        if (!results[account.id]) results[account.id] = {album: '-', song: '-', down: '-'};
        results[account.id].down = 'o';
      }
      const now = new Date().toLocaleTimeString('ko-KR', {hour12: false});
      const text = '음원 다운로드 시작 감지 (' + (index + 1) + '/' + current.songs.length + ') → 팝업 닫기';
      current.downloadReceivedAt = Date.now();
      await chrome.storage.local.set({step: 'DOWNLOAD_RECEIVED', waitRetry: 0,
        downloadEventId: downloadItem.id, downloadReceivedAt: current.downloadReceivedAt,
        accountResults: results, logs: [...(current.logs || []), '[' + now + '] [SUCCESS] (' + (account?.id || 'System') + ') ' + text],
        lastActionText: text + ' (' + now + ')'});
    }
    return current;
  });
  if (!data) return;
  await closePaymentPopups();
  const nextSongIdx = (data.songIndex || 0) + 1, hasNext = nextSongIdx < data.songs.length;
  const delay = hasNext ? 2000 : 4000;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, delay - (Date.now() - data.downloadReceivedAt))));
  if (hasNext) {
    await withStateLock(async () => {
      const current = await chrome.storage.local.get(['isRunning', 'runId', 'currentIndex', 'songIndex', 'step']);
      if (!sameTask(current, data) || current.step !== 'DOWNLOAD_RECEIVED') return;
      await chrome.storage.local.set({songIndex: nextSongIdx, step: 'SONG_LIKE', waitRetry: 0});
      await navigateMainTab('https://www.genie.co.kr/detail/songInfo?xgnm=' + encodeURIComponent(data.songs[nextSongIdx]));
    });
  } else await handleAccountRollover('다운로드 완료', false, data);
});

// 열려있는 결제 팝업창 닫기
async function closePaymentPopups() {
  const state = await chrome.storage.local.get(['mainTabId']);
  const tabs = await chrome.tabs.query({ url: "*://*.genie.co.kr/*" });

  for (const tab of tabs) {
    const isPopup =
      tab.url.includes('/buy/') ||
      tab.url.includes('pop') ||
      tab.url.includes('Popup');
    if (tab.id !== state.mainTabId && isPopup) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {}
    }
  }
}

// 메인 탭 URL 이동
async function navigateMainTab(targetUrl) {
  const state = await chrome.storage.local.get(['mainTabId']);
  const tabs = await chrome.tabs.query({ url: "*://*.genie.co.kr/*" });
  let mainTabId = state.mainTabId;

  if (!mainTabId && tabs.length > 0) {
    mainTabId = tabs[0].id;
  }
  if (mainTabId) {
    await chrome.tabs.update(mainTabId, { url: targetUrl });
  }
}

// 계정 전환 (로그아웃 ?page_rfr= 활용)
async function handleAccountRollover(reason, isError, expected) {
  return withStateLock(() => performAccountRollover(reason, isError, expected));
}

async function performAccountRollover(reason, isError, expected) {
  const data = await chrome.storage.local.get(['isRunning', 'accounts', 'currentIndex', 'accountResults', 'runId', 'songIndex', 'step']);
  if (!expected || !sameTask(data, expected) || data.step === 'ACCOUNT_ROLLOVER') return;
  await closePaymentPopups();

  const accounts = data.accounts || [];
  const currentAccount = accounts[data.currentIndex];

  // 다음 계정으로 넘어갈 때 완료되지 않은('-') 항목을 'x'로 기록
  if (currentAccount) {
    const results = data.accountResults || {};
    if (!results[currentAccount.id]) results[currentAccount.id] = { album: '-', song: '-', down: '-' };
    if (results[currentAccount.id].album === '-') results[currentAccount.id].album = 'x';
    if (results[currentAccount.id].song === '-') results[currentAccount.id].song = 'x';
    if (results[currentAccount.id].down === '-') results[currentAccount.id].down = 'x';
    await chrome.storage.local.set({ accountResults: results });
  }

  const nextIndex = (data.currentIndex || 0) + 1;
  const logoutUrl = "https://www.genie.co.kr/member/logout?page_rfr=" + encodeURIComponent("https://www.genie.co.kr/");

  if (nextIndex >= accounts.length) {
    await appendLog('SUCCESS', `✅ 전체 계정(${accounts.length}개) 작업이 모두 완료되었습니다!`);
    await chrome.storage.local.set({
      currentIndex: nextIndex,
      isRunning: false,
      step: 'IDLE',
      waitRetry: 0
    });
    await navigateMainTab(logoutUrl);
    return;
  }

  await appendLog(
    isError ? 'ERROR' : 'INFO',
    `계정 전환 (${reason}) -> 다음 계정(${nextIndex + 1}/${accounts.length}): ${accounts[nextIndex].id}`
  );

  await chrome.storage.local.set({
    currentIndex: nextIndex,
    step: 'NEXT_ACCOUNT_LOGIN',
    albumIndex: 0,
    songIndex: 0,
    waitRetry: 0
  });

  await navigateMainTab(logoutUrl);
}


// CORS 제한을 피하기 위해 고정된 시트만 백그라운드에서 조회합니다.
async function getSheetSeeds() {
  const url = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQbPI2-Jl21I-hHrIaPTaYIldo3-tJ-4Ml6aTiVZyc8q4az_ETGcOt2iY-E6suHUwbSbsIqXwtq3GGT/pub?output=csv';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal, cache: 'no-store', credentials: 'omit'
    });
    if (!response.ok) throw new Error('게시된 시트 응답 오류 (' + response.status + '). 시트 게시 상태를 확인해주세요.');
    const text = await response.text();
    // CSV 내 따옴표, 쉼표, 셀 내부 줄바꿈을 보존합니다.
    if (/^\s*</.test(text)) throw new Error('웹에 게시된 시트를 읽을 수 없습니다.');
    const rows = parseSheetCsv(text);
    const cell = (row, col) => String(rows[row]?.[col] ?? '').trim();
    const albumName = cell(2, 2), songName = cell(2, 3);
    const albumSid = cell(3, 2), songSid = cell(3, 3);
    if (!albumName || !songName || !/^\d+$/.test(albumSid) || !/^\d+$/.test(songSid)) {
      throw new Error('C3·D3에 이름, C4·D4에 숫자로 된 시드를 입력해주세요.');
    }
    return { albumName, albumSid, songName, songSid };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('시트 응답 시간이 초과되었습니다. 다시 시작해주세요.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}


function parseSheetCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value); value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (quoted) throw new Error('시트 CSV 형식이 올바르지 않습니다.');
  row.push(value); rows.push(row);
  return rows;
}


const downloadSteps = ['SONG_DOWNLOAD', 'PAY_POPUP_STEP1', 'WAIT_DOWNLOAD_STREAM'];
let stateQueue = Promise.resolve();
function withStateLock(operation) {
  const result = stateQueue.then(operation);
  stateQueue = result.catch(() => {});
  return result;
}

function sameTask(current, expected) {
  return current.isRunning && current.runId === expected.runId &&
    (current.currentIndex || 0) === (expected.currentIndex || 0) &&
    (current.songIndex || 0) === (expected.songIndex || 0);
}

// 탭·프레임 사이에서 동일 작업을 한 번만 허용하고 새로고침 후에도 기록을 유지합니다.
async function claimTaskAction(action, expected) {
  const allowedSteps = {
    ALBUM_LIKE: ['ALBUM_LIKE'], SONG_LIKE: ['SONG_LIKE'],
    PAY_SONG: ['SONG_DOWNLOAD'], PAY_FINAL: downloadSteps,
    OPEN_LOGIN: ['CHECK_OR_LOGIN'],
    LOGIN: ['CHECK_OR_LOGIN', 'NEXT_ACCOUNT_LOGIN', 'ALBUM_LIKE', 'SONG_LIKE'],
    LOGIN_FAILURE: ['CHECK_OR_LOGIN', 'NEXT_ACCOUNT_LOGIN', 'ALBUM_LIKE', 'SONG_LIKE']
  };
  if (!expected || !allowedSteps[action]) return false;
  return withStateLock(async () => {
    const current = await chrome.storage.local.get(['isRunning', 'runId', 'currentIndex', 'songIndex', 'albumIndex', 'step', 'actionClaims']);
    if (!sameTask(current, expected) || (current.albumIndex || 0) !== (expected.albumIndex || 0) ||
        !allowedSteps[action].includes(current.step)) return false;
    const key = [current.runId || 'legacy', current.currentIndex || 0, current.albumIndex || 0, current.songIndex || 0, action].join(':');
    const claims = current.actionClaims || {}, previous = claims[key];
    const cooldown = action === 'LOGIN' ? 10000 : action === 'OPEN_LOGIN' ? 7000 : Infinity;
    if (previous !== undefined && Date.now() - previous < cooldown) return false;
    claims[key] = Date.now();
    const updates = { actionClaims: claims };
    if (action === 'PAY_SONG') Object.assign(updates, { step: 'PAY_POPUP_STEP1', waitRetry: 0 });
    if (action === 'PAY_FINAL') Object.assign(updates, { step: 'WAIT_DOWNLOAD_STREAM', waitRetry: 0 });
    await chrome.storage.local.set(updates);
    return true;
  });
}
