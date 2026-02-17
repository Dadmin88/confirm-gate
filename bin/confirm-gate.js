#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);

// --help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
confirm-gate — destructive action confirmation gate for AI agents

USAGE
  confirm-gate [options]

OPTIONS
  --port <n>        Port to listen on          (default: 3051)
  --base-url <url>  Base URL for confirm links  (default: http://localhost:3051)
  --data <path>     Directory for token store   (default: ~/.confirm-gate)
  --pin <code>      Require PIN to confirm      (default: none)
  --version         Print version and exit
  --help            Show this help

ENVIRONMENT
  PORT, BASE_URL, DATA_FILE, CONFIG_FILE, CONFIRM_PIN — override any of the above
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM — email for PIN recovery

EXAMPLES
  confirm-gate
  confirm-gate --port 8080 --base-url https://confirm.example.com
  confirm-gate --pin mysecretpin

DOCKER
  docker run -d --name confirm-gate --restart unless-stopped \\
    -v confirm-data:/data -p 127.0.0.1:3051:3051 \\
    -e BASE_URL=https://confirm.yourdomain.com \\
    ghcr.io/dadmin88/confirm-gate:latest
`);
  process.exit(0);
}

// --version
if (args.includes('--version') || args.includes('-v')) {
  const { version } = require('../package.json');
  console.log(version);
  process.exit(0);
}

// Parse named flags
function getFlag(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const port    = getFlag('--port');
const baseUrl = getFlag('--base-url');
const dataDir = getFlag('--data');
const pin     = getFlag('--pin');

if (port)    process.env.PORT = port;
if (baseUrl) process.env.BASE_URL = baseUrl;
if (pin)     process.env.CONFIRM_PIN = pin;

// Default data path: ~/.confirm-gate when running outside Docker
if (dataDir || !process.env.DATA_FILE) {
  const os   = require('os');
  const path = require('path');
  const dir  = dataDir || require('path').join(os.homedir(), '.confirm-gate');
  if (!process.env.DATA_FILE)   process.env.DATA_FILE   = path.join(dir, 'tokens.json');
  if (!process.env.CONFIG_FILE) process.env.CONFIG_FILE = path.join(dir, 'config.json');
}

// Default BASE_URL for local (non-Docker) run
if (!process.env.BASE_URL) {
  process.env.BASE_URL = `http://localhost:${process.env.PORT || 3051}`;
}

require('../server.js');
