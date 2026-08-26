# 🏆 Clarity — Hackathon Winner Guide (Agent Harness Hackathon)

## Event (Verified from wemakedevs.org/hackathons/trueforge)
- Organizer: WeMakeDevs x TrueFoundry
- Dates: Aug 24–30, 2026 (Mon 8 AM – Sun 8 PM London)
- Format: Online from anywhere OR in-person SF
- Teams: Solo or up to 4 people
- Prizes: $10,000 total — NVIDIA DGX Spark ($5,000), Mac Mini ($1,000), Apple iPads, Keychron keyboards, swags + TrueFoundry job interviews

## Prize Tracks — Kaunsa track jeetna hai?
| Track | Prize | Kya karna hoga |
|---|---|---|
| Double-O (TrueFoundry) | NVIDIA DGX Spark | Best Use of TrueForge — agent real MCP tools use kare, code sandbox mein chale, irreversible step se pehle approval le |
| Q Branch (Qodo) | Mac Mini | Best Code Quality — saare PRs Qodo AI se review karwayein, review trail judges dekhein |
| Savile Row | Apple iPad (har member) | Best UI — aasaan, saaf interface jo agent ki har activity dikhaye |
| Field Report | Keychron Keyboard | Best blog post apne build ke baare mein |
| Radio Traffic | Swags | Top 10 social posts (WeMakeDevs/TrueFoundry/Qodo tag karein) |
| Universal Exports | Job interview | Top projects ko TrueFoundry interview |

## Clarity project — 4 tracks ke liye bana hai
1. **Double-O (DGX Spark):** `examples/trueforge-agent.mjs` TrueForge harness ko central runtime banata hai — MCP tool, sandbox execution, approval gate.
2. **Q Branch (Mac Mini):** Code modular, documented, zero-dependency core; saare PRs Qodo se review karwayein aur review trail README mein link karein.
3. **Savile Row (iPad):** White, mobile-first, clean UI — Live Activity trace, approval card, model settings. (Yeh UI ka asli kaam: agent ki har action visible + approval se pehle puchna.)
4. **Field Report:** Blog likhne ke liye README + FINAL_GUIDE already hai.

## Setup — 2 commands
```bash
./start.sh        # install + run (ya: npm start)
```
Demo mode bina key ke chalta hai. Live ke liye Settings se OpenAI / Groq / Claude / Gemini / Local (Ollama) mein se koi bhi choose karein, key paste karein.

## Submit karne se pehle (100% compliance checklist)
- [ ] TrueForge run karein: `npm run trueforge` (official npx package @truefoundry/trueforge)
- [ ] Agent ke paas kam se kam 1 real MCP tool (GitHub/Grafana/DB)
- [ ] Code execution sandbox mein (docker/node sandbox)
- [ ] Irreversible action par human approval pause + UI approval card
- [ ] Demo video (2–5 min): problem → agent kaam karte hue → harness visible → approval
- [ ] GitHub repo public, README with setup, screenshots
- [ ] Qodo se PR review karwayein (Q Branch track ke liye)
- [ ] Social posts mein @WeMakeDevs @TrueFoundry @Qodo tag karein
- [ ] Blog post publish karein (Field Report track)

## Judging focus (organizer ke hisaab se)
- Kya TrueForge project ka CENTER hai, ya sirf chat wrapper?
- Kya demo mein agent tool use karta hai, sandbox mein code chalta hai, aur irreversible step se pehle rukta hai?
- Kya code aisa hai jo koi stranger clone karke samajh sake?

## Testing (already passed)
- `npm test` → 5/5 unit tests pass
- Playwright desktop + mobile UI smoke test → PASS (calculator, approval card, approve flow, no JS errors)
- /api/health, /api/providers (OpenAI, Groq, Anthropic, Gemini, Local), /api/agent demo, /api/approve → verified

## Important Honesty Note
Prize jeetne ki "100% guarantee" koi nahi de sakta — winners ka faisla judges karte hain. Yeh project har prize track ke criteria par bana hai, aur agar aap final TrueForge + Qodo + demo video steps complete karein toh aap ke chances maximum honge. Is guide ko follow karein aur final official rules wemakedevs.org par dobara check karein.
