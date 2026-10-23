# Research sources

Research is opt-in per request, and **you** choose the source mode
(`packages/sources/src/capture.mjs`, `apps/server/src/productions/claims.mjs`):

- **Use my URLs** (`user_urls`): only the URLs you supplied are fetched.
- **Search for me** (`search`): the agent's search finds URLs to fetch.

A request starts as `pending_user_decision` and nothing is fetched until you choose. The choice is
stored and cannot be changed, and the agent can never make it.

Captures are server-side and public-web only: http(s) without credentials, every DNS answer checked
against loopback, private, link-local and metadata ranges, redirects re-checked hop by hop, capped
bodies and deadlines. Each source keeps exactly its URL, fetch date, excerpt and sha256. A failed
fetch is reported, never replaced with invented text. Fetched text is quoted as untrusted data and
never authorizes a tool call, spend or policy change.
