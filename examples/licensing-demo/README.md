# Openverse licensing demo

A deterministic, offline example of the real `@comfyrizz/sources` rights gate.

The fixture `package.json` holds two Openverse image candidates:

- `openverse-approved` — CC BY 4.0, approved by the user, with stored attribution. It passes `evaluateLicense`, ships in `package.zip` and appears in the credits.
- `openverse-refused` — CC BY-NC 4.0, blocked by the v0.1 non-commercial policy. It is listed in `excluded` with a reason, is absent from the archive entries, and is never credited as shipped.

No network calls or real media are used: the test supplies small synthetic bytes for both assets and reads the demo fixture straight from disk.

## Run the test

```sh
pnpm --filter @comfyrizz/sources test
```

Or build and run just this demo: `pnpm --filter @comfyrizz/sources build && node --test packages/sources/dist/test/licensing-demo.test.js`.
