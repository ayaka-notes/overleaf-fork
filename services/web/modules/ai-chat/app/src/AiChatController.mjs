import { expressify } from '@overleaf/promise-utils'
import AiChatService from './AiChatService.mjs'

async function streamChat(req, res) {
  const { Project_id: projectId } = req.params
  const { messages, context, selectedText, selectionRange } = req.body ?? {}

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages must be a non-empty array' })
    return
  }

  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

  await AiChatService.streamChat({
    projectId,
    messages,
    context,
    selectedText,
    selectionRange,
    signal: abortController.signal,
    res,
  })
}

export default {
  streamChat: expressify(streamChat),
}
