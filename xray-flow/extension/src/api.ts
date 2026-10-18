// Direct Browser-to-Gemini & GitHub Scraper Engine for XRay Flow

export interface StoredKeys {
  geminiKey: string;
  githubToken: string;
  preferredModel?: string;
}

export interface TechItem {
  name: string;
  category: string;
  purpose: string;
  evidence?: string;
}

export interface NodeFileEntry {
  nodeId: string;
  filePath: string;
}

export interface AnalysisResult {
  mode: "website" | "github";
  projectSummary: string;
  techStack: TechItem[];
  workflowSteps: string[];
  mermaidCode: string;
  diagramDataFlow: string;
  diagramModuleMap: string;
  nodeFileMap?: NodeFileEntry[];
  usedModel?: string;
}

export interface ChatResult {
  answer: string;
  reply?: string;
  relevantFiles?: string[];
  optionalMermaid?: string;
  usedModel?: string;
}

export interface GitHubContext {
  owner: string;
  repo: string;
  description?: string;
  primaryLanguage?: string;
  branch?: string;
  fileTree: string[];
  keyFiles: Record<string, string>;
  domFallback?: boolean;
  note?: string;
}

// ── 1. Key Management (chrome.storage.local) ──────────────────────────────────
export async function getStoredKeys(): Promise<StoredKeys> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ["geminiKey", "githubToken", "preferredModel"],
        (result) => {
          resolve({
            geminiKey: result.geminiKey || "",
            githubToken: result.githubToken || "",
            preferredModel: result.preferredModel || "auto",
          });
        }
      );
    });
  }
  try {
    return {
      geminiKey: localStorage.getItem("xray_gemini_key") || "",
      githubToken: localStorage.getItem("xray_github_token") || "",
      preferredModel: localStorage.getItem("xray_preferred_model") || "auto",
    };
  } catch {
    return { geminiKey: "", githubToken: "", preferredModel: "auto" };
  }
}

