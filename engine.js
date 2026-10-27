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
  engineActive=true;chrome.storage.local.set({sheetEngineOwner:engineToken}).then(()=>{if(window.location)pollRemoteControl().catch(()=>{});});
  if(msg.action==='SKIP_ACCOUNT'){withStateLock(()=>skipAccount(msg.expected,sender)).then(sendResponse,error=>sendResponse({ok:false,error:error.message}));return true;}
  if(msg.action?.startsWith('SHEET_')){const operation=msg.action==='SHEET_SYNC'?sheetCommand(msg):withStateLock(()=>sheetCommand(msg));operation.then(value=>sendResponse({ok:true,...value}),error=>sendResponse({ok:false,error:error.message}));return true;}
  if (msg.action?.startsWith('AUTH_')) {
    accountAuthRequest(msg,sender).then(sendResponse,error=>sendResponse({ok:false,error:error.message}));return true;
  }
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
    handleAccountRollover(msg.reason || '시간 초과/오류 스킵', !msg.completed, msg.expected).then(() => sendResponse({status: 'ok'}), error => sendResponse({error: error.message}));
    return true;
  }
  sendResponse({ status: 'ok' });
  return true;
});

// 다운로드 이벤트가 겹쳐도 한 곡의 결과와 계정 전환은 한 번만 처리합니다.
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  engineActive=true;await chrome.storage.local.set({sheetEngineOwner:engineToken});
  const data = await withStateLock(async () => {
    const current = await chrome.storage.local.get(['isRunning', 'step', 'songs', 'songIndex', 'accounts', 'currentIndex', 'accountResults', 'runId', 'verifiedSession', 'skipRequested', 'downloadEventId', 'downloadReceivedAt', 'logs']);
    if (!current.isRunning || skipMatchesAccount(current) || !verifiedFor(current) || (downloadItem.expected && !sameTask(current, downloadItem.expected))) return null;
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
  const data = await chrome.storage.local.get(['isRunning', 'accounts', 'currentIndex', 'accountResults', 'runId', 'songIndex', 'step', 'verifiedSession', 'albums', 'songs', 'mvs', 'artists']);
  if (!expected || !sameTask(data, expected) || data.step === 'ACCOUNT_ROLLOVER') return;
  await closePaymentPopups();
  const latest=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex']);if(!sameTask(latest,data))return;

  const accounts = data.accounts || [];
  const currentAccount = accounts[data.currentIndex];

  // 다음 계정으로 넘어갈 때 완료되지 않은('-') 항목을 'x'로 기록
  if (currentAccount) {
    const results = data.accountResults || {};
    if (!results[currentAccount.id]) results[currentAccount.id] = { album: '-', song: '-', down: '-' };
    for(const metric of ['album','song','down','mv','artist']){const enabled={album:data.albums?.length,song:data.songs?.length,down:data.songs?.length,mv:data.mvs?.length,artist:data.artists?.length}[metric];if(enabled&&!['o','x'].includes(results[currentAccount.id][metric]))results[currentAccount.id][metric]='x';}
    await chrome.storage.local.set({ accountResults: results });
  }

  const nextIndex = (data.currentIndex || 0) + 1;
  const logoutUrl = "https://www.genie.co.kr/auth/signOut?rfr=" + encodeURIComponent("https://www.genie.co.kr/");

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
    step: 'AUTH_LOGOUT',
    authSequence:{runId:data.runId,index:nextIndex,account:accounts[nextIndex].id,phase:'LOGOUT',startedAt:Date.now(),previousMember:data.verifiedSession?.memberNo||'',previousAccount:currentAccount?.id||'',logoutAttempts:1},
    previousSession: data.verifiedSession || null, verifiedSession: null,
    albumIndex: 0,
    songIndex: 0,
    waitRetry: 0
  });

  await navigateMainTab(logoutUrl);
}


