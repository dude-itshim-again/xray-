/* Background service worker for XRay Flow Chrome Extension */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(() => {
  console.log("[XRay Flow] Extension installed.");
});
