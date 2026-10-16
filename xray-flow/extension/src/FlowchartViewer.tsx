import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";

export interface DiagramViews {
  architecture: string;
  dataFlow: string;
  moduleMap: string;
}

export type DiagramViewKey = "architecture" | "dataFlow" | "moduleMap";

interface NodeFileEntry {
  nodeId: string;
  filePath: string;
}

interface FlowchartViewerProps {
  diagrams?: DiagramViews;
  chartCode?: string; // fallback if single code is passed
  nodeFileMap: NodeFileEntry[];
  githubBaseUrl: string | null;
  mode: string;
}

const VIEW_METADATA: Record<
  DiagramViewKey,
  { label: string; icon: string; description: string }
> = {
  architecture: {
    label: "Architecture",
    icon: "🏛️",
    description: "High-level system components, services & databases",
  },
  dataFlow: {
    label: "Data Flow",
    icon: "⚡",
    description: "End-to-end request/response lifecycle & execution path",
  },
  moduleMap: {
    label: "Module Map",
    icon: "🧩",
    description: "Component hierarchy, dependencies & asset boundaries",
  },
};

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "loose",
  themeVariables: {
    primaryColor: "#1f6feb",
    primaryTextColor: "#c9d1d9",
    primaryBorderColor: "#388bfd",
    lineColor: "#484f58",
    secondaryColor: "#161b22",
    tertiaryColor: "#21262d",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: "13px",
  },
});

function cleanMermaid(code: string): string {
  if (!code) return "";
  let cleaned = code.trim();
  cleaned = cleaned.replace(/```mermaid\s*/gi, "").replace(/```\s*/g, "");
  cleaned = cleaned.trim();
  if (!cleaned.startsWith("graph ") && !cleaned.startsWith("flowchart ")) {
    cleaned = "graph TD\n" + cleaned;
  }
  return cleaned;
}

