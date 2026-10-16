import { useState, useEffect, useCallback, useRef } from "react";
import FlowchartViewer, { DiagramViews } from "./FlowchartViewer";

// ── Types ───────────────────────────────────────────────────────────────────
interface TechItem {
  name: string;
  category: string;
  purpose: string;
}

interface NodeFileEntry {
  nodeId: string;
  filePath: string;
}

interface AnalysisData {
  mode: string;
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

const API_BASE = "http://127.0.0.1:8000";

const CATEGORY_COLORS: Record<string, string> = {
  Frontend: "#3fb950",
  Backend: "#58a6ff",
  Database: "#d2a8ff",
  DevOps: "#f0883e",
  Testing: "#f778ba",
  Auth: "#ff7b72",
  API: "#79c0ff",
  Styling: "#56d364",
  Build: "#e3b341",
  Other: "#8b949e",
};

const SUGGESTED_QUESTIONS = [
  "Where is authentication handled in this project?",
  "Explain the end-to-end data flow on user actions",
  "What external APIs and databases are connected?",
  "How are state and routing managed?",
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function detectMode(url: string): "github" | "website" {
  return url.includes("github.com") ? "github" : "website";
}

function extractGitHubBase(url: string): string | null {
  const match = url.match(/https?:\/\/github\.com\/([^/]+)\/([^/\s#?]+)/);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;
  return null;
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
  const [activeUrl, setActiveUrl] = useState("");
  const [mode, setMode] = useState<"github" | "website">("website");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("flowchart");

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // ── Listen for active tab changes ──────────────────────────────────────
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

  // Scroll chat to bottom when messages update
  useEffect(() => {
    if (activeTab === "chat") {
      chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, activeTab, chatLoading]);

  // ── Extract site signals from content script ───────────────────────────
  const extractSiteSignals = (): Promise<Record<string, unknown> | null> => {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.tabs) {
        resolve(null);
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          resolve(null);
          return;
        }
        chrome.tabs.sendMessage(
          tabId,
          { type: "EXTRACT_SITE_SIGNALS" },
          (response) => {
            if (chrome.runtime.lastError || !response?.success) {
              resolve(null);
            } else {
              resolve(response.signals);
            }
          }
        );
      });
    });
  };

  // ── Scan / Analyze handler with Aggressive Step-by-Step Logging ────────
  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    console.log("1. Button clicked, starting analysis...");

    try {
      // Test connection first
      console.log("2. Testing connection to backend...");
      const pingRes = await fetch(`${API_BASE}/ping`).catch((e) => {
        console.error("PING FAILED:", e);
        throw new Error("Cannot connect to backend server at 127.0.0.1:8000. Is it running?");
      });
      console.log("3. Backend is reachable!", await pingRes.json());

      let tabUrl = activeUrl;
      let tabId: number | undefined;

      if (typeof chrome !== "undefined" && chrome.tabs) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) tabUrl = tab.url;
        if (tab?.id) tabId = tab.id;
      }

      if (!tabUrl) throw new Error("No active tab URL found");
      console.log("4. Found active tab:", tabUrl);

      let siteSignals: any = null;
      const currentMode = tabUrl.includes("github.com") ? "github" : "website";

      if (currentMode === "website" && typeof chrome !== "undefined" && chrome.tabs && tabId) {
        console.log("5. Attempting to contact content script...");
        siteSignals = await chrome.tabs
          .sendMessage(tabId, {
            type: "EXTRACT_SITE_SIGNALS",
          })
          .catch((err) => {
            console.warn("Content script warning:", err);
            return { note: "Content script fallback" };
          });
        console.log("6. Content script signals retrieved.");
      }

