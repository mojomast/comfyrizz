# Pull Request Template

## Description
Please describe the changes you're proposing in this PR.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Test addition
- [ ] Release scan allowlist update
- [ ] Other

## Checklist

### Code Quality
- [ ] I have run `pnpm test` and all tests pass
- [ ] I have run `pnpm run test:scan` and there are no new findings
- [ ] I have linted the code (if applicable)

### Licence & Credits
- [ ] I have reviewed the licence/credits rules for new assets
- [ ] Any new assets include proper attribution
- [ ] No unlicensed third-party content is included

### Security & Secrets
- [ ] I have not added any secrets, tokens, or private keys
- [ ] No `~/home` or `/workspace` paths are in the codebase
- [ ] No tailnet host addresses are included
- [ ] I have reviewed the release scan allowlist if adding new paths

### Release Scan
- [ ] I have run `node scripts/release-scan.mjs` locally and it is clean
- [ ] If new findings were added, they are allowlisted in `scripts/release-scan.allow.json` with a valid reason

### Documentation
- [ ] I have updated CONTRIBUTING.md if the workflow changes
- [ ] README.md reflects any user-visible changes

## Additional Context
Add any other context about the PR here, including screenshots, motivation, and related issues.

---

PRs must not break the release scan. If you add new files or paths that trigger secret/path rules, you must add them to `scripts/release-scan.allow.json` with a valid reason.