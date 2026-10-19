// U2: the settings card's copy and its contract with the server, checked as source (the web app has no
// DOM harness, so this guards the strings and ids the card is made of - the same approach as the
// backend-labels test next door).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const CARD = readFileSync(join(WEB, "src", "colab-card.ts"), "utf8");
const MAIN = readFileSync(join(WEB, "src", "main.ts"), "utf8");
const HTML = readFileSync(join(WEB, "index.html"), "utf8");

test("the card says Google Colab, in full, everywhere it speaks (U2)", () => {
  const visible = CARD.match(/(return|`)[^\n]*Google Colab[^\n]*/g) ?? [];
  assert.ok(visible.length >= 3, "the card talks about the CLI in its own words");
  assert.equal(/[^ ]Colab\b(?! G4)/.test(CARD.replace(/Google Colab/g, "")), false, "never the bare short form");
  assert.match(CARD, /Google Colab CLI is not installed/);
  assert.match(CARD, /not signed in/);
  assert.match(CARD, /compute units left/);
});

test("the card's three buttons and its log are the ids the app wires (U2)", () => {
  for (const id of ["colab-recheck", "colab-signin", "colab-copy", "colab-log", "colab-status"]) {
    assert.ok(CARD.includes(`id="${id}"`) || CARD.includes(`#${id}`), `${id} is not in the card`);
  }
  assert.match(MAIN, /mountSettingsCard/);
  assert.match(MAIN, /apiFetch/, "the card uses the app's own authenticated fetch");
  assert.match(HTML, /colab/i, "the settings surface has somewhere to mount it");
});

test("the card never handles a credential of its own (U2)", () => {
  // the token is the CLI's, the sign-in is a relay, and no field of the status payload is a secret
  assert.equal(/token\s*[:=]\s*[\'"][^\'"]+[\'"]/.test(CARD), false, "no token literal");
  assert.equal(/localStorage|sessionStorage/.test(CARD), false, "the card stores nothing");
  assert.match(CARD, /never reads or stores your credentials/);
});

test("the status line is the four states, not two (U2)", () => {
  assert.match(CARD, /is not installed yet/);
  assert.match(CARD, /but not signed in/);
  assert.match(CARD, /compute units left/);
  assert.match(CARD, /did not report an account/);
  assert.match(CARD, /Checking the Google Colab CLI/);
});
