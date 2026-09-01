# DevTwin Adoption Tracker

Track adoption and impact signals across your teams/projects.

## By project

| Project | Teams using | Ecosystems | Setup date | Feedback |
|---------|------------|------------|------------|----------|
| Example Project | 5 developers | Node.js, Python | 2024-Q3 | Catching runtime version mismatches |
| | | | | |
| | | | | |

## By team

| Team | Projects connected | Common issues caught | Notes |
|------|------------------|-------------------|-------|
| Frontend | 3 | Node version drift, missing npm deps | "Saves time debugging fresh clones" |
| Backend | 2 | Python version, missing services | |
| Mobile | 2 | Android SDK, JVM version | "Caught Gradle wrapper divergence from CI" |

## Signals to track

- **Discovery:** How many developers know DevTwin exists? (poll)
- **Adoption:** How many have `devtwin` installed? (`pip list | grep devtwin`)
- **Usage:** How many projects have `.mcp.json` configured?
- **Impact:** Common issues caught (runtime drift, missing services, secret-safe debugging)
- **Feedback:** Slack reactions, questions, feature requests

## Common wins to share

Paste real examples here as you see them:

- "Debugged why tests failed across 3 machines in 30 seconds instead of 20 minutes of back-and-forth"
- "Caught that CI uses Node 20 but dev was on 16 — would have shipped broken"
- "New hire asked 'why can't I build this?' → dev_health showed missing Postgres"
- "No more pasting .env files or worrying about accidental secret leaks in Slack"

## Objections & responses

| Objection | Response |
|-----------|----------|
| "Seems like overkill for my project" | True for stable projects, but useful on first clone or after environment changes. Try it once, see if it saves time. |
| "Adds token overhead" | Only if connected and unused. Register per-project (in `.mcp.json`), not user-wide, so tax only applies when you need it. |
| "We already have a `make doctor` script" | DevTwin goes further: structured JSON an agent can reason over, works across all projects, and catches cross-ecosystem issues. Good complement to your script. |
| "Doesn't work with [IDE/tool]" | DevTwin is MCP-standard. If your tool supports MCP, it works. See [Installation](README.md#installation). |

---

**Goal:** 50% of active projects configured within 6 months of launch.
