(() => {
  if (globalThis.__genieRuntimeStarted) return;
  globalThis.__genieRuntimeStarted = true;
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  const connectNative = chrome.runtime.connect.bind(chrome.runtime);
  const storageListeners = [], uiListeners = [], businessListeners = [], downloadListeners = [];
  const inFlightDownloads = new Map();
  let bundle, port, closed = false;
  function showError(error) {
    if (window !== window.top) return;
    const show = () => {
      if (!document.documentElement) { setTimeout(show, 100); return; }
      let box = document.getElementById('genie-loader-error');
      if (!box) { box = document.createElement('div'); box.id = 'genie-loader-error'; document.documentElement.appendChild(box); }
      box.style.cssText = 'position:fixed;top:15px;left:15px;right:15px;z-index:2147483647;padding:12px;background:white;color:#a00000;border:2px solid #a00000;font:14px sans-serif;';
      box.textContent = '지니 도우미: ' + error.message + ' · 작업을 중단하고 새로고침해주세요.';
    }; show();
  }
  async function call(method, ...args) {
    const response = await send({ action: 'GENIE_RPC', bundleId: bundle.id, method, args });
    if (!response?.ok) throw new Error(response?.error || '실행기 응답이 없습니다.');
    return response.value;
  }
  const storage = {
    local: { get: keys => call('STORAGE_GET', keys ?? null), set: values => call('STORAGE_SET', values), clear: () => call('STORAGE_CLEAR') },
    onChanged: { addListener: fn => storageListeners.push(fn) }
  };
  const tabs = {
    query: query => call('TABS_QUERY', query), update: (id, values) => call('TABS_UPDATE', id, values),
    remove: id => call('TABS_REMOVE', id), create: values => call('TABS_CREATE', values),
    sendMessage: async (id, message) => { for (const listener of uiListeners) listener(message); }
  };
  const contentChrome = { storage, tabs, runtime: { sendMessage: message => call('RUNTIME_SEND', message), onMessage: { addListener: fn => uiListeners.push(fn) } } };
  const engineChrome = {
    storage, tabs, action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener: fn => businessListeners.push(fn) } },
    downloads: { onCreated: { addListener: fn => downloadListeners.push(fn) } }
  };
  async function remoteFetch(url,options={}) {
    const response = String(url).startsWith('https://script.google.com/') ? await call('APPS_SCRIPT_FETCH',String(url),options.body) : await call('FETCH', String(url));
    return { ok: response.ok, status: response.status, text: async () => response.body, json: async () => JSON.parse(response.body) };
  }
  function business(message, sender) {
    return new Promise((resolve, reject) => {
      let done = false;
      const respond = value => { if (!done) { done = true; resolve(value); } };
      try {
        if (!businessListeners.length) throw new Error('메인 작업 엔진이 준비되지 않았습니다.');
        for (const listener of businessListeners) {
          const result = listener(message, sender, respond);
          if (result?.then) result.then(value => { if (value !== undefined) respond(value); }, reject);
          else if (result !== true && result !== undefined && result !== false) respond(result);
        }
      } catch (error) { reject(error); }
    });
  }
  function connect(isEngine) {
    return new Promise((resolve, reject) => {
      const connection = connectNative({ name: 'genie-runtime-v1' }); port = connection;
      const helloTimer = setTimeout(() => reject(new Error('실행기 연결 시간이 초과되었습니다.')), 12000);
      connection.onMessage.addListener(message => {
        if (message.type === 'HELLO_OK') { clearTimeout(helloTimer); resolve(); return; }
        if (message.type === 'FATAL') { clearTimeout(helloTimer); const error = new Error(message.error); reject(error); showError(error); return; }
        if (message.type === 'STORAGE_CHANGED') { for (const listener of storageListeners) Promise.resolve(listener(message.changes, message.area)).catch(showError); return; }
        if (message.type === 'UI_MESSAGE') { for (const listener of uiListeners) Promise.resolve(listener(message.message)).catch(showError); return; }
        let result;
        if (message.type === 'BUSINESS_REQUEST') result = business(message.payload.message, message.payload.sender);
        else if (message.type === 'DOWNLOAD_EVENT') {
          const event = message.payload;
          result = inFlightDownloads.get(event.id);
          if (!result) {
            result = Promise.all(downloadListeners.map(listener => listener(event)));
            inFlightDownloads.set(event.id, result);
            result.finally(() => inFlightDownloads.delete(event.id)).catch(() => {});
          }
        } else return;
        Promise.resolve(result).then(
          value => { try { connection.postMessage({ type: 'ENGINE_REPLY', id: message.id, ok: true, value }); } catch {} },
          error => { try { connection.postMessage({ type: 'ENGINE_REPLY', id: message.id, ok: false, error: error.message }); } catch {} }
        );
      });
      connection.onDisconnect.addListener(() => {
        clearTimeout(helloTimer);
        reject(new Error('실행기 연결이 끊어졌습니다.'));
        if (!closed) setTimeout(() => connect(isEngine).catch(showError), 1000);
      });
      connection.postMessage({ type: 'HELLO', bundleId: bundle.id, engine: isEngine });
    });
  }
  window.addEventListener('pagehide', () => { closed = true; try { port?.disconnect(); } catch {} }, { once: true });
  (async () => {
    const reply = await send({ action: 'GENIE_GET_BUNDLE' });
    if (!reply?.ok) throw new Error(reply?.error || '최신 작업 코드를 읽지 못했습니다.');
    bundle = reply.value;
    const isEngine = window === window.top;
    if (isEngine) new Function('chrome', 'fetch', bundle.engine + '\n//# sourceURL=genie-engine-' + bundle.version + '.js')(engineChrome, remoteFetch);
    await connect(isEngine);
    globalThis.__genieRuntimeVersion = bundle.version;
    if (document.documentElement) document.documentElement.setAttribute('data-genie-runtime-version', bundle.version);
    document.getElementById('genie-loader-error')?.remove();
    new Function('chrome', bundle.content + '\n//# sourceURL=genie-content-' + bundle.version + '.js')(contentChrome);
  })().catch(showError);
})();
