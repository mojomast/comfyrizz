# Contributing to ComfyRizz

## Setup

See [RELEASE_CHECK.md](docs/RELEASE_CHECK.md) for the full release check workflow.

### Clean clone

```bash
git clone --branch chore/quick-wins <repo> /tmp/comfyrizz-cleanclone && cd /tmp/comfyrizz-cleanclone
pnpm i --frozen-lockfile                              # pnpm 10.34.6, node 22.23.3: OK
uv venv .venv -p 3.12 && uv pip install -p .venv -r pipeline-py/requirements-dev.txt -e pipeline-py
pnpm test:all                                          # build:libs first, then run all tests
pnpm --filter @comfyrizz/renderer render:example       # CPU example export
```

### Release scan

```bash
node scripts/release-scan.mjs                          # scans tracked files for secrets/private paths
```

Run with `--json` to print findings as JSON. Exit 1 = non-allowlisted findings found.

The scanner reads `scripts/release-scan.allow.json` for allowlist entries. Each entry is `{path, rules, reason}`. Matching hits are counted as `allowed` and never fail the run.

Run `pnpm test:scan` to run the unit tests and then the scan.

### Tests

```bash
pnpm test                                              # runs pnpm build:libs && pnpm -r --if-present test
pnpm run test:scan                                     # runs release-scan unit tests and then the scan
pnpm run test:all                                      # runs all: test + pnpm run test:py + pnpm run test:scan
```

### License & Credits Rules for New Assets

All new assets added to the repository must follow these rules:

1. **Third-party content** - Any included models, audio, video, or images must have appropriate licenses. Add license information to `THIRD_PARTY_LICENSES.md` or the asset's source directory.

2. **No secrets** - Never commit API keys, tokens, passwords, or private keys. If a secret is needed for development, add it to `scripts/release-scan.allow.json` with a valid reason and ensure it does not appear in tracked files.

3. **Workspace/home paths** - Absolute workspace or home-directory paths from a personal machine are prohibited. If a script needs a custom path, use a relative path or an environment variable instead.

4. **Tailnet hosts** - Tailnet host addresses (`.ts.net`) are prohibited for security reasons.

5. **Credit format** - When using third-party content, include a credit in the format: `![Artist Name](URL) — License: <type>`

### No Secrets Policy

- The release scan (`scripts/release-scan.mjs`) checks for 14 rule categories including private keys, Hugging Face tokens, OpenAI-style keys, GitHub tokens, Google API keys, OAuth tokens, AWS keys, Slack tokens, bearer literals, assigned secrets, tailnet hosts, Tailscale IPs, workspace paths, and home-box paths.
- If a finding is legitimate and must be kept, add it to `scripts/release-scan.allow.json` with the rule, matching path glob, and a concise reason.
- Running `pnpm test:scan` must pass with exit 0 before submitting a PR.