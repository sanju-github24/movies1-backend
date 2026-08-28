# anchormovies gate — Cloudflare Worker

Serves the private R2 bucket (and Backblaze, behind `b2/`) against a signed,
expiring token. This is the source of what runs at `stream.1anchormovies.buzz`;
it lived only in the Cloudflare dashboard until now, which meant no history and
no way to review a change before it went live.

## Three contracts, one gate

| | path | origin gate | token | served from |
|---|---|---|---|---|
| **Playback** | `movies/<slug>/…` | **enforced** — `ALLOWED_HOSTS` | 24h | R2 (or B2 behind `b2/`) |
| **Download** | `downloads/<slug>/…` | exempt | 24h | R2 |
| **Download** | `drive/<fileId>/<name>` | exempt | 24h | **Google Drive** |

`drive/` is the one that costs nothing. The file stays on the 5TB Drive that is
already paid for, and Cloudflare fetches it per request — so it is never stored
twice, and no download bandwidth comes off our own server. It goes through the
Drive **API** rather than the web endpoint deliberately: the web endpoint
interrupts anything over ~100MB with a virus-scan page, and the API does not.

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
| `GDRIVE_CLIENT_ID` `GDRIVE_CLIENT_SECRET` `GDRIVE_REFRESH_TOKEN` | secrets; only for `drive/` delivery |

### Drive secrets

They are the same OAuth credentials rclone already holds, so there is no second
authorisation to do. Print them with:

```bash
python3 - <<'EOF'
import json, re, os
conf = os.path.expanduser("~/.config/rclone/rclone.conf")
body = re.search(r"\[gdrive\](.*?)(?=\n\[|\Z)", open(conf).read(), re.S).group(1)
tok  = json.loads(re.search(r"token\s*=\s*(\{.*?\})\s*\n", body, re.S).group(1))
for k in ("client_id", "client_secret"):
    print(k.upper(), "=", re.search(rf"^\s*{k}\s*=\s*(.+)$", body, re.M).group(1).strip())
print("GDRIVE_REFRESH_TOKEN =", tok["refresh_token"])
EOF
```

Add each as a **secret** (Settings → Variables → Encrypt), not a plain variable.
The refresh token does not expire while the OAuth app stays published.

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
