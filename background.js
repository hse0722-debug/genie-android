'use strict';
const BASE = 'https://raw.githubusercontent.com/hse0722-debug/genie-android/main/';
const PRIVATE = '_genieLoader_';
const clients = new Set();
const requests = new Map();
let fetchInFlight, setupInFlight, pumping = false, kernelQueue = Promise.resolve();
const lock = fn => { const result = kernelQueue.then(fn); kernelQueue = result.catch(() => {}); return result; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const genieUrl = url => { try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && (u.hostname === 'genie.co.kr' || u.hostname.endsWith('.genie.co.kr')); } catch { return false; } };
const enginePage = sender => sender.frameId === 0 && genieUrl(sender.url);
function requireSender(sender) { if (!sender.tab?.id || !sender.documentId || !genieUrl(sender.url)) throw new Error('지니 페이지에서만 실행할 수 있습니다.'); }
function appObject(obj) { return Object.fromEntries(Object.entries(obj || {}).filter(([key]) => !key.startsWith(PRIVATE))); }
async function readApp(keys) {
  if (Array.isArray(keys)) keys = keys.filter(key => typeof key === 'string' && !key.startsWith(PRIVATE));
  else if (typeof keys === 'string' && keys.startsWith(PRIVATE)) return {};
  else if (keys && typeof keys === 'object') keys = appObject(keys);
  return appObject(await chrome.storage.local.get(keys));
}
async function fetchText(url, timeout = 15000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try { const r = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal }); return { ok: r.ok, status: r.status, body: await r.text() }; }
  finally { clearTimeout(timer); }
}
async function digest(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(v => v.toString(16).padStart(2, '0')).join(''); }
async function latestBundle() {
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = (async () => {
    const response = await fetchText(BASE + 'release.json?refresh=' + Date.now() + '-' + crypto.randomUUID());
    if (!response.ok) throw new Error('최신 버전 조회 실패: HTTP ' + response.status);
    const m = JSON.parse(response.body);
    if (m.schema !== 1 || m.loaderApi !== 1 || !/^\d+\.\d+\.\d+$/.test(m.version)) throw new Error('실행기와 호환되지 않는 배포 정보입니다.');
    const readAsset = async (role, prefix) => {
      const entry = m[role];
      if (!entry || entry.file !== prefix + m.version + '.js' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('배포 파일 정보가 올바르지 않습니다.');
      const asset = await fetchText(BASE + entry.file);
      if (!asset.ok || asset.body.length > 1500000) throw new Error('작업 코드 다운로드 실패: ' + role);
      if (await digest(asset.body) !== entry.sha256) throw new Error('작업 코드 검증 실패: ' + role);
      return asset.body;
    };
    const [content, engine] = await Promise.all([readAsset('content', 'genie-content-'), readAsset('engine', 'genie-engine-')]);
    return { id: m.version + ':' + m.content.sha256 + ':' + m.engine.sha256, version: m.version, content, engine };
  })();
  try { return await fetchInFlight; } finally { fetchInFlight = null; }
}
async function bundleForDocument(sender) {
  requireSender(sender);
  const state = await chrome.storage.local.get(['isRunning', PRIVATE + 'runBundle']);
  let bundle;
  if (state.isRunning) {
    bundle = state[PRIVATE + 'runBundle'];
    if (!bundle) {
      await chrome.storage.local.set({ isRunning: false });
      throw new Error('새 실행기 설치가 완료되었습니다. 페이지를 한 번 새로고침한 뒤 시작해주세요.');
    }
  } else bundle = await latestBundle();
  await lock(async () => {
    const saved = await chrome.storage.local.get([PRIVATE + 'bundles', PRIVATE + 'documents']);
    const bundles = saved[PRIVATE + 'bundles'] || {}, docs = saved[PRIVATE + 'documents'] || {};
    bundles[bundle.id] = bundle; docs[sender.documentId] = { bundleId: bundle.id, tabId: sender.tab.id, frameId: sender.frameId };
    const keep = new Set([bundle.id, state[PRIVATE + 'runBundle']?.id]);
    for (const key of Object.keys(bundles).slice(0, -5)) if (!keep.has(key)) delete bundles[key];
    const docKeys = Object.keys(docs); for (const key of docKeys.slice(0, -300)) delete docs[key];
    await chrome.storage.local.set({ [PRIVATE + 'bundles']: bundles, [PRIVATE + 'documents']: docs });
  });
  return bundle;
}
async function validateContext(sender, bundleId) {
  requireSender(sender);
  const saved = await chrome.storage.local.get([PRIVATE + 'documents', PRIVATE + 'bundles']);
  const doc = saved[PRIVATE + 'documents']?.[sender.documentId];
  const bundle = saved[PRIVATE + 'bundles']?.[bundleId];
  if (!doc || doc.bundleId !== bundleId || !bundle || doc.tabId !== sender.tab.id) throw new Error('실행 연결이 만료되었습니다. 페이지를 새로고침해주세요.');
  return bundle;
}
async function ensureRuntime() {
  if (setupInFlight) return setupInFlight;
  setupInFlight = (async () => {
    if (!chrome.userScripts?.configureWorld || !chrome.runtime.onUserScriptMessage) throw new Error('이 브라우저에서 사용자 스크립트 API를 사용할 수 없습니다. 확장 세부정보의 사용자 스크립트 허용을 확인해주세요.');
    await chrome.userScripts.configureWorld({ messaging: true, csp: "script-src 'self' 'unsafe-eval'; object-src 'none'" });
    const installed = await chrome.userScripts.getScripts({ ids: ['genie-runtime-v1'] });
    if (!installed.length) await chrome.userScripts.register([{ id: 'genie-runtime-v1', matches: ['*://*.genie.co.kr/*'], allFrames: true, runAt: 'document_idle', world: 'USER_SCRIPT', js: [{ file: 'user-runtime.js' }] }]);
  })();
  try { return await setupInFlight; } finally { setupInFlight = null; }
}
async function bootstrap(sender) {
  requireSender(sender); await ensureRuntime();
  if (chrome.userScripts.execute) {
    const results = await chrome.userScripts.execute({ target: { tabId: sender.tab.id, documentIds: [sender.documentId] }, world: 'USER_SCRIPT', js: [{ file: 'user-runtime.js' }] });
    const failure = results?.find(result => result.error); if (failure) throw new Error(String(failure.error));
    return { ready: true };
  }
  return { reloadRequired: true };
}
async function controller() {
  const state = await chrome.storage.local.get(['mainTabId', 'isRunning', PRIVATE + 'runBundle']);
  const candidates = [...clients].filter(c => c.ready && c.engine && (!state.isRunning || c.bundleId === state[PRIVATE + 'runBundle']?.id));
  const selected = candidates.find(c => c.sender.tab.id === state.mainTabId);
  return selected || (!state.isRunning ? candidates.at(-1) : null);
}
async function requestEngine(type, payload, preferred) {
  let target = preferred;
  for (let attempt = 0; !target && attempt < 60; attempt++) { target = await controller(); if (!target) await wait(200); }
  if (!target) throw new Error('도우미 메인 탭을 열고 새로고침해주세요.');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('도우미 응답 시간이 초과되었습니다.')); }, 35000);
    requests.set(id, { resolve, reject, timer, target });
    try { target.port.postMessage({ type, id, payload }); } catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
  });
}
async function rpc(message, sender) {
  const bundle = await validateContext(sender, message.bundleId), args = message.args || [];
  const active = await chrome.storage.local.get(['isRunning', PRIVATE + 'runBundle']);
  if (active.isRunning && active[PRIVATE + 'runBundle']?.id !== bundle.id &&
      !(message.method === 'STORAGE_SET' && args[0]?.isRunning === false)) {
    throw new Error('다른 버전으로 작업이 시작되었습니다. 이 페이지를 새로고침해주세요.');
  }
  switch (message.method) {
    case 'STORAGE_GET': return readApp(args[0]);
    case 'STORAGE_SET': {
      const values = appObject(args[0]);
      if (values.isRunning === true && values.runId) {
        if (!enginePage(sender)) throw new Error('메인 지니 페이지에서 시작해주세요.');
        await lock(() => chrome.storage.local.set({ ...values, mainTabId: sender.tab.id, [PRIVATE + 'runBundle']: bundle }));
      } else await chrome.storage.local.set(values);
      return null;
    }
    case 'STORAGE_CLEAR': return lock(async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter(k => !k.startsWith(PRIVATE)));
      await chrome.storage.local.set({ [PRIVATE + 'events']: [], [PRIVATE + 'runBundle']: null });
      return null;
    });
    case 'RUNTIME_SEND': {
      const msg = args[0];
      if (msg?.action === 'REGISTER_MAIN_TAB') {
        if (enginePage(sender)) {
          const current = await chrome.storage.local.get(['mainTabId', 'isRunning']);
          if (!current.isRunning && !current.mainTabId) await chrome.storage.local.set({ mainTabId: sender.tab.id });
        }
        return { status: 'ok' };
      }
      return requestEngine('BUSINESS_REQUEST', { message: msg, sender: { tab: { id: sender.tab.id }, frameId: sender.frameId, url: sender.url } });
    }
    case 'TABS_QUERY': return chrome.tabs.query({ url: '*://*.genie.co.kr/*' });
    case 'TABS_UPDATE': {
      const tab = await chrome.tabs.get(args[0]); if (!genieUrl(tab.url)) throw new Error('지니 탭만 변경할 수 있습니다.');
      if (args[1]?.url && !genieUrl(args[1].url)) throw new Error('지니 외부로 이동할 수 없습니다.');
      return chrome.tabs.update(args[0], { ...(args[1]?.url ? { url: args[1].url } : {}), ...(typeof args[1]?.active === 'boolean' ? { active: args[1].active } : {}) });
    }
    case 'TABS_REMOVE': { const tab = await chrome.tabs.get(args[0]); if (genieUrl(tab.url)) await chrome.tabs.remove(args[0]); return null; }
    case 'TABS_CREATE': { if (!genieUrl(args[0]?.url)) throw new Error('지니 주소만 열 수 있습니다.'); return chrome.tabs.create({ url: args[0].url }); }
    case 'FETCH': {
      const url = new URL(args[0]);
      if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !url.pathname.startsWith('/spreadsheets/')) throw new Error('등록된 시트 주소만 조회할 수 있습니다.');
      return fetchText(url.href, 10000);
    }
    default: throw new Error('지원되지 않는 실행기 요청입니다.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action !== 'GENIE_BOOTSTRAP') return false;
  bootstrap(sender).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message })); return true;
});
chrome.runtime.onUserScriptMessage?.addListener((message, sender, respond) => {
  const operation = message?.action === 'GENIE_GET_BUNDLE' ? bundleForDocument(sender) : message?.action === 'GENIE_RPC' ? rpc(message, sender) : Promise.reject(new Error('알 수 없는 실행기 요청입니다.'));
  operation.then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message })); return true;
});
chrome.runtime.onUserScriptConnect?.addListener(port => {
  if (port.name !== 'genie-runtime-v1') return;
  try { requireSender(port.sender); } catch { port.disconnect(); return; }
  const client = { port, sender: port.sender, ready: false, engine: false, bundleId: null }; clients.add(client);
  port.onMessage.addListener(message => {
    if (message.type === 'HELLO') {
      validateContext(client.sender, message.bundleId).then(async () => {
        client.bundleId = message.bundleId; client.engine = Boolean(message.engine && enginePage(client.sender)); client.ready = true;
        port.postMessage({ type: 'HELLO_OK' }); pumpEvents();
      }).catch(error => { port.postMessage({ type: 'FATAL', error: error.message }); });
    } else if (message.type === 'ENGINE_REPLY') {
      const pending = requests.get(message.id); if (!pending || pending.target !== client) return;
      requests.delete(message.id); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error || '작업 처리 오류'));
    }
  });
  port.onDisconnect.addListener(() => {
    clients.delete(client);
    for (const [id, pending] of requests) if (pending.target === client) { clearTimeout(pending.timer); requests.delete(id); pending.reject(new Error('페이지 연결이 변경되었습니다.')); }
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const visible = appObject(changes); if (!Object.keys(visible).length) return;
  for (const client of clients) if (client.ready) { try { client.port.postMessage({ type: 'STORAGE_CHANGED', changes: visible, area }); } catch {} }
});
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.genie.co.kr/*' });
  if (!tabs.length) { await chrome.tabs.create({ url: 'https://www.genie.co.kr/' }); return; }
  const state = await chrome.storage.local.get(['mainTabId']);
  const tab = tabs.find(t => t.id === state.mainTabId) || tabs[0]; await chrome.tabs.update(tab.id, { active: true });
  for (const c of clients) if (c.sender.tab.id === tab.id && c.sender.frameId === 0) c.port.postMessage({ type: 'UI_MESSAGE', message: { action: 'SHOW_REMOTE' } });
});
chrome.downloads.onCreated.addListener(item => {
  lock(async () => {
    const state = await chrome.storage.local.get(['isRunning', 'runId', 'currentIndex', 'songIndex', 'step', PRIVATE + 'events']);
    if (!state.isRunning || !['SONG_DOWNLOAD', 'PAY_POPUP_STEP1', 'WAIT_DOWNLOAD_STREAM'].includes(state.step)) return;
    const events = state[PRIVATE + 'events'] || [];
    const expected = { runId: state.runId, currentIndex: state.currentIndex || 0, songIndex: state.songIndex || 0 };
    if (events.some(e => JSON.stringify(e.expected) === JSON.stringify(expected))) return;
    events.push({ id: item.id, url: item.url, referrer: item.referrer, expected });
    await chrome.storage.local.set({ [PRIVATE + 'events']: events });
  }).then(pumpEvents).catch(console.error);
});
async function pumpEvents() {
  if (pumping) return; pumping = true;
  try {
    for (;;) {
      const state = await chrome.storage.local.get([PRIVATE + 'events', 'isRunning', 'runId', 'currentIndex', 'songIndex']);
      const item = state[PRIVATE + 'events']?.[0]; if (!item) return;
      const stale = !state.isRunning || state.runId !== item.expected.runId || (state.currentIndex || 0) !== item.expected.currentIndex || (state.songIndex || 0) !== item.expected.songIndex;
      if (!stale) {
        const selected = await controller(); if (!selected) return;
        await requestEngine('DOWNLOAD_EVENT', item, selected);
      }
      await lock(async () => { const current = await chrome.storage.local.get([PRIVATE + 'events']); await chrome.storage.local.set({ [PRIVATE + 'events']: (current[PRIVATE + 'events'] || []).filter(e => e.id !== item.id) }); });
    }
  } catch (error) { console.warn('Genie event retained for retry:', error.message); setTimeout(pumpEvents, 1500); }
  finally { pumping = false; }
}
chrome.runtime.onInstalled.addListener(() => { ensureRuntime().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureRuntime().catch(() => {}); pumpEvents(); });
