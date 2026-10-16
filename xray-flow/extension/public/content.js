/* Content script for XRay Flow — extracts site signals from the active page */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "EXTRACT_SITE_SIGNALS") return false;

  try {
    // 1. Collect script[src] URLs (up to 30)
    const scriptSrcs = Array.from(document.querySelectorAll("script[src]"))
      .slice(0, 30)
      .map((el) => el.getAttribute("src") || "");

    // 2. Collect meta tags (up to 20)
    const metaTags = Array.from(document.querySelectorAll("meta"))
      .slice(0, 20)
      .map((el) => ({
        name: el.getAttribute("name") || el.getAttribute("property") || "",
        content: el.getAttribute("content") || "",
      }));

    // 3. External resource domains from Performance API
    let resourceDomains = [];
    try {
      const entries = performance.getEntriesByType("resource");
      const hostSet = new Set();
      entries.forEach((entry) => {
        try {
          const url = new URL(entry.name);
          if (url.hostname !== location.hostname) {
            hostSet.add(url.hostname);
          }
        } catch (_) {
          /* skip malformed */
        }
      });
      resourceDomains = Array.from(hostSet).slice(0, 50);
    } catch (_) {
      /* Performance API not available */
    }

    // 4. Framework detection flags
    const frameworkFlags = {
      hasNextData: !!document.getElementById("__NEXT_DATA__"),
      hasNuxt: "__NUXT__" in window,
      hasReactRoot: !!document.querySelector("[data-reactroot]"),
      hasRootDiv: !!document.getElementById("root"),
      hasAppDiv: !!document.getElementById("app"),
      metaGenerator:
        document
          .querySelector('meta[name="generator"]')
          ?.getAttribute("content") || null,
    };

    sendResponse({
      success: true,
      signals: {
        scriptSrcs,
        metaTags,
        resourceDomains,
        frameworkFlags,
        pageTitle: document.title,
        url: location.href,
      },
    });
  } catch (err) {
    sendResponse({ success: false, error: String(err) });
  }

  return true; // keep the message channel open for async sendResponse
});
