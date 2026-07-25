document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('btn-close-tab');
  if (!closeBtn) return;

  closeBtn.addEventListener('click', () => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.getCurrent) {
      window.close();
      return;
    }

    chrome.tabs.getCurrent((tab) => {
      if (chrome.runtime.lastError || tab?.id === undefined) {
        window.close();
        return;
      }

      chrome.tabs.remove(tab.id, () => {
        if (chrome.runtime.lastError) window.close();
      });
    });
  });
});
