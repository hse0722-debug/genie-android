/** 지니 시트 연결 서버 10.0.5 — 이 파일은 Apps Script에만 설치합니다. */
const GENIE_SEED_ID='1KS0avSMsGkba5zeDb2IZ_v2p1bJGW7uXm5hcDV_2q24';
const GENIE_ACCOUNT_ID='14SWMDCFfxYGFAuoTMxahDKTcranKXmyfVDu31SH7OEw';
function onOpen(){SpreadsheetApp.getUi().createMenu('지니 연동').addItem('1. 초기 설정','setupGenie').addItem('계정 파일 추가 허용','allowAccountFile').addToUi();}
function setupGenie(){const p=PropertiesService.getScriptProperties();if(!p.getProperty('ACCOUNT_IDS'))p.setProperty('ACCOUNT_IDS',JSON.stringify([GENIE_ACCOUNT_ID]));p.setProperty('SEED_ID',GENIE_SEED_ID);if(!p.getProperty('SEED_GID'))p.setProperty('SEED_GID','0');SpreadsheetApp.getUi().alert('설정 완료. 시드 파일의 gid가 0이 아니면 프로젝트 설정 → 스크립트 속성의 SEED_GID를 수정하세요. 다음으로 웹 앱을 배포하세요.');}
function allowAccountFile(){const ui=SpreadsheetApp.getUi(),r=ui.prompt('계정 파일 추가','허용할 Google 시트 주소 또는 파일 ID',ui.ButtonSet.OK_CANCEL);if(r.getSelectedButton()!==ui.Button.OK)return;const value=r.getResponseText().trim(),id=(value.match(/\/d\/([\w-]+)/)||[])[1]||value;if(!/^[\w-]{20,}$/.test(id))throw Error('주소를 확인하세요.');SpreadsheetApp.openById(id);const p=PropertiesService.getScriptProperties(),ids=JSON.parse(p.getProperty('ACCOUNT_IDS')||'[]');p.setProperty('ACCOUNT_IDS',JSON.stringify([...new Set([...ids,id])]));ui.alert('허용했습니다. 같은 파일의 새 탭은 추가 설정 없이 사용할 수 있습니다.');}
function hashKey_(value){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(value)).map(n=>('0'+((n+256)%256).toString(16)).slice(-2)).join('');}
function json_(value){return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}
function doGet(){return json_({ok:true,service:'genie-sheet',version:'10.0.5',message:'시트 연결용 POST 요청을 받습니다.'});}
function seeds_(p){const book=SpreadsheetApp.openById(p.getProperty('SEED_ID')||GENIE_SEED_ID),sheet=book.getSheets().find(s=>s.getSheetId()===Number(p.getProperty('SEED_GID')||0));if(!sheet)throw Error('시드 탭이 없습니다.');const cells=sheet.getRange('C3:D7').getDisplayValues(),out={};for(const [key,r,c] of [['album',0,0],['song',0,1],['mv',3,0],['artist',3,1]]){const name=String(cells[r][c]).trim(),sid=String(cells[r+1][c]).trim();if(!name&&!sid){out[key]={name:'',sid:''};continue;}if(!name||!/^\d+$/.test(sid))throw Error(key+' 이름·숫자 시드를 함께 입력하세요.');out[key]={name,sid};}return out;}
function leaseKey_(req,id){return 'LEASE_'+hashKey_('account:'+id);}

