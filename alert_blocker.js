(function() {
  window.alert = function(msg) {
    console.log("[Genie Helper - Alert Blocked]:", msg);
    return true;
  };
  window.confirm = function(msg) {
    console.log("[Genie Helper - Confirm Blocked]:", msg);
    return true;
  };

  // content.js에서 지니 페이지 전역 함수를 안전하게 실행하기 위한 브릿지
  window.addEventListener('GENIE_CALL_PAGE_FN', function(e) {
    const { fnName, args } = e.detail || {};
    if (fnName && typeof window[fnName] === 'function') {
      try {
        window[fnName].apply(window, args || []);
      } catch (err) {
        console.warn("[Genie Helper - Page Function Error]:", err);
      }
    }
  });
})();