      console.log("7. Sending data to /analyze endpoint...");
      const res = await fetch(`${API_BASE}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: tabUrl,
          mode: currentMode,
          siteSignals,
        }),
      });

      console.log("8. Received response from /analyze. Status:", res.status);
      if (!res.ok) {
        const errorText = await res.text();
        console.error("Backend Error Response:", errorText);
        throw new Error(`Backend error ${res.status}: ${errorText}`);
      }

      const result: any = await res.json();
      console.log("9. Success! Updating UI.", result);

      const formattedData: AnalysisData = {
        mode: result.mode || currentMode,
        projectSummary: result.projectSummary || "",
        techStack: result.techStack || [],
        workflowSteps: result.workflowSteps || [],
        mermaidCode: result.mermaidCode || "",
        diagramDataFlow: result.diagramDataFlow,
        diagramModuleMap: result.diagramModuleMap,
        diagrams: {
          architecture: result.mermaidCode || "",
          dataFlow: result.diagramDataFlow || result.mermaidCode || "",
          moduleMap: result.diagramModuleMap || result.mermaidCode || "",
        },
        nodeFileMap: result.nodeFileMap || [],
      };

      setData(formattedData);
      setActiveTab("flowchart");

      // Initialize chat thread with assistant greeting
      setChatMessages([
        {
          role: "assistant",
          content: `👋 I have analyzed **${result.mode === "github" ? "this repository" : "this website"}**!\n\n${result.projectSummary}\n\nYou can ask me specific questions about components, backend services, database schemas, or request lifecycles.`,
        },
      ]);
    } catch (err: any) {
      console.error("❌ CAUGHT ERROR IN APP.TSX:", err);
      setError(err?.message || "An unknown error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleScan = handleAnalyze;

  // ── Send Chat Message ──────────────────────────────────────────────────
  const handleSendMessage = async (customMessage?: string) => {
    const messageToSend = customMessage || chatInput.trim();
    if (!messageToSend || !activeUrl || chatLoading) return;

    const userMsg: ChatMessageItem = {
      role: "user",
      content: messageToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    const nextMessages = [...chatMessages, userMsg];
    setChatMessages(nextMessages);
    if (!customMessage) setChatInput("");
    setChatLoading(true);

    try {
      const resp = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: activeUrl,
          mode: mode || "website",
          question: messageToSend,
          message: messageToSend,
          history: nextMessages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            content: m.content,
          })),
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        try {
          const errJson = JSON.parse(errText);
          // FastAPI validation errors are arrays in errJson.detail
          const message = Array.isArray(errJson.detail)
            ? errJson.detail.map((e: any) => e.msg).join(", ")
            : JSON.stringify(errJson.detail || errJson);
          throw new Error(message);
        } catch (e: any) {
          throw new Error(e.message || errText || `HTTP ${resp.status}`);
        }
      }

      const chatRes = await resp.json();
      const replyContent = chatRes.answer || chatRes.reply || "No response received.";
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: replyContent,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (err) {
      console.error("Network Fetch Error:", err);
      const errorMessage =
        err instanceof Error && err.message
          ? err.message
          : "Network Error: Cannot connect to 127.0.0.1:8000";
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `⚠️ Failed to get answer: ${errorMessage}`,
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  // ── Tab Navigation ─────────────────────────────────────────────────────
  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: "flowchart", label: "Diagrams", icon: "⬡" },
    { key: "techstack", label: "Tech Stack", icon: "◈" },
    { key: "workflow", label: "Workflow", icon: "↻" },
    { key: "chat", label: "Ask XRay", icon: "💬" },
  ];

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#c9d1d9] p-4 flex flex-col gap-4">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#1f6feb] to-[#8b5cf6] flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-[#1f6feb]/20">
            X
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-[#58a6ff] to-[#d2a8ff] bg-clip-text text-transparent">
              XRay Flow
            </h1>
            <p className="text-[10px] text-[#484f58] tracking-wide font-mono">
              PHASE 2 · MULTI-VIEW & CHAT
            </p>
          </div>
        </div>
        <span className={`badge ${mode === "github" ? "badge-github" : "badge-website"}`}>
          {mode === "github" ? "⚙ GitHub" : "🌐 Website"}
        </span>
      </header>

      {/* ── Active URL Bar ──────────────────────────────────── */}
      <div className="glass-card p-3 flex flex-col gap-1.5">
        <span className="text-[10px] text-[#484f58] font-semibold uppercase tracking-wider">
          Inspected Target
        </span>
        <p className="text-xs text-[#8b949e] truncate font-mono" title={activeUrl}>
          {activeUrl || "No active tab detected"}
        </p>
      </div>

      {/* ── Scan Button ─────────────────────────────────────── */}
      <button
        onClick={handleAnalyze}
        disabled={loading}
        className={`
          w-full py-3 px-4 rounded-xl font-semibold text-sm tracking-wide
          transition-all duration-300 relative overflow-hidden
          ${
            loading
              ? "bg-[#21262d] text-[#484f58] cursor-wait"
              : "bg-gradient-to-r from-[#1f6feb] to-[#8b5cf6] text-white hover:shadow-lg hover:shadow-[#1f6feb]/25 hover:scale-[1.01] active:scale-[0.99]"
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-[#484f58] border-t-[#58a6ff] rounded-full animate-spin" />
            Analyzing Architecture & Generating Diagrams…
          </span>
        ) : (
          "⚡ Scan Workflow & Tech Stack"
        )}
      </button>

      {/* ── Error Display ───────────────────────────────────── */}
      {error && (
        <div className="glass-card p-3 border-red-500/30 bg-red-500/5">
          <p className="text-xs text-red-400 font-medium">Scan Error</p>
          <p className="text-xs text-[#8b949e] mt-1">{error}</p>
        </div>
      )}

      {/* ── Loading Skeleton ─────────────────────────────────── */}
      {loading && (
        <div className="flex flex-col gap-3">
          <div className="shimmer-loading h-8 rounded-lg" />
          <div className="shimmer-loading h-40 rounded-xl" />
          <div className="shimmer-loading h-28 rounded-xl" />
        </div>
      )}

      {/* ── Results Container ─────────────────────────────────── */}
      {data && !loading && (
        <div className="flex flex-col gap-4">
          {/* Summary */}
          <div className="glass-card p-4">
            <h2 className="text-sm font-semibold text-[#58a6ff] mb-1.5 flex items-center justify-between">
              <span>Project Summary</span>
              <span className="text-[10px] text-[#484f58] font-normal uppercase">
                {data.mode}
              </span>
            </h2>
            <p className="text-xs text-[#8b949e] leading-relaxed">
              {data.projectSummary}
            </p>
          </div>

          {/* Tab Navigation */}
          <div className="grid grid-cols-4 gap-1 bg-[#161b22] p-1 rounded-xl border border-[#30363d]">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`
                  py-2 px-1 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all duration-200
                  ${
                    activeTab === tab.key
                      ? "bg-[#21262d] text-[#58a6ff] shadow-sm border border-[#388bfd]/30"
                      : "text-[#8b949e] hover:text-[#c9d1d9]"
                  }
                `}
              >
                <span>{tab.icon}</span>
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
          </div>

          {/* ── Tab Content ──────────────────────────────────── */}
          <div className="min-h-[220px]">
            {/* 1. Multi-View Flowchart Tab */}
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
              <div className="flex flex-col gap-2">
                {data.techStack.map((tech, i) => (
                  <div
                    key={i}
                    className="glass-card p-3 flex items-start gap-3 hover:border-[#388bfd]/40 transition-colors"
                  >
                    <div
                      className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
                      style={{
                        backgroundColor:
                          CATEGORY_COLORS[tech.category] || CATEGORY_COLORS.Other,
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-[#c9d1d9]">
                          {tech.name}
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-md font-medium"
                          style={{
                            color:
                              CATEGORY_COLORS[tech.category] ||
                              CATEGORY_COLORS.Other,
                            backgroundColor: `${CATEGORY_COLORS[tech.category] || CATEGORY_COLORS.Other}18`,
                          }}
                        >
                          {tech.category}
                        </span>
                      </div>
                      <p className="text-xs text-[#8b949e] leading-relaxed">
                        {tech.purpose}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 3. Workflow Steps Tab */}
            {activeTab === "workflow" && (
              <div className="flex flex-col gap-2">
                {data.workflowSteps.map((step, i) => (
                  <div
                    key={i}
                    className="glass-card p-3 flex items-start gap-3 hover:border-[#388bfd]/40 transition-colors"
                  >
                    <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#1f6feb] to-[#8b5cf6] flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {i + 1}
                    </div>
                    <p className="text-xs text-[#8b949e] leading-relaxed pt-0.5">
                      {step}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* 4. Interactive "Ask XRay" Architecture Chat Tab */}
            {activeTab === "chat" && (
              <div className="flex flex-col gap-3">
                {/* Chat Message Scroll Area */}
                <div className="glass-card p-3 flex flex-col gap-3 h-[380px] overflow-y-auto">
                  {chatMessages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center p-4 text-[#8b949e] gap-2">
                      <span className="text-2xl">💬</span>
                      <p className="text-xs font-medium text-[#c9d1d9]">
                        Ask XRay Architecture Assistant
                      </p>
                      <p className="text-[11px] text-[#484f58]">
                        Ask anything about the system components, data flows, or file locations.
                      </p>
                    </div>
                  )}

                  {chatMessages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`flex flex-col max-w-[88%] ${
                        msg.role === "user" ? "ml-auto items-end" : "mr-auto items-start"
                      }`}
                    >
                      <div
                        className={`p-3 rounded-2xl text-xs leading-relaxed ${
                          msg.role === "user"
                            ? "bg-gradient-to-r from-[#1f6feb] to-[#8b5cf6] text-white rounded-br-sm shadow-sm"
                            : "bg-[#21262d] text-[#c9d1d9] border border-[#30363d] rounded-bl-sm"
                        }`}
                      >
                        <div className="whitespace-pre-wrap break-words">
                          {msg.content}
                        </div>
                      </div>
                      {msg.timestamp && (
                        <span className="text-[9px] text-[#484f58] mt-1 px-1">
                          {msg.timestamp}
                        </span>
                      )}
                    </div>
                  ))}

                  {chatLoading && (
                    <div className="mr-auto flex items-center gap-2 p-3 bg-[#21262d] rounded-2xl text-xs text-[#8b949e] border border-[#30363d]">
                      <span className="w-3 h-3 border-2 border-[#484f58] border-t-[#58a6ff] rounded-full animate-spin" />
                      XRay is thinking…
                    </div>
                  )}

                  <div ref={chatBottomRef} />
                </div>

                {/* Quick Suggestion Chips */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                  {SUGGESTED_QUESTIONS.map((q, i) => (
                    <button
                      key={i}
                      disabled={chatLoading}
                      onClick={() => handleSendMessage(q)}
                      className="text-[11px] bg-[#161b22] text-[#8b949e] hover:text-[#58a6ff] hover:bg-[#21262d] px-2.5 py-1 rounded-full border border-[#30363d] whitespace-nowrap transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>

                {/* Message Input Box */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendMessage();
                  }}
                  className="flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask about architecture, data flow, files…"
                    disabled={chatLoading}
                    className="flex-1 bg-[#161b22] border border-[#30363d] rounded-xl px-3.5 py-2.5 text-xs text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] transition-colors"
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || chatLoading}
                    className="bg-gradient-to-r from-[#1f6feb] to-[#8b5cf6] text-white px-3.5 py-2.5 rounded-xl text-xs font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    Send
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="mt-auto pt-3 border-t border-[#21262d] flex items-center justify-between text-[10px] text-[#484f58]">
        <span>XRay Flow Phase 2</span>
        <span>FastAPI + Gemini 1.5 Flash</span>
      </footer>
    </div>
  );
}