// CORS 제한을 피하기 위해 고정된 시트만 백그라운드에서 조회합니다.
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
    MV_LIKE:['MV_LIKE'], ARTIST_LIKE:['ARTIST_LIKE'], ALBUM_LIKE: ['ALBUM_LIKE'], SONG_LIKE: ['SONG_LIKE'],
    PAY_SONG: ['SONG_DOWNLOAD'], PAY_FINAL: downloadSteps,
    OPEN_LOGIN: ['CHECK_OR_LOGIN'],
    LOGIN: ['CHECK_OR_LOGIN', 'NEXT_ACCOUNT_LOGIN', 'ALBUM_LIKE', 'SONG_LIKE'],
    LOGIN_FAILURE: ['CHECK_OR_LOGIN', 'NEXT_ACCOUNT_LOGIN', 'ALBUM_LIKE', 'SONG_LIKE']
  };
  if (!expected || !allowedSteps[action]) return false;
  return withStateLock(async () => {
    const current = await chrome.storage.local.get(['isRunning', 'runId', 'currentIndex', 'songIndex', 'albumIndex', 'step', 'actionClaims', 'accounts', 'verifiedSession', 'skipRequested']);
    if (skipMatchesAccount(current) || !sameTask(current, expected) || (current.albumIndex || 0) !== (expected.albumIndex || 0) ||
        !allowedSteps[action].includes(current.step)) return false;
    if (['MV_LIKE','ARTIST_LIKE','ALBUM_LIKE','SONG_LIKE','PAY_SONG','PAY_FINAL'].includes(action) && (!await assertAccountLease(current)||!await assertVerifiedSession(current))) return false;
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

// 서버가 렌더링한 회원번호와 로그인 여부만 사용합니다. 입력칸/닉네임은 확인 근거로 사용하지 않습니다.
function parseSessionSnapshot(html) {
  const members = [...String(html).matchAll(/\biMemUno\s*=\s*["']([^"']*)["']/g)].map(m => m[1]);
  const flags = [...String(html).matchAll(/\bisLogin\s*=\s*StringUtils\.stringToBoolean\(\s*["'](true|false)["']\.toLowerCase\(\)\s*\)/g)].map(m => m[1]);
  const ids = [...new Set(members)], states = [...new Set(flags)];
  if (ids.length !== 1 || states.length !== 1) throw new Error('서버 로그인 상태를 판독할 수 없습니다');
  if (states[0] === 'false' && ids[0] === '') return {loggedIn:false, memberNo:''};
  if (states[0] === 'true' && /^\d+$/.test(ids[0])) return {loggedIn:true, memberNo:ids[0]};
  throw new Error('서버 로그인 상태와 회원번호가 일치하지 않습니다');
}
async function readServerSession() {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await window.fetch('https://www.genie.co.kr/?genie_session_check=' + Date.now(), {credentials:'include', cache:'no-store', signal:controller.signal});
    if (!response.ok) throw new Error('로그인 확인 응답 오류 (' + response.status + ')');
    return parseSessionSnapshot(await response.text());
  } finally { clearTimeout(timer); }
}
function verifiedFor(data) {
  const v=data.verifiedSession;
  return Boolean(v && v.runId===data.runId && v.index===(data.currentIndex||0) && v.account===data.accounts?.[data.currentIndex||0]?.id && v.memberNo);
}
async function stopAccountAuth(message,expected) {
  if(expected){const now=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex']);if(!sameTask(now,expected))return {ok:false};}
  await chrome.storage.local.set({isRunning:false, verifiedSession:null});
  await appendLog('ERROR', '계정 확인 실패: ' + message + ' → 작업 중단');
  return {ok:false,error:message};
}
async function assertVerifiedSession(data,forceFresh=false) {
  if (!verifiedFor(data)) { await stopAccountAuth('현재 계정의 로그인 확인 기록이 없습니다',data); return false; }
  try {
    const cacheKey=data.runId+':'+(data.currentIndex||0)+':'+data.verifiedSession.memberNo;const cached=!forceFresh&&sessionCheckpoint?.key===cacheKey&&Date.now()-sessionCheckpoint.at<1500;
    const session=cached?sessionCheckpoint.session:await readServerSession();if(!cached)sessionCheckpoint={key:cacheKey,at:Date.now(),session};
    const now=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','step','skipRequested']);
    if(skipMatchesAccount(now)||!sameTask(now,data)||now.step!==data.step)return false;
    if (session.loggedIn && session.memberNo===data.verifiedSession.memberNo) return true;
    await stopAccountAuth('확인한 계정의 로그인 세션이 변경되었거나 로그아웃되었습니다',data);
  } catch(error) { await stopAccountAuth(error.message,data); }
  return false;
}
const authLogoutUrl='https://www.genie.co.kr/auth/signOut?rfr='+encodeURIComponent('https://www.genie.co.kr/');
const authLoginUrl='https://www.genie.co.kr/member/popLogin?page_rfr='+encodeURIComponent('https://www.genie.co.kr/');
async function accountAuthRequest(msg,sender) {
  if(msg.action==='AUTH_OWNER'){const d=await chrome.storage.local.get(['mainTabId']);return {ok:sender.frameId===0&&sender.tab?.id===d.mainTabId};}
  return withStateLock(async()=>{
    const data=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','accounts','albums','songs','mvs','artists','step','mainTabId','verifiedSession','previousSession','authSequence','accountMemberBindings']);
    if (msg.action==='AUTH_OWNER') return {ok:sender.frameId===0 && sender.tab?.id===data.mainTabId};
    if (!msg.expected || !sameTask(data,msg.expected)) return {ok:false};
    if (msg.action==='AUTH_ASSERT') return {ok:await assertVerifiedSession(data)};
    if (msg.action==='AUTH_FINAL_GUARD') return {ok:await assertAccountLease(data,true)&&await assertVerifiedSession(data,true)};
    if (sender.frameId!==0 || sender.tab?.id!==data.mainTabId) return {ok:false};
    const probe=async()=>{const session=await readServerSession();const now=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','step','skipRequested']);if(skipMatchesAccount(now)||!sameTask(now,data)||now.step!==data.step){const error=new Error('stale auth');error.stale=true;throw error;}return session;};
    const account=data.accounts?.[data.currentIndex||0]; if(!account)return stopAccountAuth('대상 계정이 없습니다',data);
    try {
      if(msg.action==='AUTH_BEGIN') {
        if(!['CHECK_OR_LOGIN','NEXT_ACCOUNT_LOGIN','IDLE'].includes(data.step))return {ok:false};
        const context=(await chrome.storage.local.get(['sheetContext'])).sheetContext;if(context)await sheetApi('heartbeat',context);
        const session=await probe();
        const previous=data.verifiedSession||data.previousSession;
        const sequence={runId:data.runId,index:data.currentIndex||0,account:account.id,phase:'LOGOUT',startedAt:Date.now(),previousMember:session.memberNo||previous?.memberNo||'',previousAccount:previous?.account||'',logoutAttempts:1};
        await chrome.storage.local.set({authSequence:sequence,verifiedSession:null,step:'AUTH_LOGOUT',albumIndex:0,songIndex:0,waitRetry:0});
        await appendLog('INFO','이전 로그인 세션 로그아웃 요청 → 서버 상태 확인 대기');
        return {ok:true,url:authLogoutUrl};
      }
      const seq=data.authSequence;
      if(!seq || seq.runId!==data.runId || seq.index!==(data.currentIndex||0) || seq.account!==account.id)return stopAccountAuth('로그인 순서 정보가 일치하지 않습니다',data);
      if(msg.action==='AUTH_FAIL')return stopAccountAuth('지니 로그인 화면에서 오류가 확인되었습니다',data);
      if(msg.action==='AUTH_LOGOUT_CHECK' && data.step==='AUTH_LOGOUT' && seq.phase==='LOGOUT') {
        const session=await probe();
        if(session.loggedIn) {
          if(Date.now()-seq.startedAt>30000)return stopAccountAuth('이전 계정의 로그아웃이 확인되지 않았습니다',data);
          if(Date.now()-seq.startedAt>5000 && seq.logoutAttempts<2){await chrome.storage.local.set({authSequence:{...seq,logoutAttempts:2}});return {ok:true,url:authLogoutUrl};}
          return {ok:true,waiting:true};
        }
        await prepareAccount(data);
        const still=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','step','skipRequested']);if(!sameTask(still,data)||skipMatchesAccount(still)||still.step!==data.step)return {ok:false};
        await chrome.storage.local.set({step:'AUTH_FORM',authSequence:{...seq,phase:'FORM',logoutConfirmedAt:Date.now()}});
        await appendLog('SUCCESS','서버 로그아웃 확인 완료 → 대상 계정 로그인 준비');
        return {ok:true,url:authLoginUrl};
      }
      if(msg.action==='AUTH_SUBMIT' && data.step==='AUTH_FORM' && seq.phase==='FORM') {
        if(Date.now()-seq.logoutConfirmedAt>60000)return stopAccountAuth('로그인 준비 시간이 초과되었습니다',data);
        if((await probe()).loggedIn)return stopAccountAuth('대상 계정 로그인 전에 다른 로그인 세션이 나타났습니다',data);
        await chrome.storage.local.set({step:'AUTH_WAIT',authSequence:{...seq,phase:'WAIT',submittedAt:Date.now()}});
        await appendLog('INFO','로그아웃 확인 후 대상 계정 로그인 1회 제출');
        return {ok:true};
      }
      if(msg.action==='AUTH_LOGIN_CHECK' && data.step==='AUTH_WAIT' && seq.phase==='WAIT') {
        const session=await probe();
        if(!session.loggedIn){if(Date.now()-seq.submittedAt>30000)return stopAccountAuth('대상 계정 로그인 성공이 확인되지 않았습니다',data);return {ok:true,waiting:true};}
        if(seq.previousAccount && seq.previousAccount!==account.id && seq.previousMember===session.memberNo)return stopAccountAuth('이전 계정과 동일한 회원 세션이 다시 확인되었습니다',data);
        const bindings=data.accountMemberBindings||{};
        if(bindings[account.id] && bindings[account.id]!==session.memberNo)return stopAccountAuth('대상 계정에 이전에 확인된 회원번호와 다릅니다',data);
        if(Object.entries(bindings).some(([id,member])=>id!==account.id && member===session.memberNo))return stopAccountAuth('다른 계정에 확인된 회원번호와 중복됩니다',data);
        bindings[account.id]=session.memberNo;
        const stage=data.mvs?.length?'mv':data.artists?.length?'artist':data.albums?.length?'album':'song';const step={mv:'MV_LIKE',artist:'ARTIST_LIKE',album:'ALBUM_LIKE',song:'SONG_LIKE'}[stage];
        const url='https://www.genie.co.kr/detail/'+({mv:'mediaInfo?xvnm=',artist:'artistInfo?xxnm=',album:'albumInfo?axnm=',song:'songInfo?xgnm='}[stage])+encodeURIComponent(({mv:data.mvs,artist:data.artists,album:data.albums,song:data.songs}[stage])[0]);
        await chrome.storage.local.set({verifiedSession:{runId:data.runId,index:data.currentIndex||0,account:account.id,memberNo:session.memberNo},accountMemberBindings:bindings,step,albumIndex:0,songIndex:0,waitRetry:0,authSequence:{...seq,phase:'VERIFIED'}});
        await appendLog('SUCCESS','대상 계정 로그인 흐름 및 서버 회원 세션 확인 완료 → 작업 진행');
        return {ok:true,url};
      }
      return {ok:false};
    } catch(error) { if(error.stale)return {ok:false};return stopAccountAuth(error.name==='AbortError'?'서버 로그인 확인 시간 초과':error.message,data); }
  });
}

function accountSheetRef(value){let u;try{u=new URL(String(value).trim());}catch{throw Error('계정 시트 주소를 입력하세요.');}const id=u.pathname.match(/^\/spreadsheets\/d\/([\w-]+)\//)?.[1];const gid=u.searchParams.get('gid')||new URLSearchParams(u.hash.slice(1)).get('gid');if(u.hostname!=='docs.google.com'||!id||!/^\d+$/.test(gid||''))throw Error('탭의 gid가 포함된 Google 시트 주소를 입력하세요.');return {spreadsheetId:id,gid:Number(gid)};}
async function sheetApiLegacy(action,extra={}){const d=await chrome.storage.local.get(['sheetConfig']);const c=d.sheetConfig;if(!c?.endpoint)throw Error('연결 설정에서 웹 앱 주소를 저장하세요.');if(!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(c.endpoint))throw Error('Apps Script /exec 주소를 입력하세요.');const r=await fetch(c.endpoint,{method:'POST',body:JSON.stringify({action,...extra})});if(!r.ok)throw Error('시트 서버 응답 오류 ('+r.status+')');let result;try{result=await r.json();}catch{throw Error('웹 앱 응답을 확인하세요. 접근 권한은 모든 사용자, 실행 사용자는 나로 배포해야 합니다.');}if(!result.ok)throw Error(result.error||'시트 요청 실패');return result;}
async function getSheetSeeds(){const result=await sheetApi('seeds');const s=result.seeds;return {albumName:s.album.name,albumSid:s.album.sid,songName:s.song.name,songSid:s.song.sid,mvName:s.mv.name,mvSid:s.mv.sid,artistName:s.artist.name,artistSid:s.artist.sid};}
async function sheetCommandLegacy(msg){const d=await chrome.storage.local.get(['isRunning','currentIndex','accounts','accountResults','sheetContext','sheetSynced','sheetConfig','albums','songs','mvs','artists']);if(msg.action==='SHEET_SYNC')return sheetTick();if(['SHEET_IMPORT','SHEET_START','SHEET_PREPARE_CHANGE'].includes(msg.action)){if(sheetTickBusy)throw Error('시트 기록 처리 중입니다. 잠시 후 다시 시도하세요.');const sync=await sheetTick(true);const pending=(await chrome.storage.local.get(['sheetPending'])).sheetPending;if(!sync.ok||pending)throw Error('이전 결과의 시트 기록을 먼저 완료하세요.');if(msg.action==='SHEET_PREPARE_CHANGE')return {ok:true};}if(['SHEET_CATALOG','SHEET_IMPORT','SHEET_START'].includes(msg.action)&&d.isRunning)throw Error('작업을 중단한 뒤 변경하세요.');if(msg.action==='SHEET_CATALOG'){const source=accountSheetRef(msg.url),result=await sheetApi('catalog',source);await chrome.storage.local.set({sheetCatalog:{...result,...source,url:msg.url},sheetSelection:null});return result;}if(msg.action==='SHEET_IMPORT'){const source=accountSheetRef(msg.url),result=await sheetApi('accounts',{...source,helper:msg.helper,time:msg.time});if(!result.accounts.length)throw Error('선택 범위에 J열 비밀번호가 있는 계정이 없습니다.');if(result.accounts.some(r=>typeof r.password!=='string'||!r.password.length))throw Error('Apps Script의 새 Code.gs를 저장하고 새 버전으로 배포하세요.');const accounts=result.accounts.map(r=>({id:r.id,pw:r.password,row:r.row}));await chrome.storage.local.set({accounts,accountResults:{},currentIndex:0,albumIndex:0,songIndex:0,step:'CHECK_OR_LOGIN',sheetSynced:{},sheetContext:null,sheetSelection:{...source,helper:msg.helper,time:msg.time,credentialMode:'row-password'},sheetSyncError:'',sheetExcluded:result.excluded});return result;}if(msg.action==='SHEET_START'){if(![d.albums,d.songs,d.mvs,d.artists].some(x=>x?.length))throw Error('시드 시트에 작업 대상을 하나 이상 입력하세요.');const selection=(await chrome.storage.local.get(['sheetSelection'])).sheetSelection;if(!selection||!d.accounts?.length)throw Error('계정을 먼저 불러오세요.');if(selection.credentialMode!=='row-password')throw Error('J열 비밀번호 방식으로 계정을 다시 불러오세요.');const fresh=await sheetApi('accounts',selection);const accounts=d.accounts.map(a=>{const latest=fresh.accounts.find(r=>r.id===a.id);if(!latest)throw Error('계정 배정 또는 J열이 변경되었습니다. 다시 불러오세요.');if(typeof latest.password!=='string'||!latest.password.length)throw Error('J열 비밀번호가 비어 있습니다.');return {...a,pw:latest.password,row:latest.row};});const runId=crypto.randomUUID(),context={...selection,jobId:runId,accounts:accounts.map(a=>a.id)};await sheetApi('claim',context);await chrome.storage.local.set({accounts,sheetContext:context,sheetSynced:{},accountResults:{},sheetSyncError:'',isRunning:true,runId,actionClaims:{},verifiedSession:null,authSequence:null,step:'CHECK_OR_LOGIN',currentIndex:(d.currentIndex||0)<accounts.length?(d.currentIndex||0):0,skipRequested:null,albumIndex:0,songIndex:0,waitRetry:0});return {runId};}throw Error('지원하지 않는 시트 요청');}
let sheetTickBusy=false;
async function sheetTickLegacy(){if(sheetTickBusy)return {ok:true};sheetTickBusy=true;try{const d=await chrome.storage.local.get(['sheetContext','accountResults','sheetSynced','isRunning','albums','songs','mvs','artists']);if(!d.sheetContext)return {ok:true};const enabled={album:d.albums?.length,song:d.songs?.length,down:d.songs?.length,mv:d.mvs?.length,artist:d.artists?.length};const synced=d.sheetSynced||{},changes=[];for(const id of d.sheetContext.accounts)for(const metric of ['down','song','mv','album','artist']){const value=d.accountResults?.[id]?.[metric],key=id+':'+metric;if(enabled[metric]&&['o','x'].includes(value)&&synced[key]!==value)changes.push({id,metric,value});}if(d.isRunning)await sheetApi('heartbeat',d.sheetContext);if(changes.length){const batch=changes.slice(0,100);await sheetApi('write',{...d.sheetContext,changes:batch});for(const c of batch)synced[c.id+':'+c.metric]=c.value;await chrome.storage.local.set({sheetSynced:synced,sheetSyncError:'',sheetPending:Math.max(0,changes.length-100)});}else{await chrome.storage.local.set({sheetSyncError:'',sheetPending:0});if(!d.isRunning)await sheetApi('release',d.sheetContext);}return {ok:true};}catch(error){await chrome.storage.local.set({sheetSyncError:error.message});return {ok:false,error:error.message};}finally{sheetTickBusy=false;}}
setInterval(()=>{if(engineActive)sheetTick();},15000);

function skipMatchesAccount(data){const request=data.skipRequested;return Boolean(request&&request.runId===data.runId&&(request.currentIndex||0)===(data.currentIndex||0));}
async function skipAccount(expected,sender){
 const data=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','accounts','mainTabId','accountResults','albums','songs','mvs','artists']);
 if(!expected||data.runId!==expected.runId||(data.currentIndex||0)!==(expected.currentIndex||0))return {ok:false,error:'현재 계정이 바뀌었습니다. 확인 후 다시 시도하세요.'};
 if(sender.frameId!==0||(data.isRunning&&sender.tab?.id!==data.mainTabId))return {ok:false,error:'메인 리모컨에서 넘겨주세요.'};
 const account=data.accounts?.[data.currentIndex||0];if(!account)return {ok:false,error:'넘길 계정이 없습니다.'};
 if(data.isRunning){await chrome.storage.local.set({step:'SKIP_ACCOUNT_PENDING'});await performAccountRollover('사용자 ▷ 넘기기',true,data);}
 else{const results=data.accountResults||{};results[account.id]||={};for(const metric of ['album','song','down','mv','artist']){const enabled={album:data.albums?.length,song:data.songs?.length,down:data.songs?.length,mv:data.mvs?.length,artist:data.artists?.length}[metric];if(enabled&&!['o','x'].includes(results[account.id][metric]))results[account.id][metric]='x';}await chrome.storage.local.set({accountResults:results,currentIndex:(data.currentIndex||0)+1,albumIndex:0,songIndex:0,step:'CHECK_OR_LOGIN',verifiedSession:null,authSequence:null});await appendLog('INFO','▷ '+account.id+' 계정 넘기기 · 다음 시작 위치 저장');}
 return {ok:true};
}

async function assertAccountLeaseLegacy(data){const context=(await chrome.storage.local.get(['sheetContext'])).sheetContext;if(!context)return true;try{await sheetApi('heartbeat',{...context,accounts:[data.accounts?.[data.currentIndex||0]?.id]});return true;}catch(error){await stopAccountAuth('계정 사용 잠금 확인 실패: '+error.message,data);return false;}}

const engineToken=Date.now()+':'+Math.random();
let engineActive=false,remotePollBusy=false,remoteReloadBusy=false;
async function ensureClientId(){const d=await chrome.storage.local.get(['sheetClientId']);if(d.sheetClientId)return d.sheetClientId;const id=crypto.randomUUID();await chrome.storage.local.set({sheetClientId:id});return id;}
async function sheetApi(action,extra={}){
 const d=await chrome.storage.local.get(['sheetConfig','sheetSelection','accounts','currentIndex','isRunning','remoteControl','sheetReleasedJobId','remoteReloadCompleted','remoteReloadError']);const c=d.sheetConfig;
 if(!c?.endpoint)throw Error('연결 설정에서 웹 앱 주소를 저장하세요.');if(!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(c.endpoint))throw Error('Apps Script /exec 주소를 입력하세요.');
 if(action==='release'&&extra.jobId===d.sheetReleasedJobId)return {ok:true,cached:true};
 const clientId=await ensureClientId(),helper=extra.helper||d.sheetSelection?.helper||'';
 const start=Date.now();const r=await fetch(c.endpoint,{method:'POST',body:JSON.stringify({action,clientId,helper,isRunning:!!d.isRunning,accountId:d.accounts?.[d.currentIndex||0]?.id||'',ackVersion:d.remoteControl?.ackVersion||'',status:!d.isRunning&&d.remoteControl?.stop&&d.remoteControl.ackVersion===d.remoteControl.version?(d.remoteReloadCompleted===d.remoteControl.version?'계정 다시 불러오기 완료':d.remoteReloadError?'계정 다시 불러오기 실패':'중단 확인'):(d.isRunning?'진행 중':'대기'),...extra})});
 if(!r.ok)throw Error('시트 서버 응답 오류 ('+r.status+')');let result;try{result=await r.json();}catch{throw Error('Apps Script 웹 앱 주소와 새 버전 배포를 확인하세요.');}
 result.elapsedMs=Date.now()-start;const t=(await chrome.storage.local.get(['sheetTimings'])).sheetTimings||{};t[action]=result.elapsedMs;await chrome.storage.local.set({sheetTimings:t});
 if(result.control)await applyRemoteControl(result.control,helper,action!=='controlAck');
 if(!result.ok)throw Error(result.error||'시트 요청 실패');
 if(action==='release')await chrome.storage.local.set({sheetReleasedJobId:extra.jobId});return result;
}
async function applyRemoteControl(control,helper,sendAck=true){
 const d=await chrome.storage.local.get(['sheetSelection','isRunning','remoteControl','remoteReloadCompleted']);if(d.sheetSelection?.helper!==helper)return;
 const old=d.remoteControl;const state={...control,helper,checkedAt:Date.now(),ackVersion:old?.ackVersion||''};
 if(control.stop){await chrome.storage.local.set({isRunning:false,remoteControl:state,...(control.reload&&d.remoteReloadCompleted!==control.version?{remoteReloadRequired:true}:{})});if(old?.version!==control.version||d.isRunning)await appendLog('INFO','■ 관리자 원격 중단 확인 ('+helper+')');if(sendAck&&old?.ackVersion!==control.version){await chrome.storage.local.set({remoteControl:{...state,ackVersion:control.version}});await sheetApi('controlAck',{helper,isRunning:false,status:'중단 확인',ackVersion:control.version});}}
 else await chrome.storage.local.set({remoteControl:state});
}
async function pollRemoteControl(force=false){
 if(remotePollBusy)return;const owner=(await chrome.storage.local.get(['sheetEngineOwner'])).sheetEngineOwner;if(owner!==engineToken)return;remotePollBusy=true;
 try{const d=await chrome.storage.local.get(['sheetConfig','sheetSelection','remoteControl','remoteReloadRequired']);if(!d.sheetConfig?.endpoint||!d.sheetSelection?.helper)return;if(!force&&d.remoteControl?.helper===d.sheetSelection.helper&&Date.now()-d.remoteControl.checkedAt<5000)return;
 const result=await sheetApi('control',{helper:d.sheetSelection.helper});await chrome.storage.local.set({remoteControlError:''});
 if(result.control.reload&&(await chrome.storage.local.get(['sheetEngineOwner'])).sheetEngineOwner===engineToken){const now=await chrome.storage.local.get(['remoteReloadCompleted']);if(now.remoteReloadCompleted!==result.control.version&&!remoteReloadBusy){const attempt=(await chrome.storage.local.get(['remoteReloadAttempt'])).remoteReloadAttempt;if(attempt?.version===result.control.version&&Date.now()-attempt.at<30000)return;await chrome.storage.local.set({remoteReloadAttempt:{version:result.control.version,at:Date.now()}});remoteReloadBusy=true;try{await withStateLock(()=>reloadSelectedAccounts(result.control.version));}catch(error){await chrome.storage.local.set({remoteReloadRequired:true,remoteReloadError:error.message});if((await chrome.storage.local.get(['sheetEngineOwner'])).sheetEngineOwner===engineToken)await sheetApi('controlAck',{helper:d.sheetSelection.helper,isRunning:false,status:'계정 다시 불러오기 실패',ackVersion:result.control.version,note:error.message});throw error;}finally{remoteReloadBusy=false;}}}
 }catch(error){const d=await chrome.storage.local.get(['isRunning']);if(d.isRunning){await chrome.storage.local.set({isRunning:false});await appendLog('ERROR','원격 제어 확인 실패 → 중단: '+error.message);}await chrome.storage.local.set({remoteControlError:error.message});}finally{remotePollBusy=false;}
}
async function checkRemoteStart(helper){const result=await sheetApi('control',{helper});const d=await chrome.storage.local.get(['remoteReloadRequired']);if(result.control.stop)throw Error('관리자가 중단한 상태입니다. 실행 허용 후 시작하세요.');if(d.remoteReloadRequired)throw Error('중단 후 남은 계정을 다시 불러오세요.');}
function seedValues(s){return {albums:s.album.sid?[s.album.sid]:[],songs:s.song.sid?[s.song.sid]:[],mvs:s.mv.sid?[s.mv.sid]:[],artists:s.artist.sid?[s.artist.sid]:[],sheetAlbumName:s.album.name,sheetSongName:s.song.name,sheetMvName:s.mv.name,sheetArtistName:s.artist.name,sheetSeedsFetchedAt:Date.now()};}
async function sheetCommand(msg){
 if(msg.action==='SHEET_SYNC'){const result=await sheetTick(msg.force!==false);if(msg.force!==false)await withStateLock(()=>retryBacklog());return result;}
 if(msg.action==='SHEET_RELOAD')return reloadSelectedAccounts();
 if(msg.action!=='SHEET_START'){if(['SHEET_IMPORT','SHEET_PREPARE_CHANGE'].includes(msg.action)){const previous=await chrome.storage.local.get(['isRunning','sheetContext']);if(previous.isRunning)throw Error('먼저 작업을 중단하세요.');const sync=await sheetTick(true);if(!sync.ok)throw Error('이전 결과 기록을 완료하거나 중단 후 다시 불러오기를 사용하세요.');if(previous.sheetContext)await sheetApi('release',previous.sheetContext);}const result=await sheetCommandLegacy(msg);if(msg.action==='SHEET_IMPORT')await chrome.storage.local.set({remoteReloadRequired:false});return result;}
 if(sheetTickBusy)throw Error('결과 기록 중입니다. 잠시 후 시작하세요.');const sync=await sheetTick(true);const d=await chrome.storage.local.get(['isRunning','sheetSelection','accounts','currentIndex','sheetPending','verifiedSession','previousSession','remoteReloadRequired']);
 if(d.isRunning)throw Error('이미 실행 중입니다.');if(!sync.ok||d.sheetPending)throw Error('이전 결과의 기록을 먼저 완료하세요.');const selection=d.sheetSelection;if(selection?.credentialMode!=='row-password'||!d.accounts?.length)throw Error('계정을 먼저 다시 불러오세요.');
 if(d.remoteReloadRequired)throw Error('중단 후 남은 계정을 다시 불러오세요.');
 const runId=crypto.randomUUID(),context={...selection,jobId:runId,accounts:d.accounts.map(a=>a.id)};
 const result=await sheetApi('start',context);if(!result.seeds||!result.accounts)throw Error('Apps Script 새 버전 배포를 확인하세요.');
 const seeds=seedValues(result.seeds);if(![seeds.albums,seeds.songs,seeds.mvs,seeds.artists].some(x=>x.length)){await sheetApi('release',context);throw Error('시드를 하나 이상 입력하세요.');}
 const accounts=d.accounts.map(a=>{const fresh=result.accounts.find(r=>r.id===a.id);if(!fresh?.password)throw Error('계정 또는 J열 비밀번호가 변경되었습니다. 다시 불러오세요.');return {...a,pw:fresh.password,row:fresh.row};});
 const index=(d.currentIndex||0)<accounts.length?(d.currentIndex||0):0,previous=d.verifiedSession||d.previousSession;
 await chrome.storage.local.set({...seeds,accounts,sheetContext:context,sheetSynced:{},accountResults:{},sheetSyncError:'',isRunning:true,runId,actionClaims:{},verifiedSession:null,step:'AUTH_LOGOUT',currentIndex:index,skipRequested:null,albumIndex:0,songIndex:0,waitRetry:0,accountPrepared:{runId,index,at:Date.now()},authSequence:{runId,index,account:accounts[index].id,phase:'LOGOUT',startedAt:Date.now(),previousMember:previous?.memberNo||'',previousAccount:previous?.account||'',logoutAttempts:1}});
 await appendLog('INFO','시작 준비 완료 · 시트 응답 '+result.elapsedMs+'ms → 로그아웃으로 바로 이동');return {ok:true,runId,url:authLogoutUrl};
}
function unsentChanges(d){const enabled={album:d.albums?.length,song:d.songs?.length,down:d.songs?.length,mv:d.mvs?.length,artist:d.artists?.length};const out=[];for(const id of d.sheetContext?.accounts||[])for(const metric of ['down','song','mv','album','artist']){const value=d.accountResults?.[id]?.[metric];if(enabled[metric]&&['o','x'].includes(value)&&d.sheetSynced?.[id+':'+metric]!==value)out.push({id,metric,value});}return out;}
async function reloadSelectedAccounts(commandVersion){
 const waitStart=Date.now();while(sheetTickBusy){if(Date.now()-waitStart>30000)throw Error('결과 기록이 아직 진행 중입니다. 잠시 후 다시 불러오세요.');await new Promise(resolve=>setTimeout(resolve,100));}
 const d=await chrome.storage.local.get(['isRunning','sheetSelection','sheetContext','accounts','currentIndex','accountResults','sheetSynced','albums','songs','mvs','artists','sheetBacklog','remoteControl']);if(d.isRunning)throw Error('중단 확인 후 다시 불러오세요.');if(!d.sheetSelection)throw Error('계정을 먼저 선택하세요.');
 await sheetTick(true);const now=await chrome.storage.local.get(['isRunning','sheetSynced']);if(now.isRunning)throw Error('작업이 다시 시작되어 불러오기를 중단했습니다.');
 const pending=unsentChanges({...d,sheetSynced:now.sheetSynced}),backlog=d.sheetBacklog||[];if(pending.length&&!backlog.some(x=>x.context?.jobId===d.sheetContext?.jobId&&JSON.stringify(x.changes)===JSON.stringify(pending)))backlog.push({id:crypto.randomUUID(),context:d.sheetContext,changes:pending,at:Date.now()});
 await chrome.storage.local.set({sheetBacklog:backlog});
 if(d.sheetContext)await sheetApi('release',d.sheetContext);
 const fresh=await sheetApi('accounts',d.sheetSelection);const completed=new Set((d.accounts||[]).slice(0,d.currentIndex||0).map(a=>a.id));const accounts=fresh.accounts.filter(r=>!completed.has(r.id)).map(r=>({id:r.id,pw:r.password,row:r.row}));
 const latest=await chrome.storage.local.get(['isRunning','sheetSelection','sheetEngineOwner','remoteControl']);if(latest.isRunning||(commandVersion&&(latest.sheetEngineOwner!==engineToken||latest.remoteControl?.version!==commandVersion))||JSON.stringify(latest.sheetSelection)!==JSON.stringify(d.sheetSelection))throw Error('선택이 변경되어 다시 불러오기를 중단했습니다.');
 await chrome.storage.local.set({accounts,accountResults:{},sheetSynced:{},sheetContext:null,currentIndex:0,albumIndex:0,songIndex:0,step:'CHECK_OR_LOGIN',verifiedSession:null,authSequence:null,remoteReloadRequired:false,remoteReloadError:'',remoteReloadCompleted:commandVersion||d.remoteControl?.version||'',sheetBacklog:backlog,sheetSyncError:'',sheetPending:0});
 await appendLog('INFO','중단 확인 후 남은 계정 '+accounts.length+'개 다시 불러오기 완료'+(pending.length?' · 미기록 결과 '+pending.length+'건 별도 보관':''));
 if(commandVersion)await sheetApi('controlAck',{helper:d.sheetSelection.helper,isRunning:false,status:'계정 다시 불러오기 완료',ackVersion:commandVersion,note:'남은 계정 '+accounts.length+'개'});
 return {ok:true,count:accounts.length};
}
let backlogBusy=false;
async function retryBacklog(){if(backlogBusy)return;backlogBusy=true;try{const d=await chrome.storage.local.get(['sheetBacklog']);const list=d.sheetBacklog||[];if(!list.length)return;const entry=list[0];try{const batch=entry.changes.slice(0,100);await sheetApi('write',{...entry.context,changes:batch});const current=(await chrome.storage.local.get(['sheetBacklog'])).sheetBacklog||[];const live=current.find(x=>x.id===entry.id);if(live)live.changes.splice(0,batch.length);await chrome.storage.local.set({sheetBacklog:current.filter(x=>x.changes.length),sheetBacklogError:''});}catch(error){await chrome.storage.local.set({sheetBacklogError:error.message});}}finally{backlogBusy=false;}}
async function sheetTick(force=false){
 const d=await chrome.storage.local.get(['sheetLastSyncAt','sheetEngineOwner']);if(!force&&d.sheetEngineOwner!==engineToken)return {ok:true,cached:true};if(!force&&Date.now()-(d.sheetLastSyncAt||0)<15000)return {ok:true,cached:true};await chrome.storage.local.set({sheetLastSyncAt:Date.now()});return sheetTickLegacy();
}
async function prepareAccount(data){const context=(await chrome.storage.local.get(['sheetContext'])).sheetContext;if(!context)return;const ready=(await chrome.storage.local.get(['accountPrepared'])).accountPrepared;if(ready?.runId===data.runId&&ready.index===(data.currentIndex||0)&&Date.now()-ready.at<30000)return;
 const id=data.accounts?.[data.currentIndex||0]?.id,result=await sheetApi('prepare',{...context,accounts:[id]});const fresh=result.accounts?.find(a=>a.id===id);if(!fresh?.password)throw Error('대상 계정의 J열 비밀번호를 확인하세요.');const current=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','step','accounts','skipRequested']);if(!sameTask(current,data)||skipMatchesAccount(current)||current.step!==data.step)throw Error('로그인 순서가 변경되었습니다.');const accounts=current.accounts;accounts[data.currentIndex||0]={...accounts[data.currentIndex||0],pw:fresh.password};await chrome.storage.local.set({accounts,accountPrepared:{runId:data.runId,index:data.currentIndex||0,at:Date.now()}});
}
let leaseCheckpoint=null,sessionCheckpoint=null;
async function assertAccountLease(data,forceFresh=false){const current=await chrome.storage.local.get(['sheetContext','remoteControl']);if(current.remoteControl?.stop)return false;const context=current.sheetContext;if(!context)return true;const key=context.jobId+':'+(data.currentIndex||0);if(!forceFresh&&leaseCheckpoint?.key===key&&Date.now()-leaseCheckpoint.at<5000)return true;try{await sheetApi('heartbeat',{...context,accounts:[data.accounts?.[data.currentIndex||0]?.id]});leaseCheckpoint={key,at:Date.now()};return true;}catch(error){await stopAccountAuth('계정 사용·원격 제어 확인 실패: '+error.message,data);return false;}}
setInterval(()=>{if(engineActive)pollRemoteControl();},5000);
