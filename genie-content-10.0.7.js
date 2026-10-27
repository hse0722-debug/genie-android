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
    step: 'FINISH_ACCOUNT',
    url: "https://www.genie.co.kr/"
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
      albums: seeds.albumSid?[seeds.albumSid]:[], songs: seeds.songSid?[seeds.songSid]:[],mvs:seeds.mvSid?[seeds.mvSid]:[],artists:seeds.artistSid?[seeds.artistSid]:[],
      sheetMvName:seeds.mvName,sheetArtistName:seeds.artistName,sheetSeedsFetchedAt:Date.now(),
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
async function createFloatingPanel(){
 if(window!==window.top||/\/buy\/|pop|pay\.genie/i.test(window.location.href)||!document.body)return;
 chrome.runtime.sendMessage({action:'REGISTER_MAIN_TAB'}).catch(()=>{});
 if(document.getElementById('genie-helper-dashboard'))return;
 const d=await chrome.storage.local.get(['sheetConfig','sheetCatalog','sheetSelection','panelHidden']);
 if(document.getElementById('genie-helper-dashboard'))return;
 const p=document.createElement('section');p.id='genie-helper-dashboard';p.style.cssText='position:fixed;right:12px;bottom:54px;width:460px;max-width:calc(100vw - 24px);max-height:88vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 8px 30px #0004;z-index:2147483647;color:#172846;font:13px "Malgun Gothic",sans-serif;text-align:left;';
 p.innerHTML=`<style>
 #genie-helper-dashboard *{box-sizing:border-box}
 #genie-helper-dashboard h3{font-size:13px;margin:0 0 7px;color:#07519c}
 #genie-helper-dashboard .gs-card{margin:7px 10px;padding:9px 12px;border:1px solid #d7e4ef;border-radius:8px;background:#f8fbfe}
 #genie-helper-dashboard label{display:block;font-size:12px;font-weight:bold;margin-bottom:4px}
 #genie-helper-dashboard input,#genie-helper-dashboard select{width:100%;height:32px;border:1px solid #bdcce0;border-radius:5px;padding:5px;background:#fff;color:#172846;font:inherit}
 #genie-helper-dashboard button{border:0;border-radius:5px;padding:8px 10px;cursor:pointer;background:#1688df;color:#fff;font:inherit;font-weight:bold}
 #genie-helper-dashboard button:disabled{opacity:.5;cursor:wait}
 #genie-helper-dashboard .gs-row{display:flex;gap:9px;align-items:center}
 #genie-helper-dashboard .gs-row>div{flex:1;min-width:0}
 #genie-helper-dashboard small{display:block;color:#60748b;font-size:11px;margin-top:5px}
 #genie-helper-dashboard table{width:100%;border-collapse:collapse;font-size:12px}
 #genie-helper-dashboard th,#genie-helper-dashboard td{padding:6px 4px;border-bottom:1px solid #d5deea;text-align:left;overflow-wrap:anywhere}
 #genie-helper-dashboard th{font-size:11px;color:#60748b;font-weight:normal}
 #genie-helper-dashboard .gs-status{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;color:#526a82}
 #genie-helper-dashboard summary{cursor:pointer;color:#607896;font-size:12px}
 #genie-helper-dashboard .gs-current{background:#eaf4ff;border-color:#9bc8f0}
 #genie-helper-dashboard #gs-current-account{font-size:24px;font-weight:bold;overflow-wrap:anywhere;margin:2px 0}
 #genie-helper-dashboard .gs-targets{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px}
 #genie-helper-dashboard .gs-targets>div{min-width:0;overflow-wrap:anywhere}
 #genie-helper-dashboard .gs-sid{color:#60748b;font-size:11px}
 #genie-helper-dashboard .gs-actions{display:flex;gap:8px;margin-top:10px}
 #genie-helper-dashboard .gs-actions button{flex:1;padding:9px 3px;font-size:14px}
 #genie-helper-dashboard details[open]>summary{margin-bottom:8px}
 #genie-helper-dashboard .gs-details-table{max-height:160px;overflow:auto}
 </style>
 <header id="dash-header" style="padding:12px 14px;background:#0b3768;color:white;display:flex;align-items:center;justify-content:space-between;touch-action:none"><strong>지니 다운 도우미 <small style="display:inline;color:#c6e5ff">${globalThis.__genieRuntimeVersion||'10.0.7'}</small></strong><button id="gs-hide" style="background:transparent">숨기기</button></header>
 <div class="gs-card"><h3>구글 시트 연결</h3><details id="gs-address-settings" ${d.sheetConfig?.endpoint?'':'open'}><summary>연결 주소 설정</summary><div id="gs-settings"><label>Apps Script 웹 앱 주소</label><input id="gs-endpoint" placeholder="https://script.google.com/macros/s/…/exec"></div><label style="margin-top:7px">계정 시트 주소</label><input id="gs-url" placeholder="gid가 포함된 시트 탭 주소"><button id="gs-save" style="margin:7px 0">연결 설정 저장</button></details><div class="gs-row" style="margin-top:7px"><div><label>작업 시간</label><select id="gs-time"></select></div><div><label>담당 헬퍼</label><select id="gs-helper"></select></div></div><small id="gs-connection">시트 자동 연결</small></div>
 <div class="gs-card gs-current"><div class="gs-row" style="justify-content:space-between"><span style="font-size:12px">현재 작업 중인 아이디</span><b id="gs-current-state" style="font-size:12px;color:#07519c">대기</b></div><div id="gs-current-account">작업 대기</div><small id="gs-current-location">시트 연결 후 시작하세요.</small><div id="dash-summary" class="gs-status" style="margin-top:5px"></div></div>
 <div class="gs-card"><h3>시트 계정 현황</h3><table><thead><tr><th style="width:42px">행</th><th>아이디</th><th style="width:78px">상태</th></tr></thead><tbody id="gs-account-list"></tbody></table><small>대기 계정 수정 → 다음 계정 시작 전 반영<br>현재 작업 계정 수정 → 중단 후 반영</small></div>
 <div class="gs-card"><h3>작업 대상</h3><div class="gs-targets">${[['artist','가수'],['album','앨범'],['mv','뮤비'],['song','곡']].map(([key,label])=>`<div><b>${label}</b> <span id="gs-${key}-name"></span><span class="gs-sid" id="gs-${key}-separator"></span><span class="gs-sid" id="gs-${key}-sid"></span></div>`).join('')}</div><div id="sheet-seed-status" class="gs-status"></div><div class="gs-actions"><button id="btn-resume">▶ 시작</button><button id="btn-stop" style="background:#a34545">■ 중단</button><button id="btn-skip" style="background:#647b96">▷ 넘기기</button></div></div>
 <div style="margin:8px 12px"><details id="gs-result-details"><summary>상세 결과·기록 상태</summary><button id="gs-new-run" style="margin-bottom:7px;background:#647b96">새 작업 · 전체 다시 진행</button><div class="gs-details-table"><table><thead><tr>${['아이디','다운','곡','뮤비','앨범','가수'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody id="dash-table-body"></tbody></table></div><small>E~I열 결과 자동 기록 · 다운 o = 다운로드 시작 감지</small><div id="gs-sync" class="gs-status"></div><button id="gs-sync-now" style="margin-top:7px">결과 기록 재시도</button> <button id="gs-backlog-export" style="margin-top:7px;background:#647b96">미기록 결과 저장</button></details><details style="margin-top:7px"><summary>작업 알림·로그</summary><div id="dash-last-log" class="gs-status">대기 중</div><div id="dash-log-box" style="max-height:140px;overflow:auto;font-size:11px"></div><button id="gs-log" style="margin-top:7px">로그 저장</button></details></div>`;
 document.body.appendChild(p);const el=id=>document.getElementById(id);el('gs-endpoint').value=d.sheetConfig?.endpoint||'';el('gs-url').value=d.sheetCatalog?.url||'https://docs.google.com/spreadsheets/d/14SWMDCFfxYGFAuoTMxahDKTcranKXmyfVDu31SH7OEw/edit?gid=1705416226';
 const guarded=fn=>async e=>{const button=e?.currentTarget;if(button?.tagName==='BUTTON')button.disabled=true;try{await fn();}catch(error){el('gs-connection').textContent=error.message;}finally{if(button)button.disabled=false;}};
 const message=async msg=>{const r=await chrome.runtime.sendMessage(msg);if(!r?.ok)throw Error(r?.error||'시트 연결 실패');return r;};
 const idle=async()=>{if((await chrome.storage.local.get(['isRunning'])).isRunning)throw Error('작업 중에는 설정을 바꿀 수 없습니다. 먼저 중단하세요.');};
 const options=(id,values,selected)=>{const node=el(id);node.replaceChildren();for(const value of values){const option=document.createElement('option');option.value=value;option.textContent=value;node.appendChild(option);}if(values.includes(selected))node.value=selected;};
 const helpersForTime=()=>{const time=el('gs-time').value;const pairs=gsCatalog?.pairs||[];options('gs-helper',[...new Set(pairs.filter(x=>x.time===time).map(x=>x.helper))],el('gs-helper').value);};
 let gsCatalog=d.sheetCatalog;const fill=selection=>{options('gs-time',gsCatalog?.times||[],selection?.time);helpersForTime();if(selection?.helper)el('gs-helper').value=selection.helper;};fill(d.sheetSelection);
 let connecting=false;let endpointSaved=!!d.sheetConfig?.endpoint;
 const selectSheet=async()=>{if(!el('gs-time').value||!el('gs-helper').value)return;const r=await message({action:'SHEET_SELECT',url:el('gs-url').value.trim(),helper:el('gs-helper').value,time:el('gs-time').value});el('gs-connection').textContent='시트 자동 연결 · 남은 계정 '+r.count+'개';};
 const connectSheet=async()=>{if(connecting||!endpointSaved||(await chrome.storage.local.get(['isRunning'])).isRunning)return;connecting=true;try{const previous={time:el('gs-time').value,helper:el('gs-helper').value};gsCatalog=await message({action:'SHEET_CATALOG',url:el('gs-url').value.trim()});fill(previous);await selectSheet();}finally{connecting=false;}};
 el('gs-save').onclick=guarded(async()=>{await idle();await message({action:'SHEET_PREPARE_CHANGE'});await chrome.storage.local.set({sheetConfig:{endpoint:el('gs-endpoint').value.trim()}});endpointSaved=true;await connectSheet();await loadSheetSeeds();el('gs-address-settings').open=false;});
 el('gs-time').onchange=guarded(async()=>{helpersForTime();await selectSheet();});el('gs-helper').onchange=guarded(selectSheet);el('gs-url').onchange=guarded(connectSheet);
 el('btn-resume').onclick=guarded(async()=>{await idle();await selectSheet();const r=await message({action:'SHEET_START'});await saveLog('▶ 시트 계정 자동화 시작','INFO');navigateTask(r.url||'https://www.genie.co.kr/',true);});
 setTimeout(()=>connectSheet().catch(e=>el('gs-connection').textContent=e.message),0);
 setInterval(()=>{if(document.contains(p))connectSheet().catch(e=>el('gs-connection').textContent=e.message);},15000);
 el('btn-stop').onclick=guarded(async()=>{await chrome.storage.local.set({isRunning:false});await saveLog('■ 작업 중단 · 결과 기록은 재시도 가능','INFO');await message({action:'SHEET_SYNC'});});
 el('btn-skip').onclick=guarded(async()=>{const d=await chrome.storage.local.get(['runId','currentIndex','accounts','isRunning']);if(d.isRunning&&!(await chrome.runtime.sendMessage({action:'AUTH_OWNER'}))?.ok)throw Error('메인 리모컨에서 넘겨주세요.');if(!d.accounts?.[d.currentIndex||0])throw Error('넘길 계정이 없습니다.');const expected={runId:d.runId,currentIndex:d.currentIndex||0};await chrome.storage.local.set({skipRequested:{...expected,nonce:crypto.randomUUID()}});await message({action:'SKIP_ACCOUNT',expected});});
 el('gs-backlog-export').onclick=guarded(async()=>{const d=await chrome.storage.local.get(['sheetBacklog','sheetContext','accountResults','sheetSynced']);const pending={context:d.sheetContext,accountResults:d.accountResults,synced:d.sheetSynced,backlog:d.sheetBacklog||[]};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(pending,null,2)],{type:'application/json'}));a.download='genie_unsynced_results.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
 el('gs-new-run').onclick=guarded(async()=>{await idle();if(!window.confirm('이 시간·헬퍼의 완료·넘김 기록을 초기화하고 전체 계정을 새로 작업할까요?'))return;await message({action:'SHEET_NEW_RUN'});await selectSheet();});
 el('gs-sync-now').onclick=guarded(async()=>{await message({action:'SHEET_SYNC'});});
 el('gs-log').onclick=guarded(async()=>{const data=await chrome.storage.local.get({logs:[]});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data.logs.join('\n')],{type:'text/plain;charset=utf-8'}));a.download='genie_download_log_'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
 let open=el('genie-open-btn');if(!open){open=document.createElement('button');open.id='genie-open-btn';open.textContent='🎵 도우미 열기';open.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483646;padding:9px;border:0;border-radius:20px;background:#1688df;color:white;';document.body.appendChild(open);}open.onclick=()=>{p.style.display='block';chrome.storage.local.set({panelHidden:false});};el('gs-hide').onclick=()=>{p.style.display='none';chrome.storage.local.set({panelHidden:true});};if(d.panelHidden)p.style.display='none';
 const header=el('dash-header');let drag;header.onpointerdown=e=>{if(e.target.closest('button'))return;drag={x:e.clientX,y:e.clientY,left:p.getBoundingClientRect().left,top:p.getBoundingClientRect().top};header.setPointerCapture(e.pointerId);};header.onpointermove=e=>{if(!drag)return;p.style.left=Math.max(0,Math.min(window.innerWidth-p.offsetWidth,drag.left+e.clientX-drag.x))+'px';p.style.top=Math.max(0,drag.top+e.clientY-drag.y)+'px';p.style.right='auto';p.style.bottom='auto';};header.onpointerup=()=>{drag=null;};
 await updateDashboardUI();if(d.sheetConfig?.endpoint&&!(await chrome.storage.local.get(['isRunning'])).isRunning)await loadSheetSeeds();message({action:'SHEET_SYNC',force:false}).catch(()=>{});
}
async function updateDashboardUI(){
 const el=id=>document.getElementById(id),tbody=el('dash-table-body');if(!tbody)return;
 const d=await chrome.storage.local.get(['accounts','accountResults','currentIndex','isRunning','step','lastActionText','logs','albums','songs','mvs','artists','sheetAlbumName','sheetSongName','sheetMvName','sheetArtistName','sheetSyncError','sheetPending','sheetBacklog','sheetBacklogError','sheetSelection','sheetCompletedIds']);
 for(const [key,list,name] of [['album','albums','sheetAlbumName'],['song','songs','sheetSongName'],['mv','mvs','sheetMvName'],['artist','artists','sheetArtistName']]){el('gs-'+key+'-name').textContent=d[name]||'';el('gs-'+key+'-sid').textContent=d[list]?.[0]||'';el('gs-'+key+'-separator').textContent=d[list]?.[0]?' · SID ':'';}
 const accounts=d.accounts||[],index=d.currentIndex||0,active=accounts[index],completed=new Set(d.sheetCompletedIds||[]);
 const stages={AUTH_LOGOUT:'로그아웃',AUTH_FORM:'로그인',AUTH_WAIT:'로그인 확인',ALBUM_LIKE:'앨범',SONG_LIKE:'곡',SONG_DOWNLOAD:'다운로드',PAY_POPUP_STEP1:'다운로드 준비',WAIT_DOWNLOAD_STREAM:'다운로드 대기',MV_LIKE:'뮤비',ARTIST_LIKE:'가수'};
 el('gs-current-account').textContent=d.isRunning&&active?active.id:'작업 대기';el('gs-current-state').textContent=d.isRunning?'진행 중':'대기';
 el('gs-current-location').textContent=d.isRunning&&active?'계정 시트 · '+active.row+'행 · '+(d.sheetSelection?.helper||''):'시트의 최신 계정으로 시작합니다.';
 el('dash-summary').textContent=d.isRunning?(stages[d.step]||'작업')+' 진행 중 · '+(index+1)+' / '+accounts.length+' 계정':'남은 계정 '+accounts.filter(a=>!completed.has(a.id)).length+'개';
 const start=Math.max(0,Math.min(index-1,accounts.length-3)),visible=accounts.slice(start,start+3);
 el('gs-account-list').innerHTML=visible.map(a=>{const isActive=d.isRunning&&a===active;const status=isActive?'● 작업 중':completed.has(a.id)?'처리 완료':'대기';return '<tr'+(isActive?' style="background:#e8f3ff;font-weight:bold"':'')+'><td>'+escapeHtml(String(a.row||''))+'</td><td>'+escapeHtml(a.id)+'</td><td>'+status+'</td></tr>';}).join('')||'<tr><td colspan="3">시트 연결 후 시작하세요.</td></tr>';
 el('dash-last-log').textContent=d.lastActionText||'대기 중';
 el('gs-sync').textContent=d.sheetSyncError?'시트 미기록 · '+d.sheetSyncError:d.sheetPending?'기록 대기 '+d.sheetPending+'건':'시트 기록 상태 정상';
 const archived=(d.sheetBacklog||[]).reduce((n,x)=>n+x.changes.length,0);if(archived)el('gs-sync').textContent+=' · 미기록 결과 '+archived+'건 보관'+(d.sheetBacklogError?' ('+d.sheetBacklogError+')':'');
 if(d.sheetSyncError||d.sheetPending||archived)el('gs-result-details').open=true;
 const mark=v=>['o','x'].includes(v)?'<b style="color:'+(v==='o'?'#00872c':'#d52222')+'">'+v+'</b>':'';
 tbody.innerHTML=accounts.map((a,i)=>{const r=d.accountResults?.[a.id]||{};return '<tr style="background:'+(d.isRunning&&i===index?'#edf6ff':'white')+'"><td>'+escapeHtml(a.id)+'</td>'+['down','song','mv','album','artist'].map(k=>'<td>'+mark(r[k])+'</td>').join('')+'</tr>';}).join('')||'<tr><td colspan="6">시트 연결 후 시작하세요.</td></tr>';
 el('dash-log-box').textContent=(d.logs||[]).slice(-150).join('\n');el('dash-log-box').style.whiteSpace='pre-wrap';
 for(const id of ['gs-save','gs-url','gs-time','gs-helper','gs-new-run'])el(id).disabled=!!d.isRunning;
}