export async function saveStoredKeys(
  geminiKey: string,
  githubToken: string,
  preferredModel: string = "auto"
): Promise<void> {
  const cleanGemini = (geminiKey || "").trim();
  const cleanGithub = (githubToken || "").trim();
  const cleanModel = (preferredModel || "auto").trim();

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.set(
        {
          geminiKey: cleanGemini,
          githubToken: cleanGithub,
          preferredModel: cleanModel,
        },
        () => resolve()
      );
    });
  }
  try {
    localStorage.setItem("xray_gemini_key", cleanGemini);
    localStorage.setItem("xray_github_token", cleanGithub);
    localStorage.setItem("xray_preferred_model", cleanModel);
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

// ── 2. Mermaid Sanitizer (cleanMermaid) ──────────────────────────────────────
export function cleanMermaid(code: string): string {
  if (!code) return "";
  let cleaned = code.trim();

  // Strip ```mermaid and ``` wrappers
  cleaned = cleaned.replace(/```(?:mermaid)?/gi, "").replace(/```/g, "").trim();

  // Ensure it starts with graph TD
  const firstLine = cleaned.split("\n")[0].trim();
  if (!firstLine.startsWith("graph ") && !firstLine.startsWith("flowchart ")) {
    cleaned = "graph TD\n" + cleaned;
  }

  // Sanitize node labels to ensure quotes around bracket contents
  // e.g. NodeId[Some Label (Info)] -> NodeId["Some Label (Info)"]
  cleaned = cleaned.replace(
    /([a-zA-Z0-9_]+)\s*\[\s*([^"\]\n][^\]\n]*?)\s*\]/g,
    (_match, id, text) => {
      const sanitizedText = text.replace(/"/g, "'").trim();
      return `${id}["${sanitizedText}"]`;
    }
  );

  return cleaned;
}

// ── 3. Fast Concurrent GitHub Scraper ─────────────────────────────────────────
export async function fetchGithubContext(
  url: string,
  githubToken?: string
): Promise<GitHubContext> {
  const cleanUrl = url.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const parts = cleanUrl.split("github.com/")[1]?.split("/") || [];

  if (parts.length < 2) {
    return {
      owner: "",
      repo: "",
      fileTree: [],
      keyFiles: {},
      domFallback: true,
      note: "Invalid GitHub repository URL",
    };
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  const token = githubToken?.trim();
  if (token && !token.startsWith("your_")) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    // 1. Fetch repo metadata
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
    });

    if (!repoRes.ok) {
      return {
        owner,
        repo,
        fileTree: [],
        keyFiles: {},
        domFallback: true,
        note: `GitHub API status ${repoRes.status}`,
      };
    }

    const repoInfo = await repoRes.json();
    const defaultBranch = repoInfo.default_branch || "main";

    // 2. Fetch recursive file tree
    let filePaths: string[] = [];
    try {
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
        { headers }
      );
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        const tree = Array.isArray(treeData.tree) ? treeData.tree : [];
        filePaths = tree
          .filter((item: any) => item.type === "blob")
          .map((item: any) => item.path as string)
          .slice(0, 120);
      }
    } catch {
      // Tree fetch fallback
    }

    // 3. Concurrently fetch up to 4 key files (truncate to 1500 chars)
    const targetFiles: { path: string; maxChars: number }[] = [];

    // Priority 1: Root README.md
    const readmeFile =
      filePaths.find(
        (p) => !p.includes("/") && p.toLowerCase().startsWith("readme")
      ) || filePaths.find((p) => p.toLowerCase().endsWith("readme.md"));
    if (readmeFile) {
      targetFiles.push({ path: readmeFile, maxChars: 1500 });
    }

    // Priority 2: Root manifests
    const manifests = [
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      "Dockerfile",
    ];
    for (const m of manifests) {
      if (targetFiles.length >= 4) break;
      const found = filePaths.find(
        (p) => p === m || (!p.includes("/") && p.toLowerCase() === m.toLowerCase())
      );
      if (found && !targetFiles.some((t) => t.path === found)) {
        targetFiles.push({ path: found, maxChars: 1500 });
      }
    }

    // Priority 3: Up to 2 root or top-level code/HTML files if < 3 files matched
    if (targetFiles.length < 3) {
      const codeCandidates = filePaths.filter(
        (p) =>
          !targetFiles.some((t) => t.path === p) &&
          (p.endsWith(".html") ||
            p.endsWith(".ts") ||
            p.endsWith(".py") ||
            p.endsWith(".js") ||
            p.endsWith(".tsx")) &&
          p.split("/").length <= 2
      );
      for (const p of codeCandidates.slice(0, 2)) {
        if (targetFiles.length >= 4) break;
        targetFiles.push({ path: p, maxChars: 1500 });
      }
    }

    // Concurrently fetch file contents from raw.githubusercontent.com
    const keyFiles: Record<string, string> = {};
    await Promise.all(
      targetFiles.map(async ({ path, maxChars }) => {
        try {
          const rawRes = await fetch(
            `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${path}`
          );
          if (rawRes.ok) {
            const text = await rawRes.text();
            keyFiles[path] = text.slice(0, maxChars);
          }
        } catch (err) {
          console.warn(`[XRay Flow] Failed to fetch raw file ${path}:`, err);
        }
      })
    );

    return {
      owner,
      repo,
      description: repoInfo.description || "",
      primaryLanguage: repoInfo.language || "",
      branch: defaultBranch,
      fileTree: filePaths,
      keyFiles,
      domFallback: false,
    };
  } catch (err: any) {
    return {
      owner,
      repo,
      fileTree: [],
      keyFiles: {},
      domFallback: true,
      note: `GitHub fetch exception: ${err?.message || err}`,
    };
  }
}

// ── 4. Dynamic Gemini Discovery & Failover Engine ───────────────────────────

// Up-to-date fallback list ordered from newest stable Flash models to lightweight/legacy tiers
export const FALLBACK_FLASH_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const EXCLUDED_KEYWORDS = [
  "tts",
  "live",
  "image",
  "transcribe",
  "embedding",
  "aqa",
  "vision",
  "audio",
  "banana",
];

/**
 * Queries Google's v1beta/models endpoint to discover all text-generation Flash models
 * currently enabled for this specific API key, sorted from newest version to oldest.
 */
export async function discoverAvailableModels(geminiKey: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`
    );
    if (!res.ok) return FALLBACK_FLASH_MODELS;

    const data = await res.json();
    const models: any[] = data.models || [];

    const validFlashModels = models
      .filter((m) => {
        const name = (m.name || "").replace("models/", "").toLowerCase();
        const methods: string[] = m.supportedGenerationMethods || [];
        const supportsGenerate = methods.includes("generateContent");
        const isGeminiFlash = name.startsWith("gemini-") && name.includes("flash");
        const isExcluded = EXCLUDED_KEYWORDS.some((kw) => name.includes(kw));
        return supportsGenerate && isGeminiFlash && !isExcluded;
      })
      .map((m) => (m.name as string).replace("models/", ""));

    // Sort dynamically by version number (e.g., 4.0 > 3.8 > 3.7 > 3.6 > 3.5 > 2.5)
    // and prefer standard stable "-flash" over "-lite" or "-preview" within the same version
    validFlashModels.sort((a, b) => {
      const verA = parseFloat(a.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || "0");
      const verB = parseFloat(b.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || "0");
      if (verB !== verA) return verB - verA;

      const score = (name: string) => {
        if (/^gemini-\d+(\.\d+)?-flash$/.test(name)) return 3; // Exact stable release
        if (name.includes("lite") && !name.includes("preview")) return 2; // Stable lite
        if (!name.includes("preview") && !name.includes("exp")) return 1;
        return 0;
      };
      return score(b) - score(a);
    });

    return validFlashModels.length > 0
      ? Array.from(new Set([...validFlashModels, ...FALLBACK_FLASH_MODELS]))
      : FALLBACK_FLASH_MODELS;
  } catch {
    return FALLBACK_FLASH_MODELS;
  }
}

/**
 * Unified Gemini caller with dynamic discovery, automatic fallback across models,
 * and working model caching in local storage.
 */
export async function callGeminiWithAutoFallback(
  geminiKey: string,
  payload: Record<string, any>,
  preferredModel?: string
): Promise<{ data: any; usedModel: string }> {
  if (!geminiKey) {
    throw new Error("Missing Gemini API Key. Please add it in Settings.");
  }

  const discovered = await discoverAvailableModels(geminiKey);

  // Put user's preferred or last-known working model at the front of the queue
  let frontModel =
    preferredModel && preferredModel !== "auto" ? preferredModel : undefined;

  if (!frontModel) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const stored = await new Promise<any>((resolve) =>
          chrome.storage.local.get(["lastWorkingModel"], resolve)
        );
        if (stored?.lastWorkingModel) frontModel = stored.lastWorkingModel;
      } else {
        frontModel = localStorage.getItem("xray_last_working_model") || undefined;
      }
    } catch {
      // Storage access failure
    }
  }

  const candidateQueue =
    frontModel
      ? [frontModel, ...discovered.filter((m) => m !== frontModel)]
      : discovered;

  let lastError = "";

  for (const modelName of candidateQueue) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          chrome.storage.local.set({ lastWorkingModel: modelName });
        } else {
          try {
            localStorage.setItem("xray_last_working_model", modelName);
          } catch {}
        }
        return { data, usedModel: modelName };
      }

      const errText = await response.text();
      lastError = `${modelName} (${response.status}): ${errText}`;

      // If 400 Invalid API Key, stop immediately and alert user
      if (
        response.status === 400 &&
        errText.toLowerCase().includes("api key not valid")
      ) {
        throw new Error(
          "Invalid Gemini API Key. Please check your key in Settings."
        );
      }

      // If 404 (deprecated/unavailable), 429 (quota exceeded), or 503 (overloaded),
      // continue loop to try the next model automatically!
      console.warn(
        `[XRay Flow] Model ${modelName} failed with ${response.status}, trying next fallback...`
      );
    } catch (err: any) {
      if (err.message?.includes("Invalid Gemini API Key")) throw err;
      lastError = err.message || String(err);
    }
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

/**
 * Backwards-compatible caller
 */
export async function callGemini(
  geminiKey: string,
  systemPrompt: string,
  userPrompt: string,
  responseSchema?: any,
  preferredModel?: string
): Promise<any> {
  const payload: any = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      ...(responseSchema ? { responseSchema } : {}),
    },
  };
  const { data } = await callGeminiWithAutoFallback(
    geminiKey,
    payload,
    preferredModel
  );
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini");
  return JSON.parse(rawText);
}

export async function analyzeTarget(params: {
  url: string;
  mode: "website" | "github";
  siteSignals?: any;
  geminiKey: string;
  githubToken?: string;
  preferredModel?: string;
}): Promise<AnalysisResult> {
  const { url, mode, siteSignals, geminiKey, githubToken, preferredModel } = params;

  let contextData: any = {};

  if (mode === "github") {
    const ghContext = await fetchGithubContext(url, githubToken);
    contextData = { ...ghContext };

    // Gracefully merge scraped DOM signals if rate-limited or keyFiles is empty
    if (ghContext.domFallback || Object.keys(ghContext.keyFiles).length === 0) {
      contextData.signals = siteSignals || {};
      if (siteSignals && typeof siteSignals === "object") {
        if (
          (!contextData.fileTree || contextData.fileTree.length === 0) &&
          siteSignals.githubFiles
        ) {
          contextData.fileTree = siteSignals.githubFiles;
        }
        if (!contextData.keyFiles) {
          contextData.keyFiles = {};
        }
        if (siteSignals.githubReadme && !contextData.keyFiles["README.md"]) {
          contextData.keyFiles["README.md"] = siteSignals.githubReadme.slice(0, 1500);
        }
      }
    }
  } else {
    contextData = {
      url,
      signals: siteSignals || {},
    };
  }

  const systemPrompt = `You are a Principal Software Architect.
Analyze the target application and output a strict JSON object matching the exact specification.

REQUIRED JSON FORMAT:
{
  "mode": "${mode}",
  "projectSummary": "Concise 2-sentence technical architecture summary",
  "techStack": [
    {
      "name": "string",
      "category": "Frontend | Backend | Database | DevOps | Testing | Auth | API | Styling | Build | Other",
      "purpose": "string",
      "evidence": "Exact file or DOM signal proof"
    }
  ],
  "workflowSteps": ["Step 1...", "Step 2..."],
  "mermaidCode": "graph TD\\n...",
  "diagramDataFlow": "graph TD\\n...",
  "diagramModuleMap": "graph TD\\n..."
}

STRICT WEBSITE GROUND-TRUTH RULES:
- ONLY list technologies in techStack that have direct proof in signals (e.g. script src paths, frameworkMarkers, customElements, apiCalls, stylesheets, storageKeys).
- For every TechItem, populate evidence with the exact signal found (e.g. "Found '/@vite/client' and '/src/main.tsx' in scripts", "Detected custom element <ytd-app>", "Observed fetch to /api/auth").
- Do NOT guess backend databases (PostgreSQL, MongoDB, Prisma) on a live website unless explicitly exposed in apiCalls or storageKeys (e.g. Supabase, Firebase). If hidden behind an API, list only the observed REST/GraphQL API!

STRICT GITHUB GROUND-TRUTH RULES:
- NEVER guess or hallucinate frameworks if not explicitly evidenced in fileTree, keyFiles, or website signals.
- For every TechItem, populate evidence with the exact file or dependency found (e.g. "Found in package.json", "Observed in fileTree").
- If repository only contains static HTML, CSS, JS, and Markdown with no build step or backend, state that clearly in projectSummary and ONLY list actual languages/files present (HTML5, CSS3, Vanilla JS, Markdown).
- Base all 3 diagrams strictly on actual files in fileTree.

CRITICAL MERMAID RULES:
- Output 3 valid Mermaid diagrams:
  1. mermaidCode: High-level architecture (services, clients, core data flow).
  2. diagramDataFlow: Request lifecycle (entry point -> middleware -> handler -> storage/response).
  3. diagramModuleMap: Component hierarchy and module boundaries.
- YOU MUST NOT use markdown code blocks (\`\`\`mermaid). Return only the raw diagram string starting with 'graph TD'.
- Node IDs MUST be simple one-word alphanumeric strings without spaces or dashes (e.g. A, B, WebClient, ApiServer, DB).
- Node Labels MUST ALWAYS be wrapped in double quotes: NodeId["Label text"].
- Limit diagrams to 10-12 nodes max so they remain compact, clean, and legible in side panel viewports.`;

  const userPrompt = `TARGET: ${url}\nMODE: ${mode}\nCONTEXT DATA:\n${JSON.stringify(
    contextData
  ).slice(0, 8000)}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  const { data, usedModel } = await callGeminiWithAutoFallback(
    geminiKey,
    payload,
    preferredModel
  );

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error(`Empty response from Gemini (${usedModel})`);
  }

  let result: any = {};
  try {
    result = JSON.parse(rawText);
  } catch (err) {
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[1]);
    } else {
      throw err;
    }
  }

  // Sanitize all diagrams
  const cleanedArchitecture = cleanMermaid(result.mermaidCode || "");
  const cleanedDataFlow = cleanMermaid(
    result.diagramDataFlow || result.mermaidCode || ""
  );
  const cleanedModuleMap = cleanMermaid(
    result.diagramModuleMap || result.mermaidCode || ""
  );

  // Derive nodeFileMap for GitHub navigation if fileTree is present
  const nodeFileMap: NodeFileEntry[] = [];
  if (mode === "github" && Array.isArray(contextData.fileTree)) {
    const fileTree: string[] = contextData.fileTree;
    // Inspect diagram text for node IDs and matching filenames
    const nodeRegex = /([a-zA-Z0-9_]+)\["([^"]+)"\]/g;
    let match: RegExpExecArray | null;
    while ((match = nodeRegex.exec(cleanedArchitecture)) !== null) {
      const nodeId = match[1];
      const label = match[2];
      const foundFile = fileTree.find(
        (f) =>
          f.toLowerCase().includes(label.toLowerCase()) ||
          label.toLowerCase().includes(f.split("/").pop()?.toLowerCase() || "")
      );
      if (foundFile) {
        nodeFileMap.push({ nodeId, filePath: foundFile });
      }
    }
  }

  return {
    mode: result.mode || mode,
    projectSummary: result.projectSummary || "Architecture analysis completed.",
    techStack: Array.isArray(result.techStack) ? result.techStack : [],
    workflowSteps: Array.isArray(result.workflowSteps) ? result.workflowSteps : [],
    mermaidCode: cleanedArchitecture,
    diagramDataFlow: cleanedDataFlow,
    diagramModuleMap: cleanedModuleMap,
    nodeFileMap,
    usedModel,
  };
}

export async function askChat(params: {
  url: string;
  mode: string;
  question: string;
  history?: { role: string; content: string }[];
  geminiKey: string;
  preferredModel?: string;
}): Promise<ChatResult> {
  const { url, mode, question, history, geminiKey, preferredModel } = params;

  const systemPrompt = `You are an elite Principal Software Architect assisting a developer.
Provide a concise, highly technical answer in GitHub-flavored Markdown.
If asked about security or potential vulnerabilities, explain common architectural defense mechanisms for their stack, but NEVER provide exploit payloads.
Return a JSON object matching this schema:
{
  "answer": "Concise Markdown response with bullet points and code references",
  "relevantFiles": ["path/to/relevant_file.ts"],
  "optionalMermaid": "graph TD\\n..." (leave empty string if not needed)
}`;

  const historyText = (history || [])
    .slice(-6)
    .map((h) => `${h.role.toUpperCase()}: ${h.content}`)
    .join("\n\n");

  const userPrompt = `TARGET URL: ${url}\nMODE: ${mode}\n${
    historyText ? `RECENT CONVERSATION:\n${historyText}\n\n` : ""
  }USER QUESTION: ${question}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.3,
    },
  };

  const { data, usedModel } = await callGeminiWithAutoFallback(
    geminiKey,
    payload,
    preferredModel
  );

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error(`Empty response from Gemini (${usedModel})`);
  }

  let result: any = {};
  try {
    result = JSON.parse(rawText);
  } catch {
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        result = JSON.parse(jsonMatch[1]);
      } catch {
        result = { answer: rawText };
      }
    } else {
      result = { answer: rawText };
    }
  }

  return {
    answer: result.answer || result.reply || "No response received.",
    reply: result.answer || result.reply || "No response received.",
    relevantFiles: Array.isArray(result.relevantFiles) ? result.relevantFiles : [],
    optionalMermaid: result.optionalMermaid
      ? cleanMermaid(result.optionalMermaid)
      : "",
    usedModel,
  };
}
