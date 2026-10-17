import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import { cleanMermaid } from "./api";

export interface DiagramViews {
  architecture: string;
  dataFlow: string;
  moduleMap: string;
}

export type DiagramViewKey = "architecture" | "dataFlow" | "moduleMap";

export interface NodeFileEntry {
  nodeId: string;
  filePath: string;
}

interface FlowchartViewerProps {
  diagrams?: DiagramViews;
  chartCode?: string;
  nodeFileMap: NodeFileEntry[];
  githubBaseUrl: string | null;
  mode: string;
}

const VIEW_METADATA: Record<
  DiagramViewKey,
  { label: string; description: string }
> = {
  architecture: {
    label: "Architecture",
    description: "High-level services, modules & system components",
  },
  dataFlow: {
    label: "Data Flow",
    description: "Request lifecycle, pipeline & execution path",
  },
  moduleMap: {
    label: "Module Map",
    description: "Component hierarchy, dependencies & boundaries",
  },
};

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  securityLevel: "loose",
  themeVariables: {
    fontFamily: "'JetBrains Mono', 'Inter', monospace",
    fontSize: "12px",
    primaryColor: "#18181b",
    primaryTextColor: "#f4f4f5",
    primaryBorderColor: "#3f3f46",
    lineColor: "#71717a",
    secondaryColor: "#09090b",
    tertiaryColor: "#18181b",
  },
  flowchart: {
    useMaxWidth: true,
    htmlLabels: true,
    curve: "basis",
    nodeSpacing: 30,
    rankSpacing: 40,
    padding: 12,
  },
});

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

  // Current diagram code
  const currentCode =
    diagrams?.[activeView] ||
    chartCode ||
    diagrams?.architecture ||
    "";

  // ── Render Chart & SVG Responsive Normalization ───────────────────────────
  const renderChart = useCallback(async () => {
    if (!containerRef.current || !currentCode) return;
    setError(null);

    try {
      const sanitizedCode = cleanMermaid(currentCode);
      const renderId = `mermaid-${activeView}-${Date.now()}`;
      const { svg } = await mermaid.render(renderId, sanitizedCode);

      containerRef.current.innerHTML = svg;
      const svgEl = containerRef.current.querySelector("svg");

      if (svgEl) {
        // Ensure viewBox is preserved or derived
        let viewBox = svgEl.getAttribute("viewBox");
        if (!viewBox) {
          const w = svgEl.getAttribute("width") || svgEl.getBoundingClientRect().width;
          const h = svgEl.getAttribute("height") || svgEl.getBoundingClientRect().height;
          if (w && h) {
            const cleanW = parseFloat(String(w));
            const cleanH = parseFloat(String(h));
            if (cleanW > 0 && cleanH > 0) {
              viewBox = `0 0 ${cleanW} ${cleanH}`;
              svgEl.setAttribute("viewBox", viewBox);
            }
          }
        }

        // SVG Responsive Normalization: remove hardcoded dimensions/max-width that clip viewBox
        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");
        svgEl.style.removeProperty("max-width");
        svgEl.style.width = "100%";
        svgEl.style.height = "100%";
        svgEl.style.maxHeight = "360px";
        svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

        // Attach click handlers for GitHub mode node → file navigation
        if (mode === "github" && githubBaseUrl && nodeFileMap.length > 0) {
          nodeFileMap.forEach(({ nodeId, filePath }) => {
            const nodeEl =
              svgEl.querySelector(`[id*="flowchart-${nodeId}-"]`) ||
              svgEl.querySelector(`[id*="${nodeId}"]`) ||
              svgEl.querySelector(`g#${nodeId}`);
            if (nodeEl) {
              const htmlNode = nodeEl as HTMLElement;
              htmlNode.style.cursor = "pointer";
              htmlNode.setAttribute("title", `Open ${filePath} on GitHub`);

              nodeEl.addEventListener("click", (e) => {
                if (totalDragDistanceRef.current > 6) return;
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

  // ── Zoom & Pan Controls ───────────────────────────────────────────────────
  const handleZoom = (delta: number) => {
    setZoom((prev) => Math.max(0.3, Math.min(3.5, Number((prev + delta).toFixed(2)))));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
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

  // Touch Support
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

  // ── SVG Diagram Export ────────────────────────────────────────────────────
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

      if (!source.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
      }

      const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const downloadLink = document.createElement("a");
      downloadLink.href = url;
      downloadLink.download = `xray-${activeView}.svg`;
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

  // ── Copy Mermaid Code ─────────────────────────────────────────────────────
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
    <div className="flex flex-col gap-2 w-full">
      {/* ── Multi-View Switcher Tabs ────────────────────────────────────────── */}
      {diagrams && (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-3 gap-1 bg-[#121215] p-1 rounded-md border border-[#27272a]">
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
                  className={`py-1 px-2 rounded text-xs transition-colors font-medium truncate ${
                    isActive
                      ? "bg-[#27272a] text-[#f4f4f5] shadow-xs"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-zinc-500 px-1 font-mono">
            {VIEW_METADATA[activeView].description}
          </p>
        </div>
      )}

      {/* ── Interactive Viewport Canvas ─────────────────────────────────────── */}
      {error ? (
        <div className="p-3 bg-[#121215] border border-amber-900/50 rounded-md flex flex-col gap-2">
          <div className="text-xs text-amber-400 font-medium">
            Diagram syntax error ({activeView})
          </div>
          <p className="text-[11px] text-zinc-400">
            Mermaid could not render this diagram. You can inspect or copy the raw syntax:
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowRaw((p) => !p)}
              className="text-[11px] text-zinc-300 hover:text-white underline font-mono"
            >
              {showRaw ? "Hide syntax" : "View syntax"}
            </button>
            <button
              onClick={handleCopyCode}
              className="text-[11px] text-zinc-300 hover:text-white underline font-mono"
            >
              Copy syntax
            </button>
          </div>
          {showRaw && (
            <pre className="text-[11px] bg-[#09090b] p-2.5 rounded border border-zinc-800 text-zinc-400 font-mono overflow-auto max-h-48 whitespace-pre-wrap">
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
          className={`overflow-hidden relative h-[380px] bg-[#09090b] border border-zinc-800 rounded-md select-none flex items-center justify-center ${
            isDragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          {/* Minimal Floating Toolbar */}
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1 bg-zinc-900/90 backdrop-blur-xs border border-zinc-800 text-zinc-300 px-1.5 py-1 rounded text-xs shadow-sm">
            <button
              onClick={() => handleZoom(0.2)}
              className="w-5 h-5 flex items-center justify-center hover:bg-zinc-800 hover:text-white rounded transition-colors"
              title="Zoom In"
            >
              +
            </button>
            <button
              onClick={() => handleZoom(-0.2)}
              className="w-5 h-5 flex items-center justify-center hover:bg-zinc-800 hover:text-white rounded transition-colors"
              title="Zoom Out"
            >
              −
            </button>
            <button
              onClick={resetView}
              className="px-1.5 h-5 flex items-center justify-center hover:bg-zinc-800 hover:text-white rounded text-[11px] font-mono transition-colors"
              title="Fit to Screen"
            >
              Fit
            </button>
            <div className="w-[1px] h-3 bg-zinc-800 my-auto mx-0.5" />
            <button
              onClick={handleCopyCode}
              className="px-1.5 h-5 flex items-center justify-center hover:bg-zinc-800 hover:text-white rounded text-[11px] transition-colors"
              title="Copy Mermaid Code"
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
            <button
              onClick={handleExportSvg}
              className="px-1.5 h-5 flex items-center justify-center hover:bg-zinc-800 hover:text-white rounded text-[11px] transition-colors"
              title="Export as SVG"
            >
              {exported ? "✓ SVG" : "SVG"}
            </button>
          </div>

          {/* Canvas Drag Hint */}
          <div className="absolute bottom-2 right-2 text-[10px] text-zinc-600 pointer-events-none font-mono">
            Pan: drag · Zoom: toolbar
          </div>

          {/* SVG Diagram Canvas */}
          <div
            ref={containerRef}
            className="w-full h-full flex items-center justify-center p-2"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: isDragging ? "none" : "transform 0.1s ease-out",
            }}
          />
        </div>
      )}
    </div>
  );
}
