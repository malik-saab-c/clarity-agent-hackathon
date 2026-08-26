# 🚀 I Built an Approval-First AI Agent — Here's How (and Why It Matters)

*Published for the WeMakeDevs x TrueFoundry Agent Harness Hackathon*

## The Problem
Chatbots answer questions. But real work happens when an AI *acts* — opening a pull
request, editing a file, packaging a release, investigating an alert. The hard part
isn't the model. It's the *safety layer* around it.

## The Idea: Clarity
I built **Clarity** — an approval-first AI agent that:
- Runs on **TrueForge** (TrueFoundry's open-source agent harness) as its runtime
- Uses **real tools**: file create/edit, folder management, zip packaging, URL fetching
- **Streams every step live** — you see "connecting tools → agent thinking → writing file"
  in real time, nothing is hidden or simulated
- **Pauses for human approval** before any irreversible action
- Accepts **file and image uploads** into a local workspace the AI can actually read
- Works beautifully on **mobile** with a clean white UI

## How It Works
Clarity connects to TrueForge's API (provider config → agent → session → turn stream),
which runs the agent loop with model calls, tool calls, and approval events. I used
Groq's fast `gpt-oss-20b` model through an OpenAI-compatible custom provider.

Every message streams back token-by-token (`model.message.delta`), and tool calls
appear live in the activity panel. If TrueForge is offline, Clarity honestly switches
to direct provider mode — no fake progress, no pretending.

## What I Learned
1. **Approval-first design changes everything** — users trust agents that ask.
2. **Real streaming beats fake spinners** — showing actual events builds confidence.
3. **TrueForge makes harness infrastructure easy** — I focused on the agent, not the plumbing.
4. **Mobile-first UI is a differentiator** — judges and users love opening it on a phone.

## Try It
```bash
npm install && npm run start-all
```
Open http://localhost:4173, add a Groq key, and ask Clarity to "create a project folder
with a README and a calculator script, then package everything into a zip."

## Links
- Repository: https://github.com/malik-saab-c/clarity-agent-hackathon
- Hackathon: https://www.wemakedevs.org/hackathons/trueforge
- Harness: https://trueforge.dev

*Special thanks to WeMakeDevs, TrueFoundry, Qodo, and the Agent Harness community. Agents you can trust — that's the future. 🏆*