function renderMark(val) {
  if (val === 'o') return "<b style='color:#27ae60;'>o</b>";
  if (val === 'x') return "<b style='color:#e74c3c;'>x</b>";
  return "<span style='color:#95a5a6;'>-</span>";
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
  if(ok&&likeBtn){ok=likeBtn.classList.contains('on')||likeBtn.classList.contains('active')||likeBtn.parentElement?.classList.contains('on');if(!ok)message='클릭 후 좋아요 상태 미확인';}
  await onComplete(Boolean(ok), message);
}

async function claimTaskAction(action, data) {
  const reply = await chrome.runtime.sendMessage({ action: 'CLAIM_TASK_ACTION', taskAction: action,
    expected: { runId: data.runId, currentIndex: data.currentIndex || 0,
      albumIndex: data.albumIndex || 0, songIndex: data.songIndex || 0 } });
  return reply?.granted === true;
}

async function isTaskCurrent(data, allowedSteps) {
  const now = await chrome.storage.local.get(['isRunning', 'runId', 'currentIndex', 'albumIndex', 'songIndex', 'step','skipRequested']);
  return now.isRunning && !skipMatchesAccount(now) && now.runId === data.runId &&
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
    if (!(await authCommand('AUTH_ASSERT',data))?.ok) return true;
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
    if(!(await authCommand('AUTH_FINAL_GUARD',data))?.ok || !actionable(readyButton) || currentControls.some(el=>!el.checked))return true;
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

let navigationPending = false,documentLeaving=false;
window.addEventListener('pagehide',()=>{documentLeaving=true;},{once:true});
function expectedNavigationError(error){return (navigationPending||documentLeaving)&&/페이지 연결이 변경되었습니다|실행 연결이 만료되었습니다|message port closed|context invalidated/i.test(String(error?.message||''));}
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
      'accounts', 'currentIndex', 'albums', 'songs', 'albumIndex', 'songIndex', 'isRunning', 'step', 'waitRetry', 'runId', 'downloadWaitStartedAt', 'authSequence', 'mvs', 'artists', 'skipRequested'
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

    if (skipMatchesAccount(data)||['DOWNLOAD_RECEIVED', 'ACCOUNT_ROLLOVER','SKIP_ACCOUNT_PENDING'].includes(step)) return;
    const currentAccount = accounts[currentIndex];
    const currentUrl = window.location.href;

    if (await handleAccountAuthentication(data)) return;
    if (await handlePayment(data)) return;
    if (window !== window.top) return;
    if (!(await chrome.runtime.sendMessage({action:'AUTH_OWNER'}))?.ok) return;

    if(['MV_LIKE','ARTIST_LIKE'].includes(step)){
      const key=step==='MV_LIKE'?'mv':'artist',sid=key==='mv'?data.mvs?.[0]:data.artists?.[0];
      const next=key==='mv'&&data.artists?.length?{step:'ARTIST_LIKE',url:'https://www.genie.co.kr/detail/artistInfo?xxnm='+data.artists[0]}:getNextStageUrl('ALBUM_LIKE',data);
      if(!sid){await chrome.storage.local.set({step:next.step});navigateTask(next.url);return;}
      const url='https://www.genie.co.kr/detail/'+(key==='mv'?'mediaInfo?xvnm=':'artistInfo?xxnm=')+sid;
      if(!currentUrl.includes((key==='mv'?'xvnm=':'xxnm=')+sid)){navigateTask(url);return;}
      if(!await claimTaskAction(step,data))return;
      await performLikeWithCheck(async(ok,message)=>{if(!await isTaskCurrent(data))return;await updateStepResult(currentAccount.id,key,ok?'o':'x');await saveLog((key==='mv'?'뮤비':'가수')+' 좋아요 '+message,ok?'SUCCESS':'ERROR');await chrome.storage.local.set({step:next.step});navigateTask(next.url);});return;
    }
    if(step==='FINISH_ACCOUNT'){
      await chrome.runtime.sendMessage({action:'FORCE_ROLLOVER',reason:'좋아요 작업 완료',completed:true,expected:{runId:data.runId,currentIndex:data.currentIndex||0,songIndex:data.songIndex||0}});return;
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


  } catch (err) {
    if(!expectedNavigationError(err))await saveLog(`❌ 오류 발생: ${err.message}`, 'ERROR');
  } finally {
    isStepRunning = false;
  }
}

