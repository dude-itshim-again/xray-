import os
import sys
import re
import json
import asyncio
import traceback
import httpx
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

def clean_mermaid(code: str) -> str:
    """Aggressively sanitize Mermaid code output from LLM."""
    if not code:
        return ""
    # Remove markdown code block wrappers
    code = re.sub(r"^```mermaid\s*", "", code, flags=re.MULTILINE)
    code = re.sub(r"^```\s*$", "", code, flags=re.MULTILINE)
    code = code.replace("```mermaid", "").replace("```", "")
    
    # Ensure it starts with graph TD
    code = code.strip()
    if not code.startswith("graph ") and not code.startswith("flowchart "):
        code = "graph TD\n" + code
        
    return code

load_dotenv()
api_key = os.getenv("GEMINI_API_KEY")
if api_key:
    genai.configure(api_key=api_key)

app = FastAPI(title="XRay-Flow API")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# --- FLATTENED SCHEMA (Gemini-Safe) ---
class TechItem(BaseModel):
    name: str
    category: str
    purpose: str
    evidence: str  # Exact signal from siteSignals that proves this tech is used

class AnalysisResponse(BaseModel):
    mode: str
    projectSummary: str
    techStack: List[TechItem]
    workflowSteps: List[str]
    mermaidCode: str
    diagramDataFlow: str
    diagramModuleMap: str

class AnalyzeRequest(BaseModel):
    url: str
    mode: str
    siteSignals: Optional[Any] = None

@app.get("/ping")
def ping():
    print("🟢 PING RECEIVED FROM EXTENSION!", flush=True)
    return {"status": "ok"}

@app.get("/health")
def health():
    return {"status": "ok", "gemini_configured": bool(api_key)}

def get_gemini_model(system_prompt: str):
    """Try gemini-2.5-flash first, then fallback to gemini-flash-latest or gemini-1.5-flash."""
    candidate_models = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-1.5-flash"]
    generation_config = {
        "response_mime_type": "application/json",
        "response_schema": AnalysisResponse,
        "temperature": 0.2,
    }
    
    for model_name in candidate_models:
        try:
            return genai.GenerativeModel(
                model_name=model_name,
                generation_config=generation_config,
                system_instruction=system_prompt,
            )
        except Exception:
            continue
    
    return genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        generation_config=generation_config,
        system_instruction=system_prompt,
    )

async def fetch_github_context(repo_url: str) -> dict:
    clean_url = repo_url.split("?")[0].split("#")[0].rstrip("/")
    parts = clean_url.split("github.com/")[-1].split("/")
    if len(parts) < 2:
        return {
            "owner": "",
            "repo": "",
            "note": "Invalid GitHub repository URL",
            "domFallback": True,
            "fileTree": [],
            "keyFiles": {},
        }
    owner, repo = parts[0], parts[1].replace(".git", "")

    headers = {"Accept": "application/vnd.github.v3+json", "User-Agent": "XRay-Flow"}
    gh_token = os.getenv("GITHUB_TOKEN")
    if gh_token and not gh_token.startswith("your_"):
        headers["Authorization"] = f"Bearer {gh_token}"

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            repo_res = await client.get(f"https://api.github.com/repos/{owner}/{repo}", headers=headers)
            if repo_res.status_code != 200:
                print(f"⚠️ GitHub API returned status {repo_res.status_code}, activating DOM fallback...", flush=True)
                return {
                    "owner": owner,
                    "repo": repo,
                    "note": f"GitHub API status {repo_res.status_code}, using scraped DOM signals",
                    "domFallback": True,
                    "fileTree": [],
                    "keyFiles": {},
                }
            repo_info = repo_res.json()
            default_branch = repo_info.get("default_branch", "main")

            tree_res = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1",
                headers=headers
            )
            tree_data = tree_res.json().get("tree", []) if tree_res.status_code == 200 else []
            file_paths = [item["path"] for item in tree_data if item.get("type") == "blob"][:120]

            # Priority 1: Root README.md (or readme.md) -> truncate to 1500 chars
            target_files: Dict[str, int] = {}
            for path in file_paths:
                if "/" not in path and path.lower() in ("readme.md", "readme"):
                    target_files[path] = 1500
                    break

            # Priority 2: Root manifest -> truncate to 1500 chars
            root_manifests = [
                "package.json", "requirements.txt", "pyproject.toml",
                "Cargo.toml", "go.mod", "Dockerfile"
            ]
            for m in root_manifests:
                if len(target_files) >= 4:
                    break
                if m in file_paths:
                    target_files[m] = 1500

            # Priority 3: If fewer than 3 files matched, pick up to 2 root or top-level code/HTML files (.html, .py, .ts, .js) -> truncate to 1200 chars
            if len(target_files) < 3:
                code_added = 0
                for path in file_paths:
                    if len(target_files) >= 4 or code_added >= 2:
                        break
                    if path not in target_files and path.endswith((".html", ".py", ".ts", ".js")):
                        if path.count("/") <= 1:
                            target_files[path] = 1200
                            code_added += 1

            # Parallel download of target files (max 4 files)
            async def fetch_file(path: str, max_chars: int):
                raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/{path}"
                try:
                    res = await client.get(raw_url)
                    if res.status_code == 200:
                        return path, res.text[:max_chars]
                except Exception as err:
                    print(f"⚠️ Error fetching {path}: {err}", flush=True)
                return path, None

            tasks = [fetch_file(p, max_c) for p, max_c in target_files.items()]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            fetched_files = {}
            for res in results:
                if isinstance(res, tuple) and res[1] is not None:
                    fetched_files[res[0]] = res[1]

            return {
                "owner": owner,
                "repo": repo,
                "description": repo_info.get("description"),
                "primaryLanguage": repo_info.get("language"),
                "branch": default_branch,
                "fileTree": file_paths,
                "keyFiles": fetched_files,
            }
    except Exception as e:
        print(f"⚠️ GitHub fetch exception ({e}), activating DOM fallback...", flush=True)
        return {
            "owner": owner,
            "repo": repo,
            "note": f"GitHub API error ({str(e)}), using scraped DOM signals",
            "domFallback": True,
            "fileTree": [],
            "keyFiles": {},
        }

