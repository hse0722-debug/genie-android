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
  engineActive=true;chrome.storage.local.set({sheetEngineOwner:engineToken});
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
  await chrome.storage.local.set({step:'ACCOUNT_ROLLOVER'});
  await closePaymentPopups();
  const latest=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex']);if(!sameTask(latest,data))return;

  let accounts = data.accounts || [];
  const currentAccount = accounts[data.currentIndex];

  // 다음 계정으로 넘어갈 때 완료되지 않은('-') 항목을 'x'로 기록
  if (currentAccount) {
    const results = data.accountResults || {};
    if (!results[currentAccount.id]) results[currentAccount.id] = { album: '-', song: '-', down: '-' };
    for(const metric of ['album','song','down','mv','artist']){const enabled={album:data.albums?.length,song:data.songs?.length,down:data.songs?.length,mv:data.mvs?.length,artist:data.artists?.length}[metric];if(enabled&&!['o','x'].includes(results[currentAccount.id][metric]))results[currentAccount.id][metric]='x';}
    await chrome.storage.local.set({ accountResults: results });
  }

  try{accounts=await nextSheetAccounts(data,reason.includes('넘기기')?'넘김':isError?'오류':'완료');}catch(error){await chrome.storage.local.set({isRunning:false});await appendLog('ERROR','계정 시트 갱신 실패: '+error.message);return;}
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
    const context=(await chrome.storage.local.get(['sheetContext'])).sheetContext;if(context){await sheetApi('release',{...context,finished:true});await chrome.storage.local.set({sheetContext:null});}
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
        const context=(await chrome.storage.local.get(['sheetContext'])).sheetContext;if(context)await sheetApi('heartbeat',{...context,accounts:[data.accounts?.[data.currentIndex||0]?.id]});
        const session=await probe();
        const previous=data.verifiedSession||data.previousSession;
        const sequence={runId:data.runId,index:data.currentIndex||0,account:account.id,phase:'LOGOUT',startedAt:Date.now(),previousMember:session.memberNo||previous?.memberNo||'',previousAccount:previous?.account||'',logoutAttempts:1};
        await chrome.storage.local.set({authSequence:sequence,verifiedSession:null,step:'AUTH_LOGOUT',albumIndex:0,songIndex:0,waitRetry:0});
        await appendLog('INFO','이전 로그인 세션 로그아웃 요청 → 서버 상태 확인 대기');
        return {ok:true,url:authLogoutUrl};
      }
      const seq=data.authSequence;
      if(!seq || seq.runId!==data.runId || seq.index!==(data.currentIndex||0) || seq.account!==account.id)return stopAccountAuth('로그인 순서 정보가 일치하지 않습니다',data);
      if(msg.action==='AUTH_FAIL')return failAccountAndAdvance('로그인 화면 오류 또는 아이디·비밀번호 확인 실패',data);
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
        if(Date.now()-seq.logoutConfirmedAt>60000)return failAccountAndAdvance('로그인 준비 시간 초과',data);
        if((await probe()).loggedIn)return stopAccountAuth('대상 계정 로그인 전에 다른 로그인 세션이 나타났습니다',data);
        await chrome.storage.local.set({step:'AUTH_WAIT',authSequence:{...seq,phase:'WAIT',submittedAt:Date.now()}});
        await appendLog('INFO','로그아웃 확인 후 대상 계정 로그인 1회 제출');
        return {ok:true};
      }
      if(msg.action==='AUTH_LOGIN_CHECK' && data.step==='AUTH_WAIT' && seq.phase==='WAIT') {
        const session=await probe();
        if(!session.loggedIn){if(Date.now()-seq.submittedAt>30000)return failAccountAndAdvance('대상 계정 로그인 시간 초과',data);return {ok:true,waiting:true};}
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
let sheetTickBusy=false;
setInterval(()=>{if(engineActive)sheetTick().catch(()=>{});},15000);

function skipMatchesAccount(data){const request=data.skipRequested;return Boolean(request&&request.runId===data.runId&&(request.currentIndex||0)===(data.currentIndex||0));}
async function skipAccount(expected,sender){
 const data=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','accounts','mainTabId','accountResults','albums','songs','mvs','artists']);
 if(!expected||data.runId!==expected.runId||(data.currentIndex||0)!==(expected.currentIndex||0))return {ok:false,error:'현재 계정이 바뀌었습니다. 확인 후 다시 시도하세요.'};
 if(sender.frameId!==0||(data.isRunning&&sender.tab?.id!==data.mainTabId))return {ok:false,error:'메인 리모컨에서 넘겨주세요.'};
 const account=data.accounts?.[data.currentIndex||0];if(!account)return {ok:false,error:'넘길 계정이 없습니다.'};
 if(data.isRunning){await chrome.storage.local.set({step:'SKIP_ACCOUNT_PENDING'});await performAccountRollover('사용자 ▷ 넘기기',true,data);}
 else{const snapshot=await chrome.storage.local.get(null);const done=[...new Set([...progressIds(snapshot,snapshot.sheetSelection),account.id])];await saveProgress(snapshot,snapshot.sheetSelection,done);await chrome.storage.local.set({currentIndex:(data.currentIndex||0)+1,albumIndex:0,songIndex:0,step:'CHECK_OR_LOGIN',verifiedSession:null,authSequence:null});await appendLog('INFO','▷ '+account.id+' 계정 넘기기 · 다음 시작 위치 저장');}

 return {ok:true};
}

const engineToken=Date.now()+':'+Math.random();
let engineActive=false;
async function ensureClientId(){const d=await chrome.storage.local.get(['sheetClientId']);if(d.sheetClientId)return d.sheetClientId;const id=crypto.randomUUID();await chrome.storage.local.set({sheetClientId:id});return id;}
async function sheetApi(action,extra={}){
 const d=await chrome.storage.local.get(['sheetConfig','sheetSelection','accounts','currentIndex','isRunning','step']);const c=d.sheetConfig;
 if(!c?.endpoint)throw Error('웹 앱 주소를 저장하세요.');if(!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(c.endpoint))throw Error('Apps Script /exec 주소를 입력하세요.');
 const start=Date.now(),payload=JSON.stringify({action,helper:d.sheetSelection?.helper||'',accountId:d.accounts?.[d.currentIndex||0]?.id||'',isRunning:!!d.isRunning,step:d.step,...extra});
 const retryable=['catalog','accounts','seeds','heartbeat'].includes(action),attempts=retryable?3:1;
 for(let attempt=0;attempt<attempts;attempt++){
  let response;
  try{response=await fetch(c.endpoint,{method:'POST',body:payload});}catch(error){if(attempt+1>=attempts)throw error;await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));continue;}
  if(!response.ok){if(retryable&&[429,500,502,503,504].includes(response.status)&&attempt+1<attempts){await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));continue;}throw Error('시트 응답 오류 ('+response.status+')');}
  let result;try{result=await response.json();}catch{throw Error('웹 앱 새 버전 배포와 접근 권한을 확인하세요.');}if(!result.ok)throw Error(result.error||'시트 요청 실패');return {...result,elapsedMs:Date.now()-start};
 }
}
function selectionKey(selection){return selection?JSON.stringify([String(selection.spreadsheetId||''),String(selection.gid??''),String(selection.time||''),String(selection.helper||'')]):'';}
function progressIds(d,selection){
 const same=selectionKey(d.sheetSelection)===selectionKey(selection),stored=d.sheetProgress?.[selectionKey(selection)]||[];
 const prefix=same?(d.accounts||[]).slice(0,d.currentIndex||0).map(a=>a.id):[];
 return [...new Set([...stored,...(same?(d.sheetCompletedIds||[]):[]),...prefix])];
}
async function saveProgress(d,selection,ids){const progress={...(d.sheetProgress||{}),[selectionKey(selection)]:[...new Set(ids)]};await chrome.storage.local.set({sheetProgress:progress,sheetCompletedIds:progress[selectionKey(selection)]});}
function seedValues(s){return {albums:s.album.sid?[s.album.sid]:[],songs:s.song.sid?[s.song.sid]:[],mvs:s.mv.sid?[s.mv.sid]:[],artists:s.artist.sid?[s.artist.sid]:[],sheetAlbumName:s.album.name,sheetSongName:s.song.name,sheetMvName:s.mv.name,sheetArtistName:s.artist.name,sheetSeedsFetchedAt:Date.now()};}
function accountValues(rows){return rows.map(r=>({id:r.id,pw:r.password,row:r.row,number:r.number}));}
async function sheetCommand(msg){
 if(msg.action==='SHEET_SYNC')return sheetTick(msg.force!==false);
 const d=await chrome.storage.local.get(null);if(d.isRunning)throw Error('먼저 작업을 중단하세요.');
 if(msg.action==='SHEET_PREPARE_CHANGE'){const sync=await sheetTick(true);if(!sync.ok)throw Error(sync.error);return {ok:true};}
 if(msg.action==='SHEET_CATALOG'){const source=accountSheetRef(msg.url),result=await sheetApi('catalog',source);await chrome.storage.local.set({sheetCatalog:{...result,...source,url:msg.url}});return result;}
 if(msg.action==='SHEET_SELECT'){
 const source=accountSheetRef(msg.url),selection={...source,helper:msg.helper,time:msg.time,credentialMode:'row-password'};
 if(!selection.helper||!selection.time)throw Error('시간과 헬퍼를 선택하세요.');
 const changed=selectionKey(selection)!==selectionKey(d.sheetSelection);
 const sync=await sheetTick(true);if(!sync.ok)throw Error(sync.error);
 let snapshot=await chrome.storage.local.get(null);if(changed&&snapshot.sheetSelection){await saveProgress(snapshot,snapshot.sheetSelection,progressIds(snapshot,snapshot.sheetSelection));snapshot=await chrome.storage.local.get(null);}
 const ids=progressIds(snapshot,selection);
 const fresh=await sheetApi('accounts',selection),done=new Set(ids),accounts=accountValues(fresh.accounts.filter(r=>!done.has(r.id)));
 await saveProgress(snapshot,selection,ids);
 await chrome.storage.local.set({sheetSelection:selection,accounts,currentIndex:0,sheetExcluded:fresh.excluded,sheetLiveAt:Date.now(),...(changed?{sheetContext:null,accountResults:{},sheetSynced:{}}:{})});return {ok:true,count:accounts.length};
 }
 if(msg.action==='SHEET_RESET_STATUS'){if(!d.sheetSelection)throw Error('시간과 헬퍼를 선택하세요.');const sync=await sheetTick(true);if(!sync.ok)throw Error(sync.error);return sheetApi('resetStatus',d.sheetSelection);}
 if(msg.action==='SHEET_NEW_RUN'){
 const sync=await sheetTick(true);if(!sync.ok)throw Error(sync.error);const now=await chrome.storage.local.get(null);if(!now.sheetSelection)throw Error('시간과 헬퍼를 먼저 선택하세요.');
 await saveProgress(now,now.sheetSelection,[]);await chrome.storage.local.set({accounts:[],currentIndex:0,accountResults:{},sheetSynced:{},sheetContext:null});return {ok:true};
 }

 if(msg.action!=='SHEET_START')throw Error('지원하지 않는 시트 요청');
 const sync=await sheetTick(true);if(!sync.ok)throw Error(sync.error);const latest=await chrome.storage.local.get(null),selection=latest.sheetSelection;if(!selection)throw Error('시트 연결 설정과 시간·헬퍼를 선택하세요.');
 const fresh=await sheetApi('accounts',selection),completed=progressIds(latest,selection),done=new Set(completed);let accounts=accountValues(fresh.accounts.filter(r=>!done.has(r.id)));
 if(!accounts.length)throw Error('남은 계정이 없습니다. 전체를 다시 작업하려면 상세 결과의 새 작업을 선택하세요.');
 await saveProgress(latest,selection,completed);
 const runId=crypto.randomUUID(),context={...selection,jobId:runId,accounts:accounts.map(a=>a.id)};
 const result=await sheetApi('start',{...context,accounts:[accounts[0].id]});const seeds=seedValues(result.seeds);
 if(![seeds.albums,seeds.songs,seeds.mvs,seeds.artists].some(x=>x.length)){await sheetApi('release',{...context,accounts:[accounts[0].id]});throw Error('시드를 하나 이상 입력하세요.');}
 const previous=latest.verifiedSession||latest.previousSession;
 await chrome.storage.local.set({...seeds,accounts,sheetContext:context,sheetSynced:{},accountResults:{},sheetSyncError:'',sheetPending:0,isRunning:true,runId,actionClaims:{},verifiedSession:null,step:'AUTH_LOGOUT',currentIndex:0,skipRequested:null,albumIndex:0,songIndex:0,waitRetry:0,accountPrepared:{runId,index:0,at:Date.now()},authSequence:{runId,index:0,account:accounts[0].id,phase:'LOGOUT',startedAt:Date.now(),previousMember:previous?.memberNo||'',previousAccount:previous?.account||'',logoutAttempts:1}});
 return {ok:true,runId,url:authLogoutUrl};
}
function unsentChanges(d){const enabled={album:d.albums?.length,song:d.songs?.length,down:d.songs?.length,mv:d.mvs?.length,artist:d.artists?.length};const out=[];for(const id of d.sheetContext?.accounts||[])for(const metric of ['down','song','mv','album','artist']){const value=d.accountResults?.[id]?.[metric];if(enabled[metric]&&['o','x'].includes(value)&&d.sheetSynced?.[id+':'+metric]!==value)out.push({id,metric,value});}return out;}
async function sheetTick(force=false){
 if(sheetTickBusy){if(!force)return {ok:true,busy:true};const until=Date.now()+35000;while(sheetTickBusy){if(Date.now()>until)return {ok:false,error:'시트 기록 처리 중입니다. 잠시 후 다시 시도하세요.'};await new Promise(resolve=>setTimeout(resolve,50));}}const owner=(await chrome.storage.local.get(['sheetEngineOwner'])).sheetEngineOwner;if(!force&&owner!==engineToken)return {ok:true};sheetTickBusy=true;
 try{const d=await chrome.storage.local.get(null);if(!d.sheetContext)return {ok:true};const synced=d.sheetSynced||{},changes=unsentChanges(d);const current=d.accounts?.[d.currentIndex||0];
 if(d.isRunning&&current)await sheetApi('heartbeat',{...d.sheetContext,accounts:[current.id]});
 if(changes.length){for(let i=0;i<changes.length;i+=100){const batch=changes.slice(i,i+100);await sheetApi('write',{...d.sheetContext,accounts:[...new Set(batch.map(c=>c.id))],changes:batch});for(const c of batch)synced[c.id+':'+c.metric]=c.value;await chrome.storage.local.set({sheetSynced:synced});}}
 if(!d.isRunning){await sheetApi('release',d.sheetContext);await chrome.storage.local.set({sheetContext:null});}
 await chrome.storage.local.set({sheetSyncError:'',sheetPending:0});return {ok:true};
 }catch(error){const d=await chrome.storage.local.get(['isRunning']);await chrome.storage.local.set({sheetSyncError:error.message,sheetPending:1,...(d.isRunning?{isRunning:false}:{})});return {ok:false,error:error.message};}finally{sheetTickBusy=false;}
}
async function prepareAccount(data){
 const d=await chrome.storage.local.get(['sheetContext','accountPrepared']);if(!d.sheetContext)return;if(d.accountPrepared?.runId===data.runId&&d.accountPrepared.index===(data.currentIndex||0))return;
 const id=data.accounts?.[data.currentIndex||0]?.id,result=await sheetApi('prepare',{...d.sheetContext,accounts:[id]}),fresh=result.accounts?.find(a=>a.id===id);if(!fresh?.password)throw Error('현재 계정과 J열 비밀번호를 확인하세요.');
 const current=await chrome.storage.local.get(null);if(!sameTask(current,data)||skipMatchesAccount(current)||current.step!==data.step)throw Error('로그인 순서가 변경되었습니다.');const accounts=current.accounts;accounts[data.currentIndex||0]={id:fresh.id,pw:fresh.password,row:fresh.row,number:fresh.number};await chrome.storage.local.set({accounts,accountPrepared:{runId:data.runId,index:data.currentIndex||0,at:Date.now()}});
}
let leaseCheckpoint=null,sessionCheckpoint=null;
async function assertAccountLease(data,forceFresh=false){const context=(await chrome.storage.local.get(['sheetContext'])).sheetContext;if(!context)return true;const key=context.jobId+':'+(data.currentIndex||0);if(!forceFresh&&leaseCheckpoint?.key===key&&Date.now()-leaseCheckpoint.at<5000)return true;try{await sheetApi('heartbeat',{...context,accounts:[data.accounts?.[data.currentIndex||0]?.id]});leaseCheckpoint={key,at:Date.now()};return true;}catch(error){await stopAccountAuth('계정 시트 확인 실패: '+error.message,data);return false;}}
async function nextSheetAccounts(data,state){
 const d=await chrome.storage.local.get(null),context=d.sheetContext;if(!context)return data.accounts;
 const id=data.accounts?.[data.currentIndex||0]?.id;
 const checkpoint=await chrome.storage.local.get(null);if(!sameTask(checkpoint,data))throw Error('작업이 중단되거나 변경되었습니다.');
 const completed=[...new Set([...progressIds(checkpoint,d.sheetSelection),id])];await saveProgress(checkpoint,d.sheetSelection,completed);
 const sync=await sheetTick(true);if(!sync.ok)throw Error(sync.error);
 await sheetApi('status',{...context,accounts:[id],state});
 const fresh=await sheetApi('accounts',d.sheetSelection);const done=new Set(completed),prefix=data.accounts.slice(0,(data.currentIndex||0)+1),remaining=accountValues(fresh.accounts.filter(r=>!done.has(r.id))),accounts=[...prefix,...remaining];
 const latest=await chrome.storage.local.get(null);if(!sameTask(latest,data))throw Error('작업이 중단되거나 변경되었습니다.');
 await chrome.storage.local.set({sheetCompletedIds:completed,accounts,sheetContext:{...context,accounts:accounts.map(a=>a.id)},sheetLiveAt:Date.now()});return accounts;
}

async function getSheetSeeds(){const result=await sheetApi('seeds');const s=result.seeds;return {albumName:s.album.name,albumSid:s.album.sid,songName:s.song.name,songSid:s.song.sid,mvName:s.mv.name,mvSid:s.mv.sid,artistName:s.artist.name,artistSid:s.artist.sid};}

async function failAccountAndAdvance(message,data){
 const now=await chrome.storage.local.get(['isRunning','runId','currentIndex','songIndex','step']);if(!sameTask(now,data)||now.step==='ACCOUNT_ROLLOVER')return {ok:false};
 await appendLog('ERROR',message+' → 다음 계정으로 넘김');
 await performAccountRollover(message,true,data);return {ok:false,advanced:true};
}
