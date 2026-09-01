# DevTwin Adoption Kit — What's included

Everything you need to drive adoption across your org/teams.

## Files in this kit

### For leadership / team leads

- **[ADOPTION.md](ADOPTION.md)** — 5-minute setup guide + FAQ (why DevTwin, common concerns)
- **[LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md)** — Week-by-week timeline to announce and track adoption
- **[ADOPTION_TRACKER.md](ADOPTION_TRACKER.md)** — Record projects, teams, wins, objections/responses

### For messaging

- **[MESSAGING.md](MESSAGING.md)** — Copy-paste templates for:
  - Slack (technical + less-technical versions)
  - Email to teams
  - GitHub Discussions
  - LinkedIn/Twitter
  - Internal wiki/handbook
  - 1-on-1 nudges

### For developers

- **[README.md](README.md)** — Updated with:
  - Quick Start (top of page)
  - "Why DevTwin matters" vs. bash (no secrets, no parsing, consistent)
  - New section: Adoption & team setup
- **[.mcp.json.example](.mcp.json.example)** — Template config developers can copy
- **[ADOPTION.md](ADOPTION.md)** — Individual developer section at the end

### For community

- **[Main.dc.html](Main.dc.html)** — Visual comparison card (DevTwin vs. bash)
- **[mcp-vs-bash-comparison.html](mcp-vs-bash-comparison.html)** — Published design canvas (interactive)

---

## How to use this

### To announce DevTwin (30 min total)

1. **Week 1:**
   - Review [ADOPTION.md](ADOPTION.md) — customize for your team
   - Pick your launch channel (Slack, email, or GitHub)
   - Copy a message from [MESSAGING.md](MESSAGING.md)

2. **Week 2:**
   - Post the announcement
   - Link to [ADOPTION.md](ADOPTION.md) in the thread
   - Watch for questions

3. **Month 2+:**
   - Track wins in [ADOPTION_TRACKER.md](ADOPTION_TRACKER.md)
   - Share monthly updates
   - Respond to objections using ADOPTION_TRACKER.md patterns

### To answer "Why DevTwin?"

Point to:
- **For developers:** "Check my environment" — see [Quick Start](README.md#quick-start-2-minutes)
- **For team leads:** "Safety + consistency + no secrets" — see [Why use DevTwin](README.md#why-use-devtwin-instead-of-just-asking-claude-to-run-bash-commands)
- **For skeptics:** "Token cost + tradeoffs" — see [Token cost](README.md#token-cost) and [Honest tradeoffs](README.md#honest-tradeoffs)
- **For the whole story:** [README.md](README.md)

### To set up per-project

1. Copy [.mcp.json.example](.mcp.json.example) → `.mcp.json` in repo root
2. Developers run: `uv pip install devtwin-mcp` (once)
3. Tell team: "Ask Claude: Check my environment"

See full setup in [ADOPTION.md](ADOPTION.md#step-2-add-to-your-project).

---

## Key messaging hooks

Use these to frame DevTwin across different audiences:

| Audience | Hook | Link |
|----------|------|------|
| **Developers** | "Stop guessing why builds fail" | [Quick Start](README.md#quick-start-2-minutes) |
| **Team leads** | "Onboarding friction drops, debugging accuracy rises" | [ADOPTION.md](ADOPTION.md#why-devtwin-matters-for-your-team) |
| **Engineering managers** | "Same tool works for Node, Python, Go, JVM, Rust, .NET..." | [Supported ecosystems](README.md#supported-ecosystems) |
| **Security-conscious** | "Secrets never exposed; only presence checked" | [Privacy model](README.md#privacy-model) |
| **Token watchers** | "1 call replaces 5–6 bash commands" | [Token cost](README.md#token-cost) |

---

## Timeline for success

- **Week 1:** Internal setup + announcement
- **Week 2–3:** Secondary channels (email, handbook, standups)
- **Month 1:** 25% awareness (rough estimate)
- **Month 2:** First projects configured; early wins documented
- **Month 3:** 50% of active projects set up; sustained adoption begins

The goal is *frictionless onboarding*, not forced adoption.

---

## Questions?

- **"Why would we use this?"** → [ADOPTION.md#why-devtwin-matters](ADOPTION.md#why-devtwin-matters-for-your-team)
- **"Is it safe?"** → [Security model](README.md#security-model)
- **"Does it cost extra tokens?"** → [Token cost](README.md#token-cost)
- **"How do I set it up?"** → [Quick Start](README.md#quick-start-2-minutes)
- **"Can I get it working this week?"** → Yes. See [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md).

