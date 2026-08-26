# Clarity — Project Write-Up (Agent Harness Hackathon)

## What the agent does
Clarity is an approval-first AI agent. Give it a job — "create a project with a README
and a calculator script, then package everything into a zip" — and it:
1. Plans the work and shows the plan,
2. Uses real tools (file create/edit, folder create, zip packaging, URL fetch, uploads),
3. Streams every step live to the UI (model.message.delta, tool.call events),
4. Pauses for explicit human approval before any irreversible action,
5. Stores all files and uploads locally in `data/workspace/`.

## How it uses TrueForge
Clarity is not a thin chat wrapper. TrueForge is the central runtime:
- **Provider:** Groq (`openai/gpt-oss-20b`) configured as an OpenAI-compatible custom
  provider on TrueForge via `POST /api/v1/settings/model-providers`.
- **Agent:** registered on TrueForge (`POST /api/v1/agents`) as `clarity` with model
  `groq/gpt-oss-20b`.
- **Session + Turn:** each user message creates a TrueForge session
  (`POST /api/v1/sessions`) and streams a turn (`POST /api/v1/sessions/{id}/turns`,
  SSE) — the agent loop, tool calls, and approval events all come from TrueForge.
- **Live trace:** the UI renders TrueForge's real events (turn.created,
  model.message.delta, tool.call, approval.requested, turn.done). No simulated progress.

## Architecture
```
Browser (mobile-first white UI)  ⇄  Clarity Node server (localhost:4173)
                                          ⇄  TrueForge (localhost:8790, agent loop)
                                          ⇄  Groq API (openai/gpt-oss-20b)
Clarity also hosts real tools: file/image uploads → data/workspace/uploads,
file ops + zip packaging → data/workspace, URL fetch → HTTP, sandbox → whitelisted shell.
```

## Honesty & transparency
- If TrueForge is offline, Clarity clearly shows "Direct mode" and streams straight
  from the provider. Nothing is simulated or hidden.
- The project was built during the hackathon window (Aug 24–30, 2026).
- AI coding assistants were used; usage is disclosed per Rule 12.
