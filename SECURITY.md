# Security Policy

DevTwin is a local-first MCP server: it runs on a developer's own machine
and does not send data to any cloud backend. See `docs/security.md` for the
full security model (secret redaction, command allowlisting, action
classification).

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting for this repository
(Security tab -> "Report a vulnerability"), or email the maintainers listed
in the repository's GitHub profile.

Include:

- A description of the issue and its potential impact
- Steps to reproduce
- Affected version(s)

We aim to acknowledge reports within 5 business days.

## Supported versions

Only the latest released version of `devtwin-mcp` receives security fixes
while the project is pre-1.0.

## Scope

In scope:

- Secret/credential leakage through any DevTwin tool output
- Command injection or unintended command execution
- Path traversal or unintended filesystem writes outside a specified
  workspace
- Privilege escalation via any DevTwin capability

Out of scope:

- Vulnerabilities in third-party tools DevTwin merely *detects* (e.g. a bug
  in `docker`, `npm`, or `gradle` itself)
- Issues requiring an already-compromised MCP client or host machine
