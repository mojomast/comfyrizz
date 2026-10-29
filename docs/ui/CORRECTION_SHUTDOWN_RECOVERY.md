# Recovering an interrupted chat correction

Chat correction runs block new managed work if their Google Colab shutdown is
not confirmed. The Easy screen shows the run and, when available, the expected
session name. The server never stops a session merely because its name matches.

For a finished run with an unconfirmed teardown, inspect `colab sessions` on the
server's machine. If a session is still running, identify its owner before
stopping it. The official CLI supports `colab stop -s NAME` to stop a particular
session. Then choose **Check shutdown**. The server reads the provider's session
list again and clears the block only when the listing is parseable, has no
matching session or unnamed orphan, and the run record has not changed.

For an interruption during allocation without a finished run record, an empty
listing cannot prove that an in-flight allocation will not appear later. The
screen therefore keeps the block and directs the user to inspect sessions and
contact support. There is currently no automatic reconciliation or UI override
for this case. Older records that do not identify the original package also
remain blocked because the session cannot be attributed safely. Do not edit the
run record or delete the latch to bypass it.

Reference: [Google Colab CLI session management](https://github.com/googlecolab/google-colab-cli#session-management).
