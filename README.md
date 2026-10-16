# XRay Flow 🔍⚡

**XRay Flow** is an intelligent developer Chrome extension and FastAPI backend that analyzes any live website or GitHub repository. It automatically inspects the tech stack, traces workflow logic, and renders interactive architecture flowcharts and diagrams directly in your Chrome Side Panel.

---

## ✨ Features

- **🌐 Live Website Inspection**: Scrapes DOM scripts, meta tags, and technologies to detect frameworks, libraries, analytics, and CDNs.
- **🐙 GitHub Repository Analysis**: Inspects file structure, configuration files (`package.json`, `requirements.txt`, `Cargo.toml`, etc.), and architecture.
- **🤖 AI-Powered Synthesis**: Uses Google Gemini to understand complex architectures, generate summaries, and map step-by-step workflows.
- **📊 Interactive Visualizations**:
  - Main Architecture Flowchart
  - Data Flow Diagram
  - Module Dependency Map
- **🧩 Native Chrome Side Panel**: Seamless side panel integration with quick actions, zoomable flowchart viewer, and export capabilities.

---

## 🏗️ Project Architecture

```
.
├── xray-flow/
│   ├── backend/             # FastAPI backend service
│   │   ├── main.py          # API endpoints & Gemini AI integration
│   │   ├── requirements.txt # Python dependencies
│   │   └── .env.example     # Backend environment template
│   └── extension/           # Chrome Extension (Manifest V3)
│       ├── public/          # Manifest & background/content scripts
│       ├── src/             # React + TypeScript + Tailwind UI
│       │   ├── App.tsx      # Main Side Panel UI
│       │   └── FlowchartViewer.tsx # Interactive Mermaid diagram viewer
│       ├── package.json
│       └── vite.config.ts
├── package.json             # Root workspace scripts
└── .gitignore
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18+ and `npm`
- **Python**: 3.10+
- **Gemini API Key**: [Get one from Google AI Studio](https://aistudio.google.com/)

---

### 2. Backend Setup

```bash
cd xray-flow/backend

# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows:
.\venv\Scripts\activate
# macOS/Linux:
# source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment variables
cp .env.example .env
```

Open `.env` and configure:
```env
GEMINI_API_KEY=your_gemini_api_key_here
GITHUB_TOKEN=your_optional_github_token_here
```

Start the backend:
```bash
python -m uvicorn main:app --reload --port 8000
```
Backend runs at `http://localhost:8000`.

---

### 3. Chrome Extension Setup

```bash
cd xray-flow/extension

# Install dependencies
npm install

# Build extension
npm run build
```

#### Load into Chrome:
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in top right).
3. Click **Load unpacked**.
4. Select the `xray-flow/extension/dist` folder.
5. Click the XRay Flow extension icon in your Chrome toolbar to open the Side Panel.

---

## 🛠️ Tech Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, Lucide Icons, Mermaid.js, SVG Pan/Zoom
- **Extension API**: Chrome Extensions Manifest V3 (Side Panel, Content Scripts, ActiveTab)
- **Backend**: FastAPI, Uvicorn, HTTPX, Pydantic, Python-Dotenv
- **AI Engine**: Google Gemini API (`gemini-1.5-flash` / `gemini-2.0-flash`)

---

## 📄 License

MIT
