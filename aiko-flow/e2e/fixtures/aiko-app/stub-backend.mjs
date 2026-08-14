#!/usr/bin/env node
// stub-backend.mjs — minimal workspace-API stand-in for aiko-app-native-gate.sh
//
// The SPA's StartPage gates its Continue button on GET /api/v1/config/frontend
// (src/api/config.ts via src/api/client.ts, BASE_URL=/api/v1). The gate is
// about the NATIVE seam, not the FastAPI backend, so this stub answers only
// the two workspace endpoints the /start flow touches and 404s everything
// else. auth_provider "none" keeps the flow loginless — exactly the desktop
// configuration — so any login UI that appears comes from the app itself,
// which is what assertion (b) is hunting.
import { createServer } from 'node:http'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: stub-backend.mjs <port>')
  process.exit(2)
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

const server = createServer((req, res) => {
  const path = (req.url || '').split('?')[0]
  if (req.method === 'GET' && path === '/api/v1/config/frontend') {
    return json(res, 200, {
      code: 0,
      msg: 'ok',
      data: {
        auth_provider: 'none',
        show_github_button: false,
        github_repository_url: '',
        google_analytics_id: null,
        claw_enabled: false,
      },
    })
  }
  if (req.method === 'GET' && path === '/cli/verbs') {
    // No verbs: the gate asserts the SIGNED-IN state, so the login verb must
    // not exist — a "Sign in" button in the DOM is then always an app bug.
    return json(res, 200, [])
  }
  return json(res, 404, { code: 404, msg: `stub-backend: no route for ${req.method} ${path}` })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`STUB-READY 127.0.0.1:${port}`)
})