createFloatingPanel();
setInterval(processTask, 1000);
async function authCommand(action,data) {
  return chrome.runtime.sendMessage({action,expected:{runId:data.runId,currentIndex:data.currentIndex||0,songIndex:data.songIndex||0}});
}
async function handleAccountAuthentication(data) {
  if (!['CHECK_OR_LOGIN','NEXT_ACCOUNT_LOGIN','IDLE','AUTH_LOGOUT','AUTH_FORM','AUTH_WAIT'].includes(data.step)) return false;
  if(window!==window.top)return true;
  if(!(await chrome.runtime.sendMessage({action:'AUTH_OWNER'}))?.ok)return true;
  let reply;
  if(['CHECK_OR_LOGIN','NEXT_ACCOUNT_LOGIN','IDLE'].includes(data.step)) reply=await authCommand('AUTH_BEGIN',data);
  else if(data.step==='AUTH_LOGOUT')reply=await authCommand('AUTH_LOGOUT_CHECK',data);
  else if(data.step==='AUTH_FORM') {
    const pick=selector=>Array.from(document.querySelectorAll(selector)).find(actionable);
    const id=pick('#gnb_uxd,#gnb_uxd_id,#uxd_id,input[name="gnb_uxd"]');
    const pw=pick('#gnb_uxx,#gnb_uxd_pw,#uxd_pw,input[name="gnb_uxx"]');
    if(!id||!pw){if(Date.now()-(data.authSequence?.logoutConfirmedAt||0)>30000)await authCommand('AUTH_FAIL',data);return true;}
    setInputValue(id,data.accounts[data.currentIndex||0].id);setInputValue(pw,data.accounts[data.currentIndex||0].pw);
    await taskDelay(900);
    if(!await isTaskCurrent(data,['AUTH_FORM']))return true;
    reply=await authCommand('AUTH_SUBMIT',data);
    if(!reply?.ok||!await isTaskCurrent(data,['AUTH_WAIT']))return true;
    const button=pick('input.btn-submit[value="로그인"],input.btn-submit,input[type="submit"],button[type="submit"],.btn-login,a[onclick*="loginID"]');
    if(button)button.click();else callPageFunction('loginID');
    return true;
  } else {
    if(Date.now()-(data.authSequence?.submittedAt||0)>1500 && /일치하지 않습니다|다시 확인해주세요/.test(document.body?.innerText||''))reply=await authCommand('AUTH_FAIL',data);
    else reply=await authCommand('AUTH_LOGIN_CHECK',data);
  }
  if(reply?.ok&&reply.url&&await isTaskCurrent(data))navigateTask(reply.url,true);
  return true;
}

function skipMatchesAccount(data){const request=data.skipRequested;return Boolean(request&&request.runId===data.runId&&(request.currentIndex||0)===(data.currentIndex||0));}