function safeCell_(value){const text=String(value??'').slice(0,500);return /^[=+@-]/.test(text)?"'"+text:text;}
function statusColumns_(sheet){
 const expected=['지니 작업 상태','지니 작업 기기','지니 마지막 확인'];
 if(sheet.getMaxColumns()<13)sheet.insertColumnsAfter(sheet.getMaxColumns(),13-sheet.getMaxColumns());
 const current=sheet.getRange(2,11,1,3).getDisplayValues()[0];
 if(current.every((v,i)=>v===expected[i]))return;
 const cells=sheet.getRange(1,11,Math.max(2,sheet.getLastRow()),3);
 if(cells.getDisplayValues().some(r=>r.some(v=>v!==''))||cells.getFormulas().some(r=>r.some(Boolean)))throw Error('K~M열에 기존 데이터가 있습니다. K~M열을 비운 뒤 다시 시작하세요.');
 sheet.getRange(2,11,1,3).setValues([expected]);
}
function accountStatus_(req,sheet,rows,state){
 statusColumns_(sheet);const phase={AUTH_LOGOUT:'로그아웃',AUTH_FORM:'로그인',AUTH_WAIT:'로그인 확인',ALBUM_LIKE:'앨범',SONG_LIKE:'곡',SONG_DOWNLOAD:'다운로드',PAY_POPUP_STEP1:'다운로드 준비',WAIT_DOWNLOAD_STREAM:'다운로드 대기',MV_LIKE:'뮤비',ARTIST_LIKE:'가수'}[req.step]||'진행';
 for(const row of rows){
  const range=sheet.getRange(row.row,11,1,3);
  range.setValues([[state,safeCell_((req.helper||'')+' · '+(req.clientId||'').slice(0,8)),new Date()]]);
  sheet.getRange(row.row,13).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  if(state==='작업 중')sheet.getRange(row.row,11).setFormula('=IF(NOW()-M'+row.row+'>TIME(0,2,0),"연결 확인 필요","작업 중 · '+phase+'")');
 }
}
function releaseAccounts_(req,p,sheet){
 const all=rows_(sheet,false);
 for(const id of req.accounts){const key=leaseKey_(req,id),value=JSON.parse(p.getProperty(key)||'null');if(value?.jobId!==req.jobId||value.owner!=='open')continue;
 const row=all.find(r=>r.id===id);if(row&&value.spreadsheetId===req.spreadsheetId&&value.gid===String(req.gid)){const status=sheet.getRange(row.row,11).getDisplayValue();if(!['완료','넘김','오류'].includes(status))accountStatus_(req,sheet,[row],'중단');}p.deleteProperty(key);}
}

