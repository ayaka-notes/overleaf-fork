import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import fetch from 'node-fetch'

function buildSystemPrompt({ context, selectedText, selectionRange }) {
  const parts = [Settings.apis.aiChat.systemPrompt].filter(Boolean)

  if (context) {
    parts.push(context)
  }

  if (selectionRange?.startLine != null && selectionRange?.endLine != null) {
    parts.push(
      `Current selection range: lines ${selectionRange.startLine}-${selectionRange.endLine}`
    )
  }

  if (selectedText) {
    parts.push(`Selected source text:\n\`\`\`latex\n${selectedText}\n\`\`\``)
  }

  return parts.join('\n\n')
}

function buildUpstreamPayload({ messages, context, selectedText, selectionRange }) {
  const systemPrompt = buildSystemPrompt({ context, selectedText, selectionRange })

  return {
    model: Settings.apis.aiChat.model,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map(({ role, content }) => ({ role, content })),
    ],
  }
}

function extractContentFromEventData(data) {
  if (data === '[DONE]') {
    return { done: true }
  }

  const parsed = JSON.parse(data)

  const content =
    parsed.choices?.[0]?.delta?.content ??
    parsed.choices?.[0]?.message?.content ??
    parsed.content ??
    null

  return {
    done: false,
    content: typeof content === 'string' ? content : null,
  }
}

function writeSseHeaders(res) {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
}

async function streamChat({
  projectId,
  messages,
  context,
  selectedText,
  selectionRange,
  signal,
  res,
}) {
  if (!Settings.apis.aiChat.enabled) {
    res.status(503).json({ error: 'AI chat is disabled' })
    return
  }

  if (!Settings.apis.aiChat.url) {
    res.status(500).json({ error: 'AI chat upstream URL is not configured' })
    return
  }

  const payload = buildUpstreamPayload({
    messages,
    context,
    selectedText,
    selectionRange,
  })

  const headers = {
    'Content-Type': 'application/json',
  }

  if (Settings.apis.aiChat.apiKey) {
    headers.Authorization = `Bearer ${Settings.apis.aiChat.apiKey}`
  }

  const upstreamAbortController = new AbortController()
  const abortUpstream = () => upstreamAbortController.abort()
  signal?.addEventListener('abort', abortUpstream, { once: true })

  const timeout = setTimeout(() => {
    upstreamAbortController.abort()
  }, Settings.apis.aiChat.timeout)

  let upstreamResponse
  try {
    upstreamResponse = await fetch(Settings.apis.aiChat.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: upstreamAbortController.signal,
    })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortUpstream)
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text()
    logger.error(
      {
        projectId,
        status: upstreamResponse.status,
        body: errorText,
      },
      'ai-chat upstream request failed'
    )
    res
      .status(upstreamResponse.status)
      .json({ error: errorText || 'AI upstream request failed' })
    return
  }

  writeSseHeaders(res)

  let buffer = ''

  for await (const chunk of upstreamResponse.body) {
    if (signal.aborted) {
      break
    }

    buffer += chunk.toString('utf8')
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const event of events) {
      const lines = event
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue

        const data = line.slice(6)

        try {
          const parsed = extractContentFromEventData(data)

          if (parsed.done) {
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }

          if (parsed.content) {
            res.write(`data: ${JSON.stringify({ content: parsed.content })}\n\n`)
          }
        } catch (error) {
          logger.warn(
            { projectId, error, data },
            'ai-chat upstream event could not be parsed'
          )
        }
      }
    }
  }

  res.write('data: [DONE]\n\n')
  res.end()
}

export default {
  streamChat,
}
