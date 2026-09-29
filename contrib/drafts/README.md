# Drafts actions for Blygger Studio

Post the current [Drafts](https://getdrafts.com) draft to a Blygger Studio blyg
as a fragment, either published immediately or saved as a studio draft.
Needs the quick-post endpoint (`POST /api/post`) and a `POST_TOKEN` set on
the server.

Adapted from [miguelito4/drafts-blyg](https://github.com/miguelito4/drafts-blyg),
which publishes by committing a file to a GitHub repo instead. This version
talks to a running Blygger Studio.

## Server

Set a long random token (at least 32 chars) as `POST_TOKEN`: in `.dev.vars` for
`wrangler dev`, or `wrangler secret put POST_TOKEN` on Cloudflare. The token can
only call `POST /api/post`. It can't edit, withdraw or read anything else.

## Drafts

1. New action **Publish to blyg**, with one **Script** step containing `blyg-action.js`.
   Set `site` in CONFIG to your blyg's origin.
2. Duplicate it as **Draft to blyg** and set `publish: false`.
3. On first run, Drafts asks for the token and stores it as the credential
   `blyg <host>`, which both actions share.

Published drafts get the tag `blyg-published` (the link is copied to the
clipboard). Studio drafts get `blyg-drafted`. The 1000-character check matches
the server's fragment cap.
