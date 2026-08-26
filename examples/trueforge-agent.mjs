// Clarity x TrueForge — example of wiring an approval-first agent to the harness.
// This mirrors the Agent Harness Hackathon flow: MCP tools, sandbox execution,
// human approval before irreversible steps, and a visible trace for the UI.
//
// Replace the marked lines with the official TrueForge SDK when you install it:
//   npm i @truefoundry/trueforge   (see https://www.wemakedevs.org/hackathons/trueforge)
import { Agent, tool, sandbox } from '@truefoundry/trueforge'; // ← official harness import
import { mcp } from '@modelcontextprotocol/sdk';              // ← MCP client for tools

const agent = new Agent({
  model: process.env.AGENT_MODEL || 'gpt-4o-mini',
  provider: process.env.AGENT_PROVIDER || 'openai', // or anthropic / gemini / local
});

// 1) Real tools connected through MCP (e.g. GitHub, Grafana, a database)
agent.use(mcp({ server: 'npx -y @modelcontextprotocol/server-github' }));

// 2) Sandboxed code execution — generated code never touches the host
agent.use(sandbox({ image: 'node:20-slim' }));

// 3) Human approval gate before anything irreversible
agent.before('*', async ({ action }) => {
  if (action.irreversible) {
    const approved = await requestHumanApproval(action.plan); // UI shows the approval card
    if (!approved) throw new Error('Action rejected by human.');
  }
});

// 4) Emit trace events so the Clarity UI can render Live Activity
agent.on('tool.call', ({ name, args }) => trace('tool', name, args));
agent.on('sandbox.exec', ({ code, result }) => trace('sandbox', code, result));

async function main() {
  const reply = await agent.run(process.argv[2] || 'Investigate the payment-failures alert.');
  console.log(reply.text);
}
main().catch(console.error);
