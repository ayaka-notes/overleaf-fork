import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AiChatService from './AiChatService.mjs'

async function streamChat(req, res) {
  const { Project_id: projectId } = req.params
  const {
    messages,
    context,
    currentDocumentId,
    currentFileName,
    selectedText,
    selectionRange,
  } = req.body ?? {}
  const userId = SessionManager.getLoggedInUserId(req.session)

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages must be a non-empty array' })
    return
  }

  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

  await AiChatService.streamChat({
    projectId,
    userId,
    messages,
    context,
    currentDocumentId,
    currentFileName,
    selectedText,
    selectionRange,
    signal: abortController.signal,
    res,
  })
}

async function applyEdit(req, res) {
  const { Project_id: projectId } = req.params
  const { docId, fromLine, toLine, existingContent, newContent } = req.body ?? {}
  const userId = SessionManager.getLoggedInUserId(req.session)

  if (
    !docId ||
    !Number.isInteger(fromLine) ||
    !Number.isInteger(toLine) ||
    typeof existingContent !== 'string' ||
    typeof newContent !== 'string'
  ) {
    res.status(400).json({ error: 'Invalid edit proposal payload' })
    return
  }

  await AiChatService.applyEditProposal({
    projectId,
    docId,
    fromLine,
    toLine,
    existingContent,
    newContent,
    userId,
  })

  res.sendStatus(204)
}

export default {
  streamChat: expressify(streamChat),
  applyEdit: expressify(applyEdit),
}