function rows_(sheet,withPasswords=true){const count=sheet.getLastRow()-2;if(count<1)return [];const rows=sheet.getRange(3,1,count,4).getDisplayValues(),passwords=withPasswords?sheet.getRange(3,10,count,1).getValues():[];let time='';return rows.map((r,i)=>{if(String(r[1]).trim())time=String(r[1]).trim();return {row:i+3,number:String(r[0]).trim(),time,helper:String(r[2]).trim(),id:String(r[3]).trim(),password:withPasswords?String(passwords[i][0]??''):''};}).filter(r=>/^\d+$/.test(r.number)&&r.id&&r.helper);}
function pickRows_(req,client,sheet,prepared){const all=prepared||rows_(sheet);if(!all.some(r=>r.helper===String(req.helper)))throw Error('선택한 헬퍼가 C열에 없습니다.');const rows=all.filter(r=>r.helper===req.helper&&r.time===req.time);const seen=new Set();for(const row of rows){if(seen.has(row.id))throw Error('선택 범위에 중복 아이디가 있습니다.');seen.add(row.id);}return rows;}
function handle_(req,client,sheet,p){
 const rows=rows_(sheet,['accounts','start','prepare'].includes(req.action));
 if(req.action==='catalog')return {ok:true,title:sheet.getName(),helpers:[...new Set(rows.map(r=>r.helper))],times:[...new Set(rows.map(r=>r.time).filter(Boolean))],pairs:[...new Map(rows.map(r=>[r.helper+'\u0000'+r.time,{helper:r.helper,time:r.time}])).values()]};
 const selected=pickRows_(req,client,sheet,rows);
 if(req.action==='accounts'){const valid=selected.filter(r=>r.password.length>0);return {ok:true,title:sheet.getName(),accounts:valid,excluded:selected.length-valid.length};}
 if(!/^[\w-]{10,100}$/.test(req.jobId||''))throw Error('작업 ID 오류');
 const now=Date.now(),requested=req.accounts||[];if(!Array.isArray(requested)||requested.length>2000)throw Error('계정 수 오류');
 const targets=requested.map(id=>{const row=selected.find(r=>r.id===id);if(!row)throw Error('계정 배정·시간이 변경되었습니다. 다시 불러오세요.');return row;});
 if(['start','prepare'].includes(req.action)&&targets.some(r=>!r.password))throw Error('J열 비밀번호가 비어 있습니다.');
 const seedData=req.action==='start'?seeds_(p):null;
 if(req.action==='heartbeat'&&req.accountId&&targets.some(r=>r.id!==req.accountId))throw Error('현재 계정 확인 오류');
 const leases=targets.map(row=>{const key=leaseKey_(req,row.id),value=JSON.parse(p.getProperty(key)||'null');if(value&&value.until>now&&(value.jobId!==req.jobId||value.owner!=='open'))throw Error('다른 기기에서 사용 중인 계정이 있습니다.');return {row,key,value};});
 if(req.action==='release'){for(const item of leases)if(item.value&&item.value.jobId===req.jobId&&item.value.owner==='open')p.deleteProperty(item.key);return {ok:true};}
 if(req.action==='write'){if(leases.some(l=>!l.value||l.value.jobId!==req.jobId||l.value.until<=now))throw Error('결과 기록 잠금이 만료되었습니다. 기존 아이디와 배정을 확인하세요.');const changes=req.changes;if(!Array.isArray(changes)||changes.length>100)throw Error('기록 수 오류');const columns={down:5,song:6,mv:7,album:8,artist:9};for(const change of changes){const item=leases.find(l=>l.row.id===change.id);if(!item||!columns[change.metric]||!['o','x'].includes(change.value))throw Error('허용되지 않은 결과 기록');}for(const value of ['o','x']){const ranges=changes.filter(c=>c.value===value).map(change=>{const row=leases.find(l=>l.row.id===change.id).row;return String.fromCharCode(64+columns[change.metric])+row.row;});if(ranges.length)sheet.getRangeList(ranges).setValue(value);}SpreadsheetApp.flush();return {ok:true,written:changes.length};}
 if(['start','prepare','heartbeat','claim'].includes(req.action)){
 statusColumns_(sheet);const updates={};for(const item of leases)updates[item.key]=JSON.stringify({jobId:req.jobId,owner:'open',until:now+180000,spreadsheetId:req.spreadsheetId,gid:String(req.gid)});if(leases.length)p.setProperties(updates);
 accountStatus_(req,sheet,targets,'작업 중');}
 if(req.action==='status'){if(leases.some(l=>!l.value||l.value.jobId!==req.jobId||l.value.until<=now))throw Error('계정 상태 기록 잠금이 만료되었습니다.');accountStatus_(req,sheet,targets,['완료','넘김','오류'].includes(req.state)?req.state:'중단');}

 return {ok:true,count:targets.length,...(['start','prepare'].includes(req.action)?{accounts:targets}:{}),...(seedData?{seeds:seedData}:{})};
}
function doPost(e){try{
 const raw=e?.postData?.contents;if(!raw||raw.length>150000)throw Error('요청 크기 오류');const req=JSON.parse(raw),p=PropertiesService.getScriptProperties();
 if(req.action==='seeds')return json_({ok:true,seeds:seeds_(p)});
 if(!['catalog','accounts','claim','heartbeat','write','release','start','prepare','status'].includes(req.action))throw Error('Apps Script 새 버전 배포를 확인하세요.');
 const ids=JSON.parse(p.getProperty('ACCOUNT_IDS')||'[]');if(!ids.includes(req.spreadsheetId))throw Error('관리자가 허용하지 않은 계정 파일입니다.');
 const book=SpreadsheetApp.openById(req.spreadsheetId),sheet=book.getSheets().find(s=>s.getSheetId()===Number(req.gid));if(!sheet)throw Error('탭(gid)을 찾을 수 없습니다.');
 const lock=LockService.getScriptLock();if(!lock.tryLock(15000))throw Error('다른 요청을 처리 중입니다. 다시 시도하세요.');try{if(req.action==='release'){if(!/^[\w-]{10,100}$/.test(req.jobId||'')||!Array.isArray(req.accounts)||req.accounts.length>2000)throw Error('잠금 해제 요청 오류');releaseAccounts_(req,p,sheet);return json_({ok:true});}return json_(handle_(req,null,sheet,p));}finally{lock.releaseLock();}
 }catch(err){return json_({ok:false,error:String(err.message||'시트 요청 실패')});}}
