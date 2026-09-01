# DevTwin Adoption Guide

## For team leads & repo maintainers

### Why DevTwin matters for your team

1. **Onboarding friction drops** — "just cloned, what do I do?" → `dev_health()` gives exact setup steps
2. **Fewer wrong diagnoses** — debugging isn't guesswork; Claude sees actual environment state
3. **No more secret-leak anxiety** — developers never worry about `.env` being dumped into conversation
4. **Works across the whole org** — same tool works on Node, Python, Go, JVM, Rust, .NET, etc.

### Setup for your project (5 minutes)

#### Step 1: Install DevTwin (one-time, per developer)

**Prerequisites:** Python 3.10+ (usually already on macOS/Linux)

Developers pick one:

```bash
# Option A: uv (fastest)
brew install uv              # if not already installed
uv pip install devtwin-mcp

# Option B: pipx (simplest)
brew install pipx            # if not already installed
pipx install devtwin-mcp

# Option C: pip (standard)
pip install devtwin-mcp
# or with venv:
python3 -m venv ~/.devtwin-venv
source ~/.devtwin-venv/bin/activate
pip install devtwin-mcp
```

#### Step 2: Add to your project

Drop a `.mcp.json` in your repo root:

```json
{
  "mcpServers": {
    "devtwin": {
      "command": "devtwin"
    }
  }
}
```

Or one command:

```bash
claude mcp add devtwin devtwin --scope project
```

#### Step 3: Tell your team

Post this to Slack/Discord:

```
🚀 Environment checking just got easier

We've set up DevTwin for this project. Next time you're debugging why tests fail, building is broken, or you just cloned and aren't sure what to do:

Just ask Claude: "Check my development environment" or "Why does `npm test` fail?"

Instead of guessing, Claude sees:
✓ Correct runtime versions installed
✓ Dependencies fully installed
✓ Required services (Postgres, Redis, etc.) running
✓ Git status
✓ All at once, no parsing bash output, no secret leaks

Works in Claude Code, Claude Desktop, Cursor, Windsurf — wherever you use Claude.

Try it: https://github.com/YOUR-ORG/YOUR-REPO#quick-start
```

### Verification

Developers can confirm it's wired up:

```bash
# In Claude Code or your editor:
# Ask Claude: "Run dev_detect"
# If it works, you'll see your project's ecosystems detected
```

### Common questions

**"Does this cost extra tokens?"**  
Only if you actually use it. When connected, the tool schemas add ~1,400 tokens/turn (true of any MCP server). But for multi-environment or multi-question sessions, the savings from one structured call vs. 5 bash commands usually pay for that. See [Token cost](README.md#token-cost).

**"Is it safe?"**  
Yes. Only allowlisted, read-only operations. No arbitrary command execution, no destructive actions. See [Security model](README.md#security-model).

**"Can it work without Claude Code?"**  
Yes. Claude Desktop, Cursor, Windsurf, any MCP-compatible client. Only requires `devtwin` binary in PATH.

**"What if our CI uses different Node/Python/etc. than dev?"**  
Good question. DevTwin reports *your local environment*, not CI's. CI discrepancies are worth catching — ask Claude to compare: "What drifts between my environment and our CI?" and paste your CI config. DevTwin will spot version mismatches.

### Measuring adoption

Track these signals:

- How many developers have tried it (ask your team)
- Which ecosystems it catches most issues on (Python? Node? JVM?)
- Whether onboarding time drops (anecdotal)
- Slack/Discord reactions to the announcement post

No telemetry home-phones — these are your own observations.

### Roadmap

Next ecosystems: Elixir, Dart, C/C++ (CMake/Bazel), Nix.  
Next services: MySQL, MongoDB, Kafka, RabbitMQ.

See [`README.md#roadmap`](README.md#roadmap).

---

## For individual developers

**Install** (one time, pick one):
```bash
uv pip install devtwin-mcp          # fastest
# or
pipx install devtwin-mcp            # simplest
# or
pip install devtwin-mcp             # standard
```

**Add to your MCP client** (Claude Code / Claude Desktop / Cursor):
```json
{
  "mcpServers": {
    "devtwin": {
      "command": "devtwin"
    }
  }
}
```

**Use it:**
- "Check my environment"
- "Why does `npm test` fail?"
- "What should I do before committing?"

That's all. No configuration per-project if your team already set up `.mcp.json` in the repo.