export default function FlowchartViewer({
  diagrams,
  chartCode,
  nodeFileMap,
  githubBaseUrl,
  mode,
}: FlowchartViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Active view state
  const [activeView, setActiveView] = useState<DiagramViewKey>("architecture");

  // Transform state: Zoom & Pan
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const totalDragDistanceRef = useRef(0);

  // Status & export states
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);

  // Determine current code to render
  const currentCode =
    diagrams?.[activeView] ||
    chartCode ||
    diagrams?.architecture ||
    "";

  // ── Render Chart ────────────────────────────────────────────────────────────
  const renderChart = useCallback(async () => {
    if (!containerRef.current || !currentCode) return;
    setError(null);

    try {
      const sanitizedCode = cleanMermaid(currentCode);
      const renderId = `mermaid-${activeView}-${Date.now()}`;
      const { svg } = await mermaid.render(renderId, sanitizedCode);
      containerRef.current.innerHTML = svg;

      // Attach click handlers for GitHub mode node → file navigation
      if (mode === "github" && githubBaseUrl && nodeFileMap.length > 0) {
        const svgEl = containerRef.current.querySelector("svg");
        if (svgEl) {
          nodeFileMap.forEach(({ nodeId, filePath }) => {
            const nodeEl =
              svgEl.querySelector(`[id*="flowchart-${nodeId}-"]`) ||
              svgEl.querySelector(`[id*="${nodeId}"]`) ||
              svgEl.querySelector(`g#${nodeId}`);
            if (nodeEl) {
              const htmlNode = nodeEl as HTMLElement;
              htmlNode.style.cursor = "pointer";
              htmlNode.setAttribute("title", `Open ${filePath}`);

              nodeEl.addEventListener("click", (e) => {
                // If user dragged more than 5px, don't trigger click navigation
                if (totalDragDistanceRef.current > 5) {
                  return;
                }
                e.stopPropagation();
                const fileUrl = `${githubBaseUrl}/blob/main/${filePath}`;
                if (typeof chrome !== "undefined" && chrome.tabs) {
                  chrome.tabs.query(
                    { active: true, currentWindow: true },
                    (tabs) => {
                      if (tabs[0]?.id) {
                        chrome.tabs.update(tabs[0].id, { url: fileUrl });
                      }
                    }
                  );
                } else {
                  window.open(fileUrl, "_blank");
                }
              });
            }
          });
        }
      }
    } catch (err) {
      console.error("[FlowchartViewer] Render error:", err);
      setError(String(err));
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    }
  }, [currentCode, activeView, nodeFileMap, githubBaseUrl, mode]);

  useEffect(() => {
    renderChart();
  }, [renderChart]);

  // ── Zoom Controls ───────────────────────────────────────────────────────────
  const handleZoom = (delta: number) => {
    setZoom((prev) => Math.max(0.3, Math.min(3.5, Number((prev + delta).toFixed(2)))));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // ── Pan Handlers (Mouse & Touch) ───────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // only left click
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    panStartRef.current = { ...pan };
    totalDragDistanceRef.current = 0;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    totalDragDistanceRef.current += Math.abs(dx) + Math.abs(dy);
    setPan({
      x: panStartRef.current.x + dx,
      y: panStartRef.current.y + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Touch support
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      setIsDragging(true);
      dragStartRef.current = { x: touch.clientX, y: touch.clientY };
      panStartRef.current = { ...pan };
      totalDragDistanceRef.current = 0;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - dragStartRef.current.x;
    const dy = touch.clientY - dragStartRef.current.y;
    totalDragDistanceRef.current += Math.abs(dx) + Math.abs(dy);
    setPan({
      x: panStartRef.current.x + dx,
      y: panStartRef.current.y + dy,
    });
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  // ── SVG Diagram Export ──────────────────────────────────────────────────────
  const handleExportSvg = () => {
    if (!containerRef.current) return;
    const svgEl = containerRef.current.querySelector("svg");
    if (!svgEl) return;

    try {
      const clonedSvg = svgEl.cloneNode(true) as SVGElement;
      clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clonedSvg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

      const serializer = new XMLSerializer();
      let source = serializer.serializeToString(clonedSvg);

      // Add xml declaration
      if (!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)) {
        source = source.replace(
          /^<svg/,
          '<svg xmlns="http://www.w3.org/2000/svg"'
        );
      }

      const blob = new Blob([source], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const downloadLink = document.createElement("a");
      downloadLink.href = url;
      downloadLink.download = `xray-${activeView}-flowchart.svg`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(url);

      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch (err) {
      console.error("[FlowchartViewer] SVG Export failed:", err);
    }
  };

  // ── Copy Mermaid Code ───────────────────────────────────────────────────────
  const handleCopyCode = async () => {
    if (!currentCode) return;
    try {
      await navigator.clipboard.writeText(currentCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("[FlowchartViewer] Copy failed:", err);
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* ── Multi-View Switcher Tabs ────────────────────────────────────────── */}
      {diagrams && (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-3 gap-1 bg-[#161b22] p-1 rounded-xl border border-[#30363d]">
            {(Object.keys(VIEW_METADATA) as DiagramViewKey[]).map((key) => {
              const meta = VIEW_METADATA[key];
              const isActive = activeView === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    setActiveView(key);
                    resetView();
                  }}
                  className={`
                    py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all
                    ${
                      isActive
                        ? "bg-gradient-to-r from-[#1f6feb] to-[#8b5cf6] text-white shadow-md shadow-[#1f6feb]/20"
                        : "text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]"
                    }
                  `}
                >
                  <span className="text-xs">{meta.icon}</span>
                  <span className="truncate">{meta.label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-[#8b949e] px-1 italic">
            {VIEW_METADATA[activeView].description}
          </p>
        </div>
      )}

      {/* ── Toolbar: Zoom, Pan, Export, Copy ───────────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1 bg-[#161b22] p-1 rounded-lg border border-[#30363d]">
          <button
            onClick={() => handleZoom(0.2)}
            className="w-7 h-7 rounded bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] text-sm font-bold flex items-center justify-center transition-colors"
            title="Zoom In"
          >
            +
          </button>
          <button
            onClick={() => handleZoom(-0.2)}
            className="w-7 h-7 rounded bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] text-sm font-bold flex items-center justify-center transition-colors"
            title="Zoom Out"
          >
            −
          </button>
          <button
            onClick={resetView}
            className="px-2 h-7 rounded bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] text-xs font-medium flex items-center justify-center transition-colors"
            title="Reset Zoom & Pan"
          >
            ↺ Reset
          </button>
          <span className="px-1 text-[11px] text-[#8b949e] font-mono min-w-[36px] text-center">
            {Math.round(zoom * 100)}%
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {/* Copy Mermaid */}
          <button
            onClick={handleCopyCode}
            className="px-2.5 h-8 rounded-lg bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] text-xs font-medium flex items-center gap-1 transition-colors border border-[#30363d]"
            title="Copy Mermaid source code"
          >
            {copied ? (
              <span className="text-[#3fb950] font-semibold">✓ Copied</span>
            ) : (
              <>
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z" />
                  <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z" />
                </svg>
                Copy
              </>
            )}
          </button>

          {/* Export SVG */}
          <button
            onClick={handleExportSvg}
            className="px-2.5 h-8 rounded-lg bg-gradient-to-r from-[#1f6feb] to-[#58a6ff] text-white hover:opacity-90 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm shadow-[#1f6feb]/25"
            title="Download diagram as vector SVG"
          >
            {exported ? (
              <span className="font-bold">✓ Saved</span>
            ) : (
              <>
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z" />
                  <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z" />
                </svg>
                Export SVG
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Chart Viewport Canvas ───────────────────────────────────────────── */}
      {error ? (
        <div className="glass-card p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-amber-400 text-sm font-medium">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
            </svg>
            Mermaid Render Error ({activeView})
          </div>
          <p className="text-xs text-[#8b949e]">
            This diagram could not be rendered automatically. You can inspect or copy the raw code:
          </p>
          <button
            onClick={() => setShowRaw((p) => !p)}
            className="text-xs text-[#58a6ff] hover:underline self-start font-medium"
          >
            {showRaw ? "Hide raw code" : "Show raw code"}
          </button>
          {showRaw && (
            <pre className="text-xs bg-[#0d1117] p-3 rounded-lg overflow-auto max-h-64 text-[#8b949e] border border-[#21262d] font-mono">
              {currentCode}
            </pre>
          )}
        </div>
      ) : (
        <div
          ref={viewportRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className={`
            glass-card p-3 overflow-hidden relative select-none
            ${isDragging ? "cursor-grabbing" : "cursor-grab"}
          `}
          style={{ height: "460px" }}
        >
          {/* Subtle canvas drag hint */}
          <div className="absolute bottom-2 right-2 text-[10px] text-[#484f58] pointer-events-none bg-[#161b22]/70 px-2 py-0.5 rounded border border-[#30363d]/50">
            Drag to pan · Click nodes to view code
          </div>

          <div
            ref={containerRef}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "top left",
              transition: isDragging ? "none" : "transform 0.15s ease-out",
              display: "inline-block",
            }}
          />
        </div>
      )}
    </div>
  );
}
