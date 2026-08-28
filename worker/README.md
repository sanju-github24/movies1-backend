# anchormovies gate — Cloudflare Worker

Serves the private R2 bucket (and Backblaze, behind `b2/`) against a signed,
expiring token. This is the source of what runs at `stream.1anchormovies.buzz`;
it lived only in the Cloudflare dashboard until now, which meant no history and
no way to review a change before it went live.

## Two contracts, one gate

| | path | origin gate | token | edge cache |
|---|---|---|---|---|
| **Playback** | `movies/<slug>/…` | **enforced** — `ALLOWED_HOSTS` | 24h, scoped to `movies/<slug>` | segments, 1 year |
| **Download** | `downloads/<slug>/…` | **exempt** | 24h, scoped to `downloads/<slug>` | under 500MB only |

The origin gate exists to stop another site embedding our player. A download
link has no player to embed, and it has to survive being pasted into a new tab,
handed to a download manager, or opened by a browser that sends no referrer —
all of which arrive with no `Referer` and would otherwise get `Forbidden origin`.
The signature is the authorization there, and it still expires in 24h.

## Settings

| | |
|---|---|
| `BUCKET` | R2 bucket binding → `anchormovies` |
| `SIGNING_SECRET` | secret; must match the site backend's |
| `ALLOWED_HOSTS` | comma list, playback only. Blank allows any |
| `DOWNLOAD_PREFIX` | optional, default `downloads/` |
| `B2_KEY_ID` `B2_APP_KEY` `B2_BUCKET` `B2_ENDPOINT` | only if serving from Backblaze |

## Links

Both minted by the site backend, which holds the same secret:

```
GET /api/movie-stream?path=movies/<slug>/master.m3u8&hours=24
GET /api/download-link?path=downloads/<slug>/<file>&hours=24
```

`sig = HMAC-SHA256(SIGNING_SECRET, "<first two path segments>:<exp>")`, and the
URL carries `?t=<exp>.<sig>`. Signed per request, so a page always hands out a
link inside its window rather than storing one that goes stale.

## Deploying

Live at `anchormovies-gate.sanjusanjay0444.workers.dev`, fronted by
`stream.1anchormovies.buzz`.

**Dashboard (recommended).** Workers & Pages → `anchormovies-gate` → Edit code →
paste `anchormovies-gate.js` → Deploy. Bindings, vars and secrets are attached
to the worker, so nothing is disturbed.

**CLI.** `npx wrangler deploy` — but read the warning at the top of
`wrangler.toml` first: a deploy replaces bindings and vars with whatever the
file declares, so an incomplete file silently unbinds `BUCKET` and every stream
starts failing. Secrets are unaffected.

Either way, commit what you deployed.

### Did it take?

The origin gate is the tell. With no `Referer`:

```bash
# before: "Forbidden origin"   after: "Link expired or invalid"
curl -s "https://stream.1anchormovies.buzz/downloads/x/y.mkv?t=1.bad"

# unchanged either way: playback still refuses a stranger
curl -s "https://stream.1anchormovies.buzz/movies/x/master.m3u8?t=1.bad"
```

The download path reaching the token check — and failing it, because that token
is nonsense — is exactly the new behaviour.
