import React, { useState, useEffect, useCallback, useRef } from "react";
import FlowchartViewer, { DiagramViews, NodeFileEntry } from "./FlowchartViewer";
import {
  getStoredKeys,
  saveStoredKeys,
  analyzeTarget,
  askChat,
  TechItem,
} from "./api";

// ── Types ───────────────────────────────────────────────────────────────────
interface SignalTelemetry {
  scriptsCount: number;
  apiCallsCount: number;
  domMarkersCount: number;
  storageKeysCount: number;
}

interface AnalysisData {
  mode: "website" | "github";
  projectSummary: string;
  techStack: TechItem[];
  workflowSteps: string[];
  diagrams: DiagramViews;
  mermaidCode?: string;
  diagramDataFlow?: string;
  diagramModuleMap?: string;
  nodeFileMap: NodeFileEntry[];
}

interface ChatMessageItem {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

type TabKey = "flowchart" | "techstack" | "workflow" | "chat";

const CATEGORY_COLORS: Record<string, string> = {
  Frontend: "#10b981", // Emerald
  Backend: "#3b82f6",  // Blue
  Database: "#8b5cf6", // Purple
  DevOps: "#f59e0b",   // Amber
  Testing: "#ec4899",  // Pink
  Auth: "#ef4444",     // Red
  API: "#06b6d4",      // Cyan
  Styling: "#14b8a6",  // Teal
  Build: "#eab308",    // Yellow
  Other: "#71717a",    // Zinc
};

const SUGGESTED_QUESTIONS = [
  "How does data flow between components?",
  "Where is authentication handled?",
  "What external APIs and databases are connected?",
  "How are state and routing managed?",
];

function detectMode(url: string): "github" | "website" {
  return url.includes("github.com") ? "github" : "website";
}

function extractGitHubBase(url: string): string | null {
  const match = url.match(/https?:\/\/github\.com\/([^/]+)\/([^/\s#?]+)/);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;
  return null;
}

export default function App() {
  const [activeUrl, setActiveUrl] = useState("");
  const [mode, setMode] = useState<"github" | "website">("website");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("flowchart");
  const [telemetry, setTelemetry] = useState<SignalTelemetry | null>(null);

  // Key management state
  const [geminiKey, setGeminiKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [githubTokenInput, setGithubTokenInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Load keys on startup
  useEffect(() => {
    async function loadKeys() {
      const keys = await getStoredKeys();
      setGeminiKey(keys.geminiKey);
      setGithubToken(keys.githubToken);
      setGeminiKeyInput(keys.geminiKey);
      setGithubTokenInput(keys.githubToken);

      // Auto-open settings drawer if Gemini API key is missing
      if (!keys.geminiKey) {
        setShowSettings(true);
      }
    }
    loadKeys();
  }, []);

  // ── Listen for active tab updates ─────────────────────────────────────────
  const updateActiveTab = useCallback(() => {
    if (typeof chrome !== "undefined" && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = tabs?.[0]?.url || "";
        setActiveUrl(url);
        setMode(detectMode(url));
      });
    }
  }, []);

  useEffect(() => {
    updateActiveTab();

    if (typeof chrome !== "undefined" && chrome.tabs) {
      const onActivated = () => updateActiveTab();
      const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (changeInfo.url || changeInfo.status === "complete") {
          updateActiveTab();
        }
      };
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated.addListener(onUpdated);
      return () => {
        chrome.tabs.onActivated.removeListener(onActivated);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      };
    }
  }, [updateActiveTab]);

  // Scroll chat to bottom
  useEffect(() => {
    if (activeTab === "chat") {
      chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, activeTab, chatLoading]);

  // ── Save Credentials ──────────────────────────────────────────────────────
  const handleSaveSettings = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    await saveStoredKeys(geminiKeyInput, githubTokenInput);
    setGeminiKey(geminiKeyInput.trim());
    setGithubToken(githubTokenInput.trim());
    setSettingsSaved(true);
    setTimeout(() => {
      setSettingsSaved(false);
      setShowSettings(false);
    }, 700);
  };

  // ── Standalone Live Scraper & Gemini Analysis ─────────────────────────────
  const handleAnalyze = async () => {
    if (!geminiKey) {
      setShowSettings(true);
      setError("Please save your Gemini API Key in Settings to continue.");
      return;
    }

    setLoading(true);
    setError(null);

    // Live DOM & Network scraper executed directly in tab
    function scrapeLivePage() {
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute("content") ||
        document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
        "";

      const scripts = Array.from(
        document.querySelectorAll<HTMLScriptElement>("script[src]")
      )
        .map((s) => s.getAttribute("src") || s.src)
        .filter(Boolean)
        .slice(0, 35);

      const stylesheets = Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
      )
        .map((l) => l.getAttribute("href") || l.href)
        .filter(Boolean)
        .slice(0, 15);

      const customElements = Array.from(document.querySelectorAll("*"))
        .map((el) => el.tagName.toLowerCase())
        .filter((tag) => tag.includes("-"))
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 15);

      const frameworkMarkers = {
        nextjs:
          !!document.getElementById("__NEXT_DATA__") ||
          !!document.querySelector("#__next"),
        vite: !!document.querySelector('script[src*="@vite/client"]'),
        react:
          !!document.querySelector('[data-reactroot], #root, [id*="react"]') ||
          !!document.querySelector('script[src*="react-refresh"]'),
        vue: !!document.querySelector("[data-v-app], #app[data-v]"),
        angular: !!document.querySelector("[ng-version]"),
        customElements,
      };

      let apiCalls: string[] = [];
      let externalDomains: string[] = [];
      try {
        const resourceEntries = performance.getEntriesByType(
          "resource"
        ) as PerformanceResourceTiming[];
        apiCalls = resourceEntries
          .filter(
            (entry) =>
              entry.initiatorType === "fetch" ||
              entry.initiatorType === "xmlhttprequest"
          )
          .map((entry) => entry.name)
          .slice(0, 25);

        const currentHost = window.location.hostname;
        externalDomains = Array.from(
          new Set(
            resourceEntries
              .map((entry) => {
                try {
                  return new URL(entry.name).hostname;
                } catch {
                  return "";
                }
              })
              .filter((h) => h && h !== currentHost)
          )
        ).slice(0, 25);
      } catch {}

      let localKeys: string[] = [];
      let sessionKeys: string[] = [];
      try {
        localKeys = Object.keys(localStorage).slice(0, 20);
      } catch {}
      try {
        sessionKeys = Object.keys(sessionStorage).slice(0, 15);
      } catch {}

      const githubFiles = Array.from(
        document.querySelectorAll(
          ".react-directory-row-name-cell-large-screen a, .js-navigation-open"
        )
      )
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .slice(0, 40) as string[];

      const githubReadme =
        document.querySelector("article.markdown-body")?.textContent?.slice(0, 2000) || "";

      return {
        pageTitle: document.title,
        metaDescription: metaDesc,
        scripts,
        stylesheets,
        frameworkMarkers,
        networkCalls: {
          apiCalls,
          externalDomains,
        },
        storageKeys: {
          localStorage: localKeys,
          sessionStorage: sessionKeys,
        },
        githubFiles,
        githubReadme,
      };
    }

    try {
      let tabUrl = activeUrl;
      let tabId: number | undefined;

      if (typeof chrome !== "undefined" && chrome.tabs) {
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
          [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        }
        if (tab?.url) tabUrl = tab.url;
        if (tab?.id) tabId = tab.id;
      }

      if (!tabUrl) {
        throw new Error("No active tab URL found.");
      }

      let siteSignals: any = null;
      const currentMode = tabUrl.includes("github.com") ? "github" : "website";

      // Execute live DOM scraper directly in active tab
      if (typeof chrome !== "undefined" && chrome.scripting && tabId) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: scrapeLivePage,
          });
          siteSignals = results?.[0]?.result || null;
        } catch (scriptErr) {
          console.warn("[XRay Flow] Live executeScript notice:", scriptErr);
          siteSignals = null;
        }
      }

      // Update signal telemetry counts for UI badge
      if (siteSignals && typeof siteSignals === "object") {
        const scriptsCount = Array.isArray(siteSignals.scripts)
          ? siteSignals.scripts.length
          : 0;
        const apiCallsCount = Array.isArray(siteSignals.networkCalls?.apiCalls)
          ? siteSignals.networkCalls.apiCalls.length
          : 0;
        let domMarkersCount = 0;
        if (siteSignals.frameworkMarkers) {
          if (siteSignals.frameworkMarkers.nextjs) domMarkersCount++;
          if (siteSignals.frameworkMarkers.vite) domMarkersCount++;
          if (siteSignals.frameworkMarkers.react) domMarkersCount++;
          if (siteSignals.frameworkMarkers.vue) domMarkersCount++;
          if (siteSignals.frameworkMarkers.angular) domMarkersCount++;
          if (Array.isArray(siteSignals.frameworkMarkers.customElements)) {
            domMarkersCount += siteSignals.frameworkMarkers.customElements.length;
          }
        }
        if (
          Array.isArray(siteSignals.githubFiles) &&
          siteSignals.githubFiles.length > 0
        ) {
          domMarkersCount += siteSignals.githubFiles.length;
        }
        const storageKeysCount =
          (Array.isArray(siteSignals.storageKeys?.localStorage)
            ? siteSignals.storageKeys.localStorage.length
            : 0) +
          (Array.isArray(siteSignals.storageKeys?.sessionStorage)
            ? siteSignals.storageKeys.sessionStorage.length
            : 0);

        setTelemetry({
          scriptsCount,
          apiCallsCount,
          domMarkersCount,
          storageKeysCount,
        });
      } else {
        setTelemetry(null);
      }

      // Directly invoke standalone Gemini REST engine
      const result = await analyzeTarget({
        url: tabUrl,
        mode: currentMode,
        siteSignals,
        geminiKey: geminiKey.trim(),
        githubToken: githubToken.trim() || undefined,
      });

      const formattedData: AnalysisData = {
        mode: result.mode,
        projectSummary: result.projectSummary,
        techStack: result.techStack,
        workflowSteps: result.workflowSteps,
        mermaidCode: result.mermaidCode,
        diagramDataFlow: result.diagramDataFlow,
        diagramModuleMap: result.diagramModuleMap,
        diagrams: {
          architecture: result.mermaidCode,
          dataFlow: result.diagramDataFlow || result.mermaidCode,
          moduleMap: result.diagramModuleMap || result.mermaidCode,
        },
        nodeFileMap: result.nodeFileMap || [],
      };

      setData(formattedData);
      setActiveTab("flowchart");

      setChatMessages([
        {
          role: "assistant",
          content: `**${
            result.mode === "github" ? "GitHub Repository" : "Web Application"
          } Architecture Analyzed**\n\n${
            result.projectSummary
          }\n\nYou can ask questions about components, execution paths, security considerations, or file locations.`,
        },
      ]);
    } catch (err: any) {
      console.error("[XRay Flow] Analyze Error:", err);
      setError(err?.message || "An error occurred during analysis.");
    } finally {
      setLoading(false);
    }
  };

  // ── Send Chat Message (Standalone Direct Gemini) ──────────────────────────
  const handleSendMessage = async (customMessage?: string) => {
    const messageToSend = customMessage || chatInput.trim();
    if (!messageToSend || !activeUrl || chatLoading) return;

    if (!geminiKey) {
      setShowSettings(true);
      setError("Please save your Gemini API Key in Settings to chat.");
      return;
    }

    const userMsg: ChatMessageItem = {
      role: "user",
      content: messageToSend,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    const nextMessages = [...chatMessages, userMsg];
    setChatMessages(nextMessages);
    if (!customMessage) setChatInput("");
    setChatLoading(true);

    try {
      const chatRes = await askChat({
        url: activeUrl,
        mode,
        question: messageToSend,
        history: nextMessages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          content: m.content,
        })),
        geminiKey: geminiKey.trim(),
      });

      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: chatRes.answer,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      ]);
    } catch (err: any) {
      console.error("[XRay Flow] Chat Error:", err);
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `⚠️ Failed to get answer: ${err?.message || "Gemini API error"}`,
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: "flowchart", label: "Diagrams" },
    { key: "techstack", label: "Tech Stack" },
    { key: "workflow", label: "Workflow" },
    { key: "chat", label: "Ask XRay" },
  ];

  return (
    <div className="min-h-screen bg-[#09090b] text-[#f4f4f5] p-3 flex flex-col gap-2.5 antialiased">
      {/* ── Precision Header Bar ───────────────────────────────────────────── */}
      <header className="flex items-center justify-between pb-1 border-b border-[#27272a]">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-[#18181b] border border-[#3f3f46] flex items-center justify-center font-mono font-bold text-xs text-white">
            X
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold tracking-tight text-[#f4f4f5]">
                XRay Flow
              </span>
              <span className="text-[10px] font-mono text-zinc-500">v1.2</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Status Dot */}
          <div
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#121215] border border-[#27272a]"
            title={geminiKey ? "Gemini Engine Ready" : "API Key Required"}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                geminiKey ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
              }`}
            />
            <span className="text-zinc-400">
              {geminiKey ? "STANDALONE" : "KEY NEEDED"}
            </span>
          </div>

          {/* Mode Badge */}
          <span className="dev-badge bg-[#18181b] border border-[#27272a] text-zinc-300">
            {mode === "github" ? "GITHUB" : "DOM"}
          </span>

          {/* Settings Drawer Button */}
          <button
            onClick={() => setShowSettings((p) => !p)}
            className={`w-7 h-7 rounded flex items-center justify-center transition-colors border ${
              showSettings
                ? "bg-[#27272a] border-zinc-600 text-white"
                : "bg-[#121215] border-[#27272a] text-zinc-400 hover:text-zinc-200 hover:bg-[#18181b]"
            }`}
            title="API Credentials & Settings"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Settings / API Key Drawer ──────────────────────────────────────── */}
      {showSettings && (
        <form
          onSubmit={handleSaveSettings}
          className="p-3 bg-[#121215] border border-[#27272a] rounded-md flex flex-col gap-2.5 animate-in fade-in duration-150"
        >
          <div className="flex items-center justify-between pb-1 border-b border-[#27272a]">
            <span className="text-xs font-semibold text-[#f4f4f5]">
              API Credentials
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">
              Stored locally in browser
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-zinc-300 font-medium">
                Gemini API Key <span className="text-red-400">*</span>
              </label>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-zinc-400 hover:text-white underline font-mono"
              >
                Get free key ↗
              </a>
            </div>
            <input
              type="password"
              value={geminiKeyInput}
              onChange={(e) => setGeminiKeyInput(e.target.value)}
              placeholder="AIzaSy..."
              className="bg-[#09090b] border border-[#27272a] rounded px-2.5 py-1.5 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-zinc-400">
              GitHub Token <span className="text-zinc-600">(Optional)</span>
            </label>
            <input
              type="password"
              value={githubTokenInput}
              onChange={(e) => setGithubTokenInput(e.target.value)}
              placeholder="ghp_... (prevents 60 req/hr rate limits)"
              className="bg-[#09090b] border border-[#27272a] rounded px-2.5 py-1.5 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-zinc-500 font-mono">
              {geminiKey ? "Key configured" : "Required for analysis"}
            </span>
            <button
              type="submit"
              className="dev-btn-primary"
            >
              {settingsSaved ? "Saved ✓" : "Save Credentials"}
            </button>
          </div>
        </form>
      )}

      {/* ── Active Target Bar ──────────────────────────────────────────────── */}
      <div className="dev-card p-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] text-zinc-500 font-mono uppercase shrink-0">
            Target
          </span>
          <p
            className="text-xs text-zinc-300 truncate font-mono"
            title={activeUrl}
          >
            {activeUrl || "No active tab detected"}
          </p>
        </div>
        {activeUrl && (
          <button
            onClick={() => {
              if (typeof chrome !== "undefined" && chrome.tabs) {
                chrome.tabs.create({ url: activeUrl });
              } else {
                window.open(activeUrl, "_blank");
              }
            }}
            className="text-zinc-500 hover:text-zinc-300 p-0.5"
            title="Open tab in new window"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Primary Action Button ──────────────────────────────────────────── */}
      <button
        onClick={handleAnalyze}
        disabled={loading}
        className="dev-btn-primary w-full h-8 font-medium text-xs justify-center"
      >
        {loading ? (
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 border-2 border-zinc-500 border-t-zinc-950 rounded-full animate-spin" />
            Analyzing with Gemini…
          </span>
        ) : (
          "Scan Workflow & Tech Stack"
        )}
      </button>

      {/* ── Error Banner ───────────────────────────────────────────────────── */}
      {error && (
        <div className="p-2.5 bg-[#121215] border border-red-900/60 rounded-md flex flex-col gap-1">
          <span className="text-xs text-red-400 font-medium">Notice</span>
          <p className="text-[11px] text-zinc-400">{error}</p>
        </div>
      )}

      {/* ── Loading Skeleton ───────────────────────────────────────────────── */}
      {loading && (
        <div className="flex flex-col gap-2">
          <div className="dev-skeleton h-6 w-full" />
          <div className="dev-skeleton h-64 w-full" />
          <div className="dev-skeleton h-20 w-full" />
        </div>
      )}

      {/* ── Analysis Content ───────────────────────────────────────────────── */}
      {data && !loading && (
        <div className="flex flex-col gap-2.5">
          {/* Architecture Summary */}
          <div className="dev-card p-3">
            <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[#27272a]">
              <span className="text-xs font-semibold text-[#f4f4f5]">
                Architecture Overview
              </span>
              <span className="text-[10px] text-zinc-500 font-mono uppercase">
                {data.mode}
              </span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {data.projectSummary}
            </p>
          </div>

          {/* Telemetry Indicator */}
          {telemetry && (
            <div className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-[#121215] border border-[#27272a] text-[10px] font-mono text-zinc-400">
              <span className="text-zinc-500">SIGNALS</span>
              <div className="flex items-center gap-2 text-zinc-300">
                <span>{telemetry.scriptsCount} scripts</span>
                <span>·</span>
                <span>{telemetry.apiCallsCount} api</span>
                <span>·</span>
                <span>{telemetry.domMarkersCount} markers</span>
                {telemetry.storageKeysCount > 0 && (
                  <>
                    <span>·</span>
                    <span>{telemetry.storageKeysCount} storage</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Tab Strip */}
          <div className="grid grid-cols-4 gap-1 bg-[#121215] p-1 rounded-md border border-[#27272a]">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`py-1 px-1.5 rounded text-xs font-medium transition-colors truncate ${
                  activeTab === tab.key
                    ? "bg-[#27272a] text-[#f4f4f5] shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Active Tab View ────────────────────────────────────────────── */}
          <div className="min-h-[220px]">
            {/* 1. Flowchart Tab */}
            {activeTab === "flowchart" && (
              <FlowchartViewer
                diagrams={data.diagrams}
                chartCode={data.mermaidCode}
                nodeFileMap={data.nodeFileMap}
                githubBaseUrl={extractGitHubBase(activeUrl)}
                mode={data.mode}
              />
            )}

            {/* 2. Tech Stack Tab */}
            {activeTab === "techstack" && (
              <div className="flex flex-col gap-1.5">
                {data.techStack.map((tech, i) => (
                  <div
                    key={i}
                    className="dev-card p-2.5 flex items-start gap-2.5 hover:border-zinc-700 transition-colors"
                  >
                    <div
                      className="w-1.5 h-1.5 rounded-full mt-2 shrink-0"
                      style={{
                        backgroundColor:
                          CATEGORY_COLORS[tech.category] || CATEGORY_COLORS.Other,
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-xs font-semibold text-[#f4f4f5]">
                          {tech.name}
                        </span>
                        <span
                          className="dev-badge"
                          style={{
                            color:
                              CATEGORY_COLORS[tech.category] ||
                              CATEGORY_COLORS.Other,
                            backgroundColor: `${
                              CATEGORY_COLORS[tech.category] || CATEGORY_COLORS.Other
                            }14`,
                            border: `1px solid ${
                              CATEGORY_COLORS[tech.category] || CATEGORY_COLORS.Other
                            }30`,
                          }}
                        >
                          {tech.category}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 mb-1.5 leading-relaxed">
                        {tech.purpose}
                      </p>
                      <div className="dev-card px-2 py-0.5 text-[10px] font-mono text-zinc-400 inline-flex items-center gap-1 max-w-full break-all">
                        <span className="text-zinc-500">proof:</span>
                        <span className="text-zinc-300">
                          {tech.evidence || "Observed in page signals"}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 3. Workflow Tab */}
            {activeTab === "workflow" && (
              <div className="flex flex-col gap-1.5">
                {data.workflowSteps.map((step, i) => (
                  <div
                    key={i}
                    className="dev-card p-2.5 flex items-start gap-2.5 hover:border-zinc-700 transition-colors"
                  >
                    <div className="w-5 h-5 rounded bg-[#18181b] border border-[#27272a] flex items-center justify-center text-zinc-400 text-[10px] font-mono font-bold shrink-0">
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed pt-0.5">
                      {step}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* 4. Ask XRay (Chat) Tab */}
            {activeTab === "chat" && (
              <div className="flex flex-col gap-2">
                {/* Scroll Area */}
                <div className="dev-card p-2.5 flex flex-col gap-2.5 h-[340px] overflow-y-auto">
                  {chatMessages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center p-4 text-zinc-500 gap-1.5">
                      <span className="text-xs font-semibold text-zinc-400">
                        Architect Assistant
                      </span>
                      <p className="text-[11px] text-zinc-500">
                        Ask about component responsibilities, API endpoints, or data flows.
                      </p>
                    </div>
                  )}

                  {chatMessages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`flex flex-col max-w-[90%] ${
                        msg.role === "user" ? "ml-auto items-end" : "mr-auto items-start"
                      }`}
                    >
                      <div
                        className={`p-2.5 rounded text-xs leading-relaxed ${
                          msg.role === "user"
                            ? "bg-[#27272a] text-[#f4f4f5] border border-zinc-700"
                            : "bg-[#18181b] text-zinc-300 border border-[#27272a]"
                        }`}
                      >
                        <div className="whitespace-pre-wrap break-words font-sans">
                          {msg.content}
                        </div>
                      </div>
                      {msg.timestamp && (
                        <span className="text-[9px] text-zinc-600 mt-0.5 px-1 font-mono">
                          {msg.timestamp}
                        </span>
                      )}
                    </div>
                  ))}

                  {chatLoading && (
                    <div className="mr-auto flex items-center gap-1.5 p-2 bg-[#18181b] rounded text-xs text-zinc-400 border border-[#27272a]">
                      <span className="w-2.5 h-2.5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
                      Architect is thinking…
                    </div>
                  )}

                  <div ref={chatBottomRef} />
                </div>

                {/* Question Chips */}
                <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-none">
                  {SUGGESTED_QUESTIONS.map((q, i) => (
                    <button
                      key={i}
                      disabled={chatLoading}
                      onClick={() => handleSendMessage(q)}
                      className="text-[10px] bg-[#121215] text-zinc-400 hover:text-white hover:bg-[#18181b] px-2 py-1 rounded border border-[#27272a] whitespace-nowrap transition-colors font-mono shrink-0"
                    >
                      {q}
                    </button>
                  ))}
                </div>

                {/* Input Field */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendMessage();
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask about data flow, files, API..."
                    disabled={chatLoading}
                    className="flex-1 bg-[#121215] border border-[#27272a] rounded px-3 py-1.5 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-sans"
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || chatLoading}
                    className="dev-btn-primary h-8 px-3"
                  >
                    Send
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="mt-auto pt-2 border-t border-[#27272a] flex items-center justify-between text-[10px] text-zinc-600 font-mono">
        <span>XRay Flow · Serverless</span>
        <span>Gemini Flash Direct</span>
      </footer>
    </div>
  );
}
