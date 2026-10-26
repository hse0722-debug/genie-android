(() => {
  if (globalThis.__genieBootstrapRequested) return;
  globalThis.__genieBootstrapRequested = true;
  chrome.runtime.sendMessage({ action: 'GENIE_BOOTSTRAP' }).then(response => {
    if (!response?.ok) throw new Error(response?.error || '실행기 응답이 없습니다.');
    if (response.value?.reloadRequired && window === window.top && !document.documentElement?.hasAttribute('data-genie-runtime-version')) {
      show('초기 설정이 완료되었습니다. 이 페이지를 한 번 새로고침해주세요.');
    }
  }).catch(error => show(error.message + ' · 확장 세부정보에서 사용자 스크립트 허용을 켠 뒤 확장 프로그램과 지니 페이지를 새로고침해주세요.'));
  function show(text) {
    if (window !== window.top) return;
    const add = () => {
      if (!document.documentElement) { setTimeout(add, 100); return; }
      let box = document.getElementById('genie-loader-error');
      if (!box) { box = document.createElement('div'); box.id = 'genie-loader-error'; document.documentElement.appendChild(box); }
      box.style.cssText = 'position:fixed;top:15px;left:15px;right:15px;z-index:2147483647;padding:12px;background:white;color:#a00000;border:2px solid #a00000;font:14px sans-serif;';
      box.textContent = text;
    }; add();
  }
})();
