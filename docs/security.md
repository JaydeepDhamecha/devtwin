# Security Model

DevTwin runs entirely on the developer's own machine, with no cloud
backend, and reads state a local developer already has access to. Its
threat model is therefore mostly about **not amplifying** what an AI agent
using it can do, and **not leaking secrets** into the model's context.

## Privacy: secrets never reach the model

- `security/secrets.py` classifies environment variable *names* as
  likely-secret using name patterns (`PASSWORD`, `TOKEN`, `SECRET`,
  `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY`, `AUTH`, `CREDENTIAL`, ...).
- For secret-named variables, DevTwin only ever reports **presence**
  (`present: true/false`) -- never the value, never a truncated preview.
- For non-secret variables, previews are capped at 200 characters.
- `.env`-style files are only ever scanned for variable *names*
  (`environment.load_dotenv_var_names`) -- values are never read into
  memory for that purpose.
- `dev_precommit` flags staged files that *look like* secrets (`.env`,
  `.pem`, `id_rsa`, `credentials.json`, ...) by filename only; it does not
  read or report their contents.

## No arbitrary command execution

There is no `execute_shell`, `run_command`, or similarly generic tool.
Every command DevTwin can run is:

1. Discovered, not supplied by the model -- adapters recognize commands
   like `pytest`, `./gradlew test`, `npm test`, `cargo test` from project
   files; `dev_check`'s `run` parameter can only narrow that recognized
   set, never add to it.
2. Checked against an executable allowlist (`security/permissions.py`)
   before it's ever passed to `subprocess.run`.
3. Checked against a denylist of dangerous-looking arguments (`reset`,
   `--force`, `down`, `rm`, `kill`, `prune`, ...).
4. Run with `shell=False`, an explicit argv list, a timeout, and captured
   (size-capped) output. See `core/runner.py`.

## Action classification

Every DevTwin capability is classified in `security/approvals.py`:

| Class | Meaning | Examples |
|---|---|---|
| `read_only` | Never mutates anything | `dev_detect`, `dev_health`, `dev_drift`, `dev_explain_failure`, `dev_project_info`, `dev_dependencies`, `dev_services`, `dev_precommit` |
| `safe` | Runs recognized, non-destructive commands (may leave build artifacts) | `dev_check` |
| `requires_approval` | Would change machine state (starting a service, installing dependencies) | steps inside a `dev_prepare` plan |
| `dangerous` | Destructive; DevTwin never executes this itself | `git reset --hard`, `rm -rf`, `docker compose down`, `kill -9`, deleting lockfiles |

`dev_prepare` **only ever plans** -- it returns an ordered list of steps,
each carrying its `action_class`, and never executes any of them. Turning a
plan into action is entirely the calling agent's (and the human's)
decision, outside DevTwin's scope.

## No destructive actions, ever

DevTwin never runs, and has no code path that could run:

- `git reset --hard`, `git push --force`, `git clean`
- `rm -rf` or any recursive delete
- `kill -9` or any process termination
- `docker compose down`, container/volume removal
- lockfile deletion or `.env` secret modification
- runtime version changes on the host

## Read operations are safe by default

Everything that only reads state -- file existence, `--version` output,
port-listening checks, `git status`, `docker ps` -- runs without
confirmation, because it can't change anything. This is what makes DevTwin
usable for "check my environment" style requests without a human having to
approve every call.

## Reporting a vulnerability

See `SECURITY.md` at the repository root.