@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_target(req: AnalyzeRequest):
    print(f"\n🟢 INCOMING REQUEST: mode={req.mode}, url={req.url}", flush=True)
    try:
        if req.mode == "github":
            print("📂 Fetching GitHub context...", flush=True)
            context_data = await fetch_github_context(req.url)
            # Merge siteSignals if rate-limited or keyFiles is empty
            if context_data.get("domFallback") or not context_data.get("keyFiles"):
                context_data["signals"] = req.siteSignals or {}
                if req.siteSignals and isinstance(req.siteSignals, dict):
                    if not context_data.get("fileTree") and req.siteSignals.get("githubFiles"):
                        context_data["fileTree"] = req.siteSignals.get("githubFiles", [])
                    if not context_data.get("keyFiles"):
                        context_data["keyFiles"] = {}
                    if req.siteSignals.get("githubReadme") and "README.md" not in context_data["keyFiles"]:
                        context_data["keyFiles"]["README.md"] = req.siteSignals.get("githubReadme")[:1500]
            print(f"⚡ GitHub context ready ({len(str(context_data))} chars). Calling Gemini...", flush=True)
        else:
            context_data = {"url": req.url, "signals": req.siteSignals or {}}

        system_prompt = """
        Analyze the target application. Return a JSON object matching the exact schema.
        Provide 3 valid Mermaid 'graph TD' diagrams:
        1. mermaidCode: High-level architecture.
        2. diagramDataFlow: Request lifecycle.
        3. diagramModuleMap: Component map.

        STRICT WEBSITE GROUND-TRUTH RULES:
        - You may ONLY list technologies in `techStack` that have direct proof in `signals` (e.g., script src paths, frameworkMarkers, customElements, apiCalls, stylesheets, or storageKeys).
        - For every TechItem, populate `evidence` with the exact signal found (e.g., "Found '/@vite/client' and '/src/main.tsx' in scripts", "Detected custom element <ytd-app>", or "Fetch call to 127.0.0.1:8000/api/auth").
        - Do NOT guess backend databases (like PostgreSQL, MongoDB, Prisma) on a live website unless explicitly exposed in `apiCalls` or `storageKeys` (like Supabase/Firebase URLs). If the backend database is hidden behind an API, only list the observed REST/GraphQL API endpoint!

        STRICT GITHUB GROUND-TRUTH RULES:
        - NEVER guess or hallucinate frameworks (like Next.js, React, Prisma, Tailwind, or Databases) if they are not explicitly evidenced in the provided fileTree, keyFiles, or website signals.
        - For every TechItem, populate `evidence` with the exact file or dependency found (e.g., "Found in package.json", "Found in requirements.txt", "Observed in fileTree").
        - If a repository only contains static HTML, CSS, JS, and Markdown files with no build step or backend, state that clearly in projectSummary and ONLY list the actual languages/files present (e.g., HTML5, CSS3, Vanilla JS, Markdown) in techStack.
        - Base all 3 Mermaid diagrams strictly on the actual files in fileTree (e.g., showing how README.md, report.html, and mindmap.html relate in a static repo).

        CRITICAL MERMAID RULES:
        - YOU MUST NOT use markdown code blocks (do not use ```mermaid). Return only the raw text.
        - You MUST use 'graph TD'.
        - Node IDs MUST be simple one-word alphabetical strings (e.g., A, B, WebServer, Database). NO spaces or dashes in Node IDs!
        - Node Labels MUST ALWAYS be wrapped in double quotes. 
        - CORRECT: WebServer["Main App (Next.js)"]
        - INCORRECT: Web-Server[Main App (Next.js)]
        """

        model = get_gemini_model(system_prompt)

        print("⏳ Calling Gemini API...", flush=True)
        prompt = f"TARGET: {req.url}\nDATA: {json.dumps(context_data)[:7500]}"
        
        try:
            response = model.generate_content(prompt)
        except Exception as api_err:
            # Fallback to gemini-flash-latest if gemini-2.5-flash errored
            print(f"⚠️ Primary model error ({api_err}), attempting fallback to gemini-flash-latest...", flush=True)
            fallback_model = genai.GenerativeModel(
                model_name="gemini-flash-latest",
                generation_config={
                    "response_mime_type": "application/json",
                    "response_schema": AnalysisResponse,
                    "temperature": 0.2,
                },
                system_instruction=system_prompt,
            )
            response = fallback_model.generate_content(prompt)

        print("✅ Gemini API responded successfully!", flush=True)
        data = json.loads(response.text)
        
        # Aggressively sanitize all Mermaid diagram outputs
        data["mermaidCode"] = clean_mermaid(data.get("mermaidCode", ""))
        data["diagramDataFlow"] = clean_mermaid(data.get("diagramDataFlow", ""))
        data["diagramModuleMap"] = clean_mermaid(data.get("diagramModuleMap", ""))
        
        return data

    except Exception as e:
        print("\n❌ BACKEND CRASH EXCEPTION:", flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
# --- CHAT SCHEMAS ---
class ChatRequest(BaseModel):
    url: str
    mode: Optional[str] = "website"
    question: Optional[str] = None
    message: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = []

# Gemini-safe schema without defaults
class ChatSchema(BaseModel):
    answer: str
    relevantFiles: List[str]
    optionalMermaid: str

class ChatResponse(BaseModel):
    answer: str
    reply: Optional[str] = None
    relevantFiles: List[str] = []
    optionalMermaid: Optional[str] = ""

# --- CHAT ENDPOINT ---
@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest):
    user_question = req.question or req.message or ""
    print(f"\n💬 INCOMING CHAT: {user_question}", flush=True)
    try:
        system_prompt = """
        You are an elite Software Architect assisting a developer. 
        Provide a concise, highly technical answer in Markdown format. 
        If asked about security or hacking, explain common architectural vulnerabilities for their stack and how to secure them, but do not provide exploit payloads.
        Return a JSON object matching the schema.
        """
        
        generation_config = {
            "response_mime_type": "application/json",
            "response_schema": ChatSchema,
            "temperature": 0.4,
        }

        # Try gemini-2.5-flash first, fallback to gemini-flash-latest or gemini-1.5-flash
        model_names = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-1.5-flash"]
        model = None
        for m_name in model_names:
            try:
                model = genai.GenerativeModel(
                    model_name=m_name,
                    generation_config=generation_config,
                    system_instruction=system_prompt,
                )
                break
            except Exception:
                continue

        if model is None:
            model = genai.GenerativeModel(
                model_name="gemini-2.5-flash",
                generation_config=generation_config,
                system_instruction=system_prompt,
            )
        
        prompt = f"Target URL: {req.url}\nMode: {req.mode}\nUser Question: {user_question}"
        
        try:
            response = model.generate_content(prompt)
        except Exception as e:
            print(f"⚠️ Primary chat model error ({e}), attempting fallback...", flush=True)
            fallback_model = genai.GenerativeModel(
                model_name="gemini-flash-latest",
                generation_config=generation_config,
                system_instruction=system_prompt,
            )
            response = fallback_model.generate_content(prompt)

        data = json.loads(response.text)
        
        # Populate reply alias for frontend compatibility
        if "answer" in data and not data.get("reply"):
            data["reply"] = data["answer"]
        elif "reply" in data and not data.get("answer"):
            data["answer"] = data["reply"]
        
        # Sanitize mermaid if the AI decided to generate a mini-diagram
        if data.get("optionalMermaid"):
            data["optionalMermaid"] = clean_mermaid(data["optionalMermaid"])
            
        return data

    except Exception as e:
        print("\n❌ CHAT EXCEPTION:", flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
