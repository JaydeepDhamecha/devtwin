# DevTwin Messaging Templates

Copy-paste messaging for different channels. Adapt as needed.

---

## Slack / Discord

### Announcement (technical teams)

```
🚀 DevTwin is live — your environment checks just got better

When Claude helps you debug, it's been guessing:
❌ "Is Node v18 or v20 installed?" → runs `node --version`
❌ "Where did Postgres go?" → tries `docker ps`, `lsof`, `ps aux`
❌ "Why are tests failing?" → 5-6 separate commands, parsing each

Now, one call:
✅ `dev_health()` → tells Claude what's actually running, broken, or missing

Benefits:
• No secret leaks (env vars checked for presence, never read)
• Token-efficient (one structured call replaces 5-6 bash commands)
• Works everywhere (Claude Code, Claude Desktop, Cursor, etc.)
• Consistent (same checks across Node, Python, Go, JVM, Rust, .NET, etc.)

Get started: `uv pip install devtwin-mcp` + add to your MCP config

Try it: Ask Claude "Check my development environment" or "Why does `npm test` fail?"

Questions? See [ADOPTION.md](ADOPTION.md)
```

### Announcement (less technical)

```
🔧 Better debugging for your project

When Claude helps you debug broken builds or weird test failures, it used to have to guess a lot. Now it can see what's *actually* installed on your machine and running:

• Right Node/Python/Go version?
• Dependencies all there?
• Postgres/Redis running?
• Any uncommitted Git changes?

All at once. No more parsing terminal output. No more secrets in conversation.

**Try it:** Ask Claude "Check my environment" or "Why doesn't my build work?"

Install: `uv pip install devtwin-mcp` (one time)

Then add to your MCP config and you're done. Questions? [ADOPTION.md](ADOPTION.md)
```

### 1-on-1 nudge (when someone is debugging)

```
Hey, trying to debug? DevTwin might help. Just ask Claude "Check my development environment" — it'll tell you if there's a Node version mismatch, Postgres isn't running, dependencies are stale, etc. Saves a lot of guessing.

Install if you haven't: `uv pip install devtwin-mcp`
```

---

## Email

### To a team / engineering org

**Subject:** DevTwin is live: environment checks in Claude

```
Hi team,

We've set up DevTwin, a tool that gives Claude a real view of your local environment. When you ask Claude for help debugging:

Instead of:
• Claude guesses which version of Node you have
• Claude makes 5-6 separate bash calls
• Claude risks reading your .env file

You get:
• One structured call: "What's my environment?"
• Claude sees runtime versions, dependencies, services, Git state
• Secrets never touched — only presence checked

This makes debugging faster, safer, and more accurate.

**Get started:**

1. Install: `uv pip install devtwin-mcp` (one time)
2. Add to your MCP config (once per client)
3. Ask Claude: "Check my development environment"

Works in Claude Code, Claude Desktop, Cursor, Windsurf.

**More info:** See ADOPTION.md in the repo.

Questions? Reply to this thread.

—
```

---

## GitHub Issue / PR Checklist

### Pre-launch checklist

```markdown
- [ ] README has Quick Start at the top
- [ ] ADOPTION.md covers team setup + FAQ
- [ ] MESSAGING.md has copy-paste templates
- [ ] Example `.mcp.json` shown in docs
- [ ] Token costs clearly explained (connection tax vs. per-call savings)
- [ ] Security model linked prominently
- [ ] Post announcement to Slack/Discord
- [ ] Email engineering team / org admins
- [ ] Add DevTwin to contributor onboarding docs
- [ ] Track early adoption signals (Slack reactions, questions, try reports)
```

---

## GitHub Discussion / Forum Post

### "Why should I use DevTwin?"

```
DevTwin solves a real problem: when Claude debugs your build failures, broken tests, or "fresh clone doesn't work," it's working blind.

It has to *guess*:
- "What Node version are you running?" → `node --version`
- "Is Postgres running?" → `docker ps`, `lsof`, `ps aux` (5+ tries)
- "Are dependencies installed?" → parse `package.json`, `npm list`
- "What's broken?" → risk reading your `.env`

**DevTwin removes the guessing.** One structured call gives Claude:
- Actual runtimes + what's required
- Dependency state (fresh, stale, mismatched)
- Services running/stopped
- Git state
- All at once

**Real cost savings:** 5-6 bash commands + output parsing (~1500 tokens) → one call (~800 tokens + schema tax, but the schema is paid once per session)

**Safety:** No arbitrary command execution, no secret leaks, works in any MCP client.

See the [comparison](https://claude.ai/code/artifact/4a85ce00-e3c0-45c7-8fe3-4dcf61b75ff8) for details.
```

---

## LinkedIn / Twitter

```
When AI debugs your code, it's been guessing at your environment.

New: DevTwin gives Claude real-time visibility into your dev setup:
✓ Right Node/Python/Go version?
✓ Dependencies installed?
✓ Required services running?
✓ Git ready to commit?

All at once. No secret leaks. One structured call replaces 5-6 bash commands.

Try it: https://github.com/YOUR-ORG/devtwin-mcp
```

---

## Internal documentation / Onboarding

### Wiki / Developer Handbook entry

```markdown
## Environment checking with DevTwin

Our projects use DevTwin — a tool that lets Claude see your actual development environment.

When you ask Claude "Why doesn't my build work?", instead of guessing, it can check:
- Your Node/Python/Go version vs. what the project requires
- Whether dependencies are installed correctly
- If required services (Postgres, Redis, etc.) are running
- Git state and uncommitted changes

**Install once:**
```bash
uv pip install devtwin-mcp
```

**Add to your Claude setup** (Claude Code / Claude Desktop / Cursor):
```json
{
  "mcpServers": {
    "devtwin": { "command": "devtwin" }
  }
}
```

**Use it:**
Ask Claude: "Check my development environment" or "Why can't I build this?"

See [ADOPTION.md](../../ADOPTION.md) for full setup and FAQ.
```

