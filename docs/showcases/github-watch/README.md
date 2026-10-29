# GitHub tracker fixture showcase

URL: http://localhost:8768

Start with `node scripts/serve-github-watch-showcase.mjs` after `yarn build`.
The page runs the production GitHub planners and Discord notification serializer
against fixture data. It shows their actual payloads, not a Discord UI mockup,
and sends no Discord messages.

Reviewed captures: [desktop](desktop.png) at 1440px and [mobile](mobile.png) at
390px. Both cover initial empty baseline, new PR, new issue, closed-between-polls
issue, draft PR, disabled pings, silent commit, silent merge, and retryable error.
The tracker has no visible loading state or disabled controls. No horizontal
overflow was observed on mobile. Browser tabs were closed after capture.

Implementation fingerprint: `GitHubCommitWatch.ts` SHA-256 `368b0be99455`
(displayed in both captures). Fixtures contain no credentials or private data.
