# confirm-gate

A lightweight confirmation gate for AI agents before performing destructive actions.

## The Problem

AI agents that can delete containers, repos, volumes, and files are powerful — but a misunderstood instruction or a hallucinated confirmation can cause real damage. Chat-based confirmations are too easy to skim past.

## The Solution

Before any destructive action, the agent:
1. POSTs a request to this service describing exactly what will be deleted
2. Gets back a URL and sends it to the user
3. The user opens the URL, reads a full-screen warning, and clicks a button
4. A one-time code appears (e.g. `YANKEE-2387-HOTEL`)
5. The user pastes the code back to the agent
6. The agent verifies the code — only then does it proceed

No code = no action. Codes expire in 5 minutes and are single-use.

## API

```bash
# Create a confirmation request
curl -X POST http://localhost:3051/api/request \
  -H 'Content-Type: application/json' \
  -d '{"action":"Delete container foo","details":"This will permanently remove the foo container and all its data."}'
# Returns: {"token":"...","url":"http://confirm.mesh/confirm/<token>","expires_in":300}

# Verify a code the user pasted back
curl -X POST http://localhost:3051/api/verify \
  -H 'Content-Type: application/json' \
  -d '{"code":"YANKEE-2387-HOTEL"}'
# Returns: {"valid":true,"action":"...","details":"..."}
```

## Running

```bash
docker run -d \
  --name confirm-gate \
  --restart unless-stopped \
  -v confirm-data:/data \
  -p 127.0.0.1:3051:3051 \
  -e BASE_URL=http://confirm.yourdomain.com \
  ghcr.io/yourusername/confirm-gate:latest
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3051` | Port to listen on |
| `DATA_FILE` | `/data/tokens.json` | Token persistence path |
| `BASE_URL` | `http://confirm.mesh` | Base URL shown to users in links |

## Stack

- Node.js + Express
- File-based token store (no database needed)
- Zero native dependencies — works on any platform
