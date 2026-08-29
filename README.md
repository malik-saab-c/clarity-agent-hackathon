# Clarity — Agent Harness Hackathon Submission (v3)
**100% REAL TrueForge integration — verified working end-to-end:**
Clarity UI → TrueForge (localhost:8790) → Groq (openai/gpt-oss-20b) live SSE streaming.
## 🚀 Quick Start (Terminal / PC)

> **Note on names:** When you download this repository from GitHub (Code ▾ → **Download ZIP**),
> the file is named `clarity-agent-hackathon-main.zip` and it extracts into the folder
> `clarity-agent-hackathon-main/`. (If you downloaded an older shared bundle instead, its
> file/folder names may differ — adjust the two commands below accordingly.)

1. Extract the downloaded repository:
   ```bash
   unzip clarity-agent-hackathon-main.zip
   ```
2. Enter the project folder:
   ```bash
   cd clarity-agent-hackathon-main
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start everything (TrueForge on :8790 + Clarity UI on :4173):
   ```bash
   npm run start-all
   ```

Open http://localhost:4173 — status badge shows **TrueForge online**.
Then paste your Groq key in Model connection and chat. Every reply streams live
from TrueForge (model.message.delta events) — nothing is simulated.
## Real tools (all in data/workspace/, all approval-gated for irreversible ops)
 * 📄 File create / edit / write
 * 📁 Folder create
 * 🗑 File delete (approval required)
 * 📦 ZIP package (approval required, real zip)
 * 📤 File & image upload → saved locally to uploads/
 * 🌐 URL fetch (real HTTP)
 * 💻 Sandbox commands (whitelist: ls, cat, echo, pwd, date, wc, head, tail, grep, find)
 * 🧮 Safe calculator
 * 🖼 Image preview + download links in Files panel
## TrueForge integration details (verified against live server)
| Step | Endpoint | Status |
|---|---|---|
| Provider (Groq custom, OpenAI-compatible) | POST /api/v1/settings/model-providers | ✅ 201 |
| Agent clarity (model groq/gpt-oss-20b) | POST /api/v1/agents | ✅ 201 |
| Session | POST /api/v1/sessions | ✅ 201 |
| Turn (SSE) | POST /api/v1/sessions/{id}/turns | ✅ streams model.message.delta |
Fallback: if TrueForge is offline, Clarity honestly switches to **Direct mode**
and streams from the provider directly (badge shows "Direct"). No fake progress.
## Providers
Groq (gpt-oss-20b), OpenAI, Claude, Gemini, Local/Ollama — selectable in UI.
## Tests (all pass)
 * npm test → 10/10 unit tests
 * Playwright UI (desktop + mobile): TrueForge online badge, real streamed reply,
   TrueForge activity trace, 0 JS errors.
## 📱 Termux Setup (Android, 3GB RAM)

> **Important (Android filesystem):** Run `npm install` from **Termux internal storage
> (`~/`)**, not from `/sdcard` or `Download`. Node packages use symlinks, and Android's
> `/sdcard` filesystem rejects them with **EPERM / symlink errors**. The `cp` step below
> moves the project into Termux's home directory first.

1. Install Termux requirements (first time only):
   ```bash
   pkg update -y && pkg upgrade -y
   pkg install -y nodejs-lts git unzip
   termux-setup-storage
   ```
2. Extract the downloaded ZIP (from the Download folder):
   ```bash
   cd ~/storage/downloads
   unzip clarity-agent-hackathon-main.zip
   ```
3. Move the project into Termux internal storage (avoids symlink/EPERM errors):
   ```bash
   cp -r clarity-agent-hackathon-main ~/
   cd ~/clarity-agent-hackathon-main
   ```
4. Install dependencies:
   ```bash
   npm install
   ```
5. Start the application:
   ```bash
   npm run start-all
   ```

Open http://localhost:4173 in a browser. AI runs on Groq cloud — phone stays light.
## Hackathon compliance
TrueForge central runtime ✅ · real tools ✅ · human approval ✅ · live trace ✅ ·
file/image workspace ✅ · mobile UI ✅ · Qodo PR review (see FINAL_GUIDE.md) ✅
Official event: https://www.wemakedevs.org/hackathons/trueforge
## 🎬 Demo Video
Watch the live demo (with voiceover):
```bash
# play locally
demo/demo_clarity.mp4

```
> The video shows the real app: TrueForge online status, live streaming response, file creation with approval, zip packaging, and the live activity trace.
> 
## Qodo Code Review Evidence
> **Requirement (Hackathon Rule 10):** Every submission must include a link to at least
> one representative merged pull request containing meaningful hackathon code, one or two
> sentences on what Qodo surfaced and what you changed or intentionally dismissed, and a
> pull request history showing the completed review, your decisions, and a follow-up review
> against the final code.
> 
**Setup done:** Qodo is configured for this repository (one admin install covers the whole
team; Qodo is free for open source).
**Review PR (completed and merged):**
 * Pull request #1 — https://github.com/malik-saab-c/clarity-agent-hackathon/pull/1
 * Status: **Merged** (Qodo review is visible in the PR conversation)
 * Qodo result: **Bugs 0 · Rule violations 0 · Requirement gaps 0**
 * What Qodo surfaced: Qodo reported no material bugs, rule violations, or requirement gaps.
 * What I changed / dismissed: No changes were required from this review because the report found no material issues.
 * Evidence screenshot:
 * Follow-up review against final code: **PR #2 — https://github.com/malik-saab-c/clarity-agent-hackathon/pull/2** (merged; Qodo review: Bugs 0 · Rule violations 0 · Requirement gaps 0). docs/evidence/qodo-pr-1-merged.png
## 📢 Published Content (Field Report + Swags tracks)
- **Blog post (dev.to):** https://dev.to/malik_ibrahim_e4ab895386a/clarity-agent-harness-project-truefoundry-387e
- **LinkedIn post:** https://www.linkedin.com/posts/malik-ibrahim-664b48430_github-malik-saab-cclarity-agent-hackathon-activity-7498696497212059648-cpLi

## Provider setup and model discovery

Choose OpenAI, Groq, Claude, Gemini, or Local/Ollama in the UI. Enter that provider's own API key and click **Find models**; Clarity calls the provider's real models endpoint and fills a selectable list. You can also type any custom model identifier manually. A failed provider call shows the actual HTTP/provider error instead of silently pretending it worked.

## Response and approval behavior

Provider reasoning is separated from the final response in a collapsible Thinking panel. TrueForge SSE events are displayed as real tool/turn activity. Workspace write, delete, and zip requests are executed only after approval; rejecting an approval does not execute it.
