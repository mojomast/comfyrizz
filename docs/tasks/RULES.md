# Hard rules for every Comfyrizz task (Pi, Hermes, anyone)

1. **Do not spend Google Colab units or start Google Colab runtimes.** No `colab new`, `exec`, `run`, `upload`, `download`, `ssh`, `stop` or `drivemount` against real sessions. No HF token exists yet; Kyle approves every GPU run separately. Test only against fakes (a fake `colab` executable on PATH, a local fake Comfy v2 server). Read-only `colab --help` / `colab version` is fine.
2. **Do not modify or restart live Orbit**, and do not edit, move or delete anything in `<orbit checkout>` (server on 127.0.0.1:4318). Copy code out into this repo and add the header: `// Derived from Orbit (mojomast/orbitdesktop) <file>; relicensed MIT by the owner, Kyle Durepos.`
3. **Work only inside `<repo root>`.** Stay in the directories you own (docs/PLAN.md, "Owners"). Root files (`package.json`, `pnpm-workspace.yaml`, LICENSE, NOTICE, README, docs/SPEC.md, docs/PLAN.md) belong to DOLAN/Kyle: request changes in a board check-in.
4. **Commit locally, never push**, never create GitHub repos or remotes. Small commits prefixed with the task id (`A1: …`). Never rewrite or revert the other agent's commits; `git pull`-style merges are not needed (one local repo), but always `git add` only your own paths.
5. Write **"Google Colab"**, never bare "Colab", in prose, docs and UI copy (code identifiers like `colab/` are fine).
6. Never print, log or commit secrets (ORBIT_TOKEN, Orbit app keys, Google Colab tokens, HF or LLM keys). No secrets via `colab exec --env`.
7. Keep it lean: no cloud agents, no extra workers or subagents. No network calls at render time.
8. Box facts: Node is **v20.19.2** (spec says 22; target `>=20` and avoid Node-22-only APIs; if you truly need 22, say so on the board instead of installing a system Node). pnpm 9, Python 3.13, ffmpeg/ffprobe present. Use a project-local `.venv` for Python.

Board: the Orbit board of group "Comfyrizz build" `dba10adc-e6a5-42ff-b174-9d21d3cc5691`. CLI: `~/bin/collab-board dba10adc-e6a5-42ff-b174-9d21d3cc5691 list|checkin|update … --as <your handle>` (Pi = `pipi`, Hermes = `hermes`). Check in when you start, at each acceptance item, and when blocked; set `review` when done (DOLAN/Kyle moves it to done).
