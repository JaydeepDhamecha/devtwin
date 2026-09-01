# DevTwin Launch Checklist

Copy this and track your launch week-by-week.

## Week 1: Internal setup

- [ ] Merge README updates (Quick Start section added)
- [ ] Confirm `.mcp.json.example` is in repo root
- [ ] Review ADOPTION.md — customize for your org if needed
- [ ] Review MESSAGING.md — pick which channels to use
- [ ] Create a Slack/Discord channel or thread for feedback (optional)

**Time: 30 min**

---

## Week 2: First announcement

Pick ONE primary channel to launch in. The others follow.

### Option A: Slack/Discord (technical teams)
- [ ] Post announcement from MESSAGING.md > Slack > "Announcement (technical teams)"
- [ ] Pin the post
- [ ] Link to [ADOPTION.md](ADOPTION.md) in thread
- [ ] Watch for reactions/questions for 24 hours

### Option B: Email (less technical / broader group)
- [ ] Send email from MESSAGING.md > Email
- [ ] CC team leads / engineering leads
- [ ] Include link to ADOPTION.md

### Option C: GitHub Discussions (open source / multi-team)
- [ ] Create a "Announcements" discussion
- [ ] Post "Why should I use DevTwin?" from MESSAGING.md > GitHub Discussion
- [ ] Enable reactions

**Pick one. Post it.** Timing matters less than consistency.

**Time: 15 min to post, 30 min to monitor first day**

---

## Week 2–3: Secondary channels

- [ ] Tag DevTwin in weekly team standup (1-2 min)
- [ ] Add to onboarding docs / developer handbook (link to ADOPTION.md)
- [ ] Add `.mcp.json.example` link to contributing guide ("Here's what DevTwin is, here's how we configured it")

**Time: 30 min total**

---

## Week 3–4: Collect early signals

- [ ] Ask 3–5 developers: "Did you try DevTwin? If not, what's the blocker?"
- [ ] Fill in ADOPTION_TRACKER.md with early wins (usually "made debugging faster" or "caught a version mismatch")
- [ ] If someone hits a bug, file it and link them to [Security model](README.md#security-model) / [Privacy model](README.md#privacy-model)

**Time: 30 min**

---

## Optional: Sustained adoption (Month 2+)

- [ ] Monthly: Update ADOPTION_TRACKER.md with new projects, teams, wins
- [ ] Monthly: Share wins in a Slack update ("This month, DevTwin caught 12 environment issues")
- [ ] Quarterly: Review objections in ADOPTION_TRACKER.md; adjust messaging if patterns emerge

---

## Copy-paste Slack post (ready to go)

```
🚀 Environment checking just got easier

We've set up DevTwin for this project. Next time you're debugging why tests fail, builds are broken, or you just cloned and aren't sure what to do:

Just ask Claude: "Check my development environment" or "Why does `npm test` fail?"

Instead of guessing, Claude sees:
✓ Correct runtime versions installed
✓ Dependencies fully installed
✓ Required services (Postgres, Redis, etc.) running
✓ All at once, no parsing bash output, no secret leaks

Works in Claude Code, Claude Desktop, Cursor, Windsurf — wherever you use Claude.

**Get started:** 
1. `uv pip install devtwin-mcp` (one time)
2. Add to your MCP client config
3. Ask Claude: "Check my development environment"

Questions? See [ADOPTION.md](ADOPTION.md) or reply in thread.
```

---

## Success metrics (non-binding)

- **Week 1:** 10% of developers aware (based on poll or Slack activity)
- **Month 1:** 25% have tried it (loose estimate from questions/reactions)
- **Month 2:** 50% of active projects have `.mcp.json` configured
- **Month 3:** 3+ documented wins in ADOPTION_TRACKER.md

These are soft targets — adoption is gradual and uneven. The goal is _spreading awareness and making it frictionless to try_.

