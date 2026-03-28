/**
 * MCP HTTP transport routes for the Overleaf MCP server.
 *
 * Uses the MCP Streamable HTTP transport (recommended, replaces deprecated SSE transport).
 *
 * Single endpoint:
 *   GET  /api/user/mcp   — open SSE stream
 *   POST /api/user/mcp   — send JSON-RPC messages
 *   DELETE /api/user/mcp — terminate session (optional)
 *
 * Auth: Personal Access Token (olm_...) via Authorization: Bearer header.
 *
 * Session routing: The SDK inserts Mcp-Session-Id into responses and expects
 * clients to echo it on subsequent requests.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import logger from '@overleaf/logger'
import PersonalAccessTokenManager from '../../../oauth2-server/app/src/OAuthPersonalAccessTokenManager.mjs'
import { createMcpServer } from './McpServer.mjs'

// ── session store ─────────────────────────────────────────────────────────────
// Maps Mcp-Session-Id -> { transport, userId }
const _sessions = new Map()

// ── PAT auth middleware ───────────────────────────────────────────────────────

async function requireMcpToken(req, res, next) {
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null

  if (!token) {
    return res.status(401).json({ error: 'Bearer token required' })
  }

  const tokenDoc = await PersonalAccessTokenManager.verifyToken(token)
  if (!tokenDoc) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  req.mcpUserId = tokenDoc.user_id.toString()
  next()
}

// ── request handler ───────────────────────────────────────────────────────────

async function handleMcpRequest(req, res) {
  const userId = req.mcpUserId
  const sessionId = req.headers['mcp-session-id']

  // Route to existing session
  if (sessionId) {
    const session = _sessions.get(sessionId)
    if (!session) {
      return res
        .status(404)
        .json({ error: 'Session not found or already closed' })
    }
    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Session does not belong to token owner' })
    }
    await session.transport.handleRequest(req, res, req.body)
    return
  }

  // New session — only valid on the first POST (initialize) or first GET
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  logger.info({ userId }, 'MCP new session started')

  const transport = new StreamableHTTPServerTransport({
    onsessioninitialized: id => {
      _sessions.set(id, { transport, userId })
      logger.debug({ sessionId: id, userId }, 'MCP session registered')
    },
  })

  // Remove from session store when the transport closes
  transport.onclose = () => {
    if (transport.sessionId) {
      logger.debug({ sessionId: transport.sessionId, userId }, 'MCP session closed')
      _sessions.delete(transport.sessionId)
    }
  }

  const server = createMcpServer({ userId })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}

async function handleMcpDelete(req, res) {
  const sessionId = req.headers['mcp-session-id']
  if (sessionId) {
    const session = _sessions.get(sessionId)
    if (session) {
      if (session.userId !== req.mcpUserId) {
        return res.status(403).json({ error: 'Session does not belong to token owner' })
      }
      await session.transport.close()
      _sessions.delete(sessionId)
    }
  }
  res.status(204).end()
}

// ── router export ──────────────────────────────────────────────────────────────

export default {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    logger.debug({}, 'Init MCP router')

    const auth = [requireMcpToken]

    const wrap = handler => (req, res) => {
      handler(req, res).catch(err => {
        logger.error({ err }, 'MCP handler error')
        if (!res.headersSent) res.status(500).end()
      })
    }

    // MCP clients don't send CSRF tokens — use publicApiRouter to bypass CSRF
    publicApiRouter.get('/api/user/mcp', ...auth, wrap(handleMcpRequest))
    publicApiRouter.post('/api/user/mcp', ...auth, wrap(handleMcpRequest))
    publicApiRouter.delete('/api/user/mcp', ...auth, wrap(handleMcpDelete))
  },
}
