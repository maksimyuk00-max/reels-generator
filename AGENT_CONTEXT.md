# Project Context: Reels Generator

## Overview
Reels Generator is a professional tool for monitoring Instagram Reels, analyzing performance, and generating high-quality content using a multi-stage AI pipeline. It integrates social media monitoring (Reddit/Threads) with automated video production and device management (Android/iPhone).

## Technical Architecture
- **Frontend:** React + Vite + Electron.
- **Backend:** FastAPI (Python) acting as a bridge between the Electron UI and system tools.
- **Database:** SQLite (`reels.db`) stores account data, reel statistics, and history.
- **Deployment:** Local installation; relies on specific system paths for tools like Claude CLI and Ollama.

## Key Functional Pillars

### 1. Instagram Automation
- **Monitoring:** Direct HTTP requests to Instagram API for account info and reel listing (avoiding heavy library overhead).
- **Analytics:** Enrichment of view counts with exponential backoff to handle rate limiting.
- **Publishing:** Uses `instagrapi` for the actual `clip_upload` process.

### 2. Content Generation Pipeline
The project uses a sophisticated AI chain to create videos:
- **Step 1 (Ideation):** Claude Sonnet (via Claude CLI) generates creative prompts and scripts.
- **Step 2 (Visualization):** Google Flow (via Playwright/Headless Chrome) handles visual generation.
- **Step 3 (Refinement):** RIFE (Real-Time Intermediate Flow Estimation) provides frame interpolation for smooth, professional motion.
- **Prompting:** Uses a dedicated `prompts.json` and master markdown prompts for consistent styles (e.g., Samurai, Ninja).

### 3. Social Intelligence
- **Reddit/Threads Monitor:** Scans RSS feeds/APIs for viral topics and generates tailored draft replies via Claude or Ollama.
- **Personas:** Uses specific persona text files (e.g., `persona-sayana.txt`) to maintain a consistent Tone of Voice (ToV).

### 4. Hardware Integration
- **Android:** Integration via uiautomator2 for automation and account scanning.
- **iPhone:** Integration via MobAI for clipboard management, screenshots, and OCR.

## Critical Setup & Dependencies
- **Claude CLI:** Essential for the primary prompt generation loop.
- **Ollama:** Used for local LLM draft generation (supports various models).
- **Settings:** Configuration is stored in `%APPDATA%/reels-generator/settings.json`.
- **Session Management:** Uses `sessionid` cookies from a browser for Instagram authentication.

## Maintenance Notes for the Agent
- When working on this project, always check `python/main.py` for API endpoints and `electron/main.js` for IPC handlers.
- Be mindful of Instagram rate limits; always use the implemented backoff logic.
- Ensure `claude.exe` and `ollama` are accessible in the environment before running generation tasks.
