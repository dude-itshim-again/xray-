import os
import sys
import re
import json
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

@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_target(req: AnalyzeRequest):
    print(f"\n🟢 INCOMING REQUEST: mode={req.mode}, url={req.url}", flush=True)
    try:
        if req.mode == "github":
            context_data = {"url": req.url, "note": "GitHub scraping placeholder"}
        else:
            context_data = {"url": req.url, "signals": req.siteSignals or {}}

        system_prompt = """
        Analyze the target web application. Return a JSON object matching the exact schema.
        Provide 3 valid Mermaid 'graph TD' diagrams:
        1. mermaidCode: High-level architecture.
        2. diagramDataFlow: Request lifecycle.
        3. diagramModuleMap: Component map.

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
        prompt = f"TARGET: {req.url}\nDATA: {json.dumps(context_data)[:3000]}"
        
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
