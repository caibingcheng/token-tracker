# Token Tracker — Personal AI Gateway

A lightweight personal AI Gateway: unify access to multiple upstream LLM APIs (OpenAI-compatible / Anthropic / Gemini) behind a single set of standard protocol endpoints, proxy requests and responses transparently, and automatically parse and record token usage along the way. Ships with a Token Usage Dashboard and an admin UI.

![Dashboard Screenshot](./public/readme-screenshot.png)

## Why this project

I use various AI agents on different devices, and I wanted to keep track of how I actually use them. I first tried recording usage through various agent plugins, but that approach worked poorly. The project eventually grew into its current shape: I added a gateway layer so all traffic flows through one entry point where tokens get recorded transparently — clients need zero plugins.

Before writing my own, I looked at and tried other options:

- **LiteLLM / NEW API**: solid and full-featured, but built for teams and enterprises — more than I need for personal use.
- **omniRouter**: positioned as a personal gateway, but it felt overly complex to set up, and its pitch leans heavily toward free APIs.

For personal, everyday use I actually prefer **paid APIs** — like paying a phone bill. Free options always come with nagging worries: they can be unstable, and there's nobody to complain to. Free APIs are fine for non-sensitive testing, not for daily use.

## Features

- **Multi-protocol proxy**: catch-all routes at `/v1/*` (OpenAI / Anthropic) and `/v1beta/*` (Gemini); the body is passed through unchanged, no protocol conversion
- **Zero-plugin onboarding**: clients just change their `base_url` and key — no plugins required
- **Automatic accounting**: input / output / cache tokens are parsed from responses (streaming and non-streaming) and attributed to an agent via its virtual key
- **Multi-key failover per upstream**: several keys per upstream, auto-switching on 429/5xx/timeout; no retry once streaming has started
- **Virtual keys**: stored encrypted with AES-256-GCM, revocable individually; the key name is the stats dimension
- **Admin UI**: `/admin` to configure upstreams, fetch models, manage virtual keys, and view usage

## Client Setup

| Client | Configuration |
|---|---|
| OpenAI-compatible (Codex / OpenCode, etc.) | `base_url = http://host:3000/v1`, `api_key = vk-xxx` |
| Claude Code (Anthropic protocol) | `ANTHROPIC_BASE_URL = http://host:3000`, `ANTHROPIC_AUTH_TOKEN = vk-xxx` |
| Gemini-protocol clients | `base_url = http://host:3000`, key via `x-goog-api-key` or `?key=` |

Virtual keys (the `vk-` prefix) are created in `/admin`. Sharing one key across devices does not distinguish between devices.

## Deploy with Docker (VPS)

### Prerequisites

- Docker and Docker Compose installed

### Quick Start

```bash
docker pull ghcr.io/caibingcheng/token-tracker:latest
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml: set ADMIN_API_KEY, GATEWAY_SECRET, SQLITE_DATABASE_PATH
docker compose up -d
```

After the first start:

1. Open `http://host:3000/admin` and log in with any key from `ADMIN_API_KEY` (if unset, a first-run setup wizard appears)
2. Add an upstream (name, protocol, Base URL), configure its API key, and fetch/select the models to enable
3. Create a virtual key and configure your client as in the table above

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SQLITE_DATABASE_PATH` | Yes | Path to the SQLite database file (default `/app/data/token-tracker.db`) |
| `ADMIN_API_KEY` | Suggested at first run | Admin API keys for the management surface, comma-separated (Dashboard / admin / stats APIs all need it; if unset and the DB has no key, a first-run setup wizard appears). Legacy name `API_KEYS` still supported (deprecated) |
| `GATEWAY_SECRET` | Yes | Gateway master key, AES-256-GCM (32-byte hex/base64, generate with `openssl rand -hex 32`); if missing, the proxy and admin APIs return 503 |
| `HIDDEN_PROVIDERS` | No | Providers to anonymize in the UI; group syntax `name:p1,p2` (multiple groups separated by `;`); providers in the same group are merged into one row in stats |
| `API_CACHE_TTL_MS` | No | SELECT cache TTL (ms, default 10000) |
| `API_CACHE_MAX_SIZE` | No | Max cache entries (default 1000) |

The SQLite database file is created automatically on the first request (with incremental migrations); no manual setup needed.

> **⚠️ First-run wizard security note**: if `ADMIN_API_KEY` is not set and the DB has no key, anyone who can reach the web UI can be the first to claim the admin key (fail-open design). **In production, always set `ADMIN_API_KEY`** or protect the first-configuration window with a firewall / internal network. The wizard's rate limiting only prevents brute force, not first-run takeover.

## Development

```bash
npm install
cp .env.example .env.local
# Required: SQLITE_DATABASE_PATH, GATEWAY_SECRET
npm run dev
npm test        # vitest unit tests
npm run lint
```

## API Overview

| Route | Auth | Description |
|---|---|---|
| `/v1/*`, `/v1beta/*` | Virtual key | Proxy entry points (pass-through) |
| `/api/auth/login` | Raw API key (+ optional TOTP) | Login to exchange for a session token |
| `/api/dashboard` and other stats APIs | Session token (`X-API-Key` header) | Dashboard data |
| `/api/admin/*` | Session token | Upstream / virtual key / security settings management |
| `/admin` | Page + session token | Admin UI |
| `/` | Page + session token | Usage Dashboard |

> All `/api/*` routes (except `login`) only accept the session token obtained from login. Script example:
> ```bash
> TOKEN=$(curl -s -X POST http://host:3000/api/auth/login \
>   -H 'Content-Type: application/json' \
>   -d '{"apiKey":"your-api-key"}' | jq -r .token)
> curl -s http://host:3000/api/dashboard -H "X-API-Key: $TOKEN"
> ```
>
> If you forget the login key, delete the `admin_api_key` row from the SQLite `settings` table to fall back to the `ADMIN_API_KEY` env.

## License

MIT
