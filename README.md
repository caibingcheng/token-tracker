# Token Tracker

LLM Token Usage Dashboard.

## Related Plugins:

- [token-tracker-opencode](https://github.com/caibingcheng/token-tracker-opencode)
- [token-tracker-openwebui](https://github.com/caibingcheng/token-tracker-openwebui)

## Deploy with Docker (VPS)

### Prerequisites

- Docker and Docker Compose installed
- API keys ready for token ingestion

### Quick Start

1. **Clone and configure**

```bash
git clone https://github.com/caibingcheng/token-tracker.git
cd token-tracker
cp .env.example .env
# Edit .env with your API keys
```

2. **Build and run**

```bash
docker compose up -d
```

The app will be available at `http://localhost:3001` (or your configured port).

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SQLITE_DATABASE_PATH` | Yes | Path to SQLite database file (default: `/app/data/token-tracker.db`) |
| `API_KEYS` | Yes | API keys for token ingestion, comma-separated |
| `HIDDEN_PROVIDERS` | No | Providers to anonymize in the UI |

The SQLite database file is automatically created on first API request — no manual migration needed.

## Development

```bash
npm install
cp .env.example .env.local
# (Docker deployment uses .env; local dev uses .env.local)
npm run dev
```

## License

MIT
