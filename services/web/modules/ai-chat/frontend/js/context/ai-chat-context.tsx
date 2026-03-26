import {
  createContext,
  type Dispatch,
  FC,
  type PropsWithChildren,
  useCallback,
  useContext,
  useReducer,
  useRef,
} from 'react'
import { flushSync } from 'react-dom'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import {
  useEditorContent,
  type EditorContentInfo,
} from '../hooks/use-editor-content'

export type AiChatToolCall = {
  id: string
  name: string
  args: unknown
  rawInput?: string
  title?: string | null
  status?: 'pending' | 'running' | 'completed' | 'failed'
  resultSummary?: string | null
}

export type AiChatAttachment = {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  size: number
}

export type AiChatEditProposal = {
  docId: string
  path: string | null
  fromLine: number
  toLine: number
  existingContent: string
  newContent: string
  rationale?: string | null
  status?: 'pending' | 'applying' | 'applied' | 'error'
  error?: string | null
}

type RejectedEditProposalPayload = {
  path: string | null
  fromLine: number
  toLine: number
  rationale?: string | null
}

export type AiChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  attachments?: AiChatAttachment[]
  isStreaming?: boolean
  reasoning?: {
    summary: string
    content: string
    status: 'running' | 'completed'
    startedAt: number
    finishedAt?: number | null
  } | null
  toolCalls?: AiChatToolCall[]
  editProposal?: AiChatEditProposal | null
  editorContext?: {
    currentDocumentId: string | null
    fileName: string | null
    selectedText: string | null
    selectionRange: {
      startLine: number
      endLine: number
    } | null
    hasDocumentContent: boolean
  }
}

type AiChatState = {
  messages: AiChatMessage[]
  status: 'idle' | 'pending' | 'streaming' | 'error'
  error: string | null
}

type AiChatAction =
  | { type: 'SEND_MESSAGE'; message: AiChatMessage }
  | { type: 'START_STREAMING'; id: string }
  | { type: 'APPEND_CHUNK'; id: string; chunk: string }
  | {
      type: 'SET_REASONING'
      id: string
      reasoning: NonNullable<AiChatMessage['reasoning']>
    }
  | {
      type: 'APPEND_REASONING_DELTA'
      id: string
      delta: string
    }
  | { type: 'FINISH_REASONING'; id: string }
  | { type: 'UPSERT_TOOL_CALL'; id: string; toolCall: AiChatToolCall }
  | {
      type: 'SET_TOOL_CALL_STATUS'
      id: string
      toolCallId: string
      status: NonNullable<AiChatToolCall['status']>
      resultSummary?: string | null
      args?: unknown
    }
  | { type: 'COMPLETE_RUNNING_TOOL_CALLS'; id: string }
  | {
      type: 'APPEND_TOOL_CALL_INPUT'
      id: string
      toolCallId: string
      delta: string
    }
  | {
      type: 'SET_EDIT_PROPOSAL'
      id: string
      proposal: AiChatEditProposal
    }
  | {
      type: 'SET_EDIT_STATUS'
      id: string
      status: NonNullable<AiChatEditProposal['status']>
      error?: string | null
    }
  | { type: 'REJECT_EDIT_PROPOSAL'; id: string }
  | { type: 'FINISH_STREAMING'; id: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_MESSAGES' }

function updateAssistantMessage(
  messages: AiChatMessage[],
  id: string,
  updater: (message: AiChatMessage) => AiChatMessage
) {
  return messages.map(msg => (msg.id === id ? updater(msg) : msg))
}

function reducer(state: AiChatState, action: AiChatAction): AiChatState {
  switch (action.type) {
    case 'SEND_MESSAGE':
      return {
        ...state,
        messages: [...state.messages, action.message],
        status: 'pending',
        error: null,
      }
    case 'START_STREAMING':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            isStreaming: true,
            reasoning: {
              summary: 'Thinking',
              content: '',
              status: 'running',
              startedAt: Date.now(),
              finishedAt: null,
            },
            toolCalls: [],
            editProposal: null,
          },
        ],
        status: 'streaming',
      }
    case 'APPEND_CHUNK':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          content: msg.content + action.chunk,
        })),
      }
    case 'SET_REASONING':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          reasoning: {
            ...action.reasoning,
            status: action.reasoning.status ?? 'running',
            startedAt: action.reasoning.startedAt ?? msg.reasoning?.startedAt ?? Date.now(),
            finishedAt: action.reasoning.finishedAt ?? msg.reasoning?.finishedAt ?? null,
          },
        })),
      }
    case 'APPEND_REASONING_DELTA':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          reasoning: {
            summary:
              msg.reasoning?.summary ??
              summarizeReasoning(action.delta, 'Thought process'),
            content: `${msg.reasoning?.content ?? ''}${action.delta}`,
            status: 'running',
            startedAt: msg.reasoning?.startedAt ?? Date.now(),
            finishedAt: null,
          },
        })),
      }
    case 'FINISH_REASONING':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          reasoning: msg.reasoning
            ? {
                ...msg.reasoning,
                status: 'completed',
                finishedAt: msg.reasoning.finishedAt ?? Date.now(),
              }
            : msg.reasoning,
        })),
      }
    case 'UPSERT_TOOL_CALL':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => {
          const toolCalls = msg.toolCalls ?? []
          const index = toolCalls.findIndex(
            toolCall =>
              toolCall.id === action.toolCall.id ||
              (!!action.toolCall.id && toolCall.name === action.toolCall.name)
          )

          if (index === -1) {
            return { ...msg, toolCalls: [...toolCalls, action.toolCall] }
          }

          const nextToolCalls = [...toolCalls]
          nextToolCalls[index] = {
            ...nextToolCalls[index],
            ...action.toolCall,
          }
          return { ...msg, toolCalls: nextToolCalls }
        }),
      }
    case 'SET_TOOL_CALL_STATUS':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => {
          const toolCalls = msg.toolCalls ?? []
          const index = toolCalls.findIndex(
            toolCall => toolCall.id === action.toolCallId
          )

          if (index === -1) {
            return {
              ...msg,
              toolCalls: [
                ...toolCalls,
                {
                  id: action.toolCallId,
                  name: 'tool',
                  args: action.args ?? null,
                  status: action.status,
                  resultSummary: action.resultSummary ?? null,
                },
              ],
            }
          }

          const nextToolCalls = [...toolCalls]
          nextToolCalls[index] = {
            ...nextToolCalls[index],
            status: action.status,
            resultSummary:
              action.resultSummary ?? nextToolCalls[index].resultSummary ?? null,
            args:
              action.args !== undefined ? action.args : nextToolCalls[index].args,
          }
          return { ...msg, toolCalls: nextToolCalls }
        }),
      }
    case 'COMPLETE_RUNNING_TOOL_CALLS':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          toolCalls: (msg.toolCalls ?? []).map(toolCall => ({
            ...toolCall,
            status:
              toolCall.status === 'running' ? 'completed' : toolCall.status,
          })),
        })),
      }
    case 'APPEND_TOOL_CALL_INPUT':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => {
          const toolCalls = msg.toolCalls ?? []
          const index = toolCalls.findIndex(
            toolCall => toolCall.id === action.toolCallId
          )

          if (index === -1) {
            return {
              ...msg,
              toolCalls: [
                ...toolCalls,
                {
                  id: action.toolCallId,
                  name: 'tool',
                  args: null,
                  rawInput: action.delta,
                  status: 'running',
                },
              ],
            }
          }

          const nextToolCalls = [...toolCalls]
          nextToolCalls[index] = {
            ...nextToolCalls[index],
            rawInput: `${nextToolCalls[index].rawInput ?? ''}${action.delta}`,
          }
          return { ...msg, toolCalls: nextToolCalls }
        }),
      }
    case 'SET_EDIT_PROPOSAL':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          editProposal: action.proposal,
        })),
      }
    case 'SET_EDIT_STATUS':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          editProposal: msg.editProposal
            ? {
                ...msg.editProposal,
                status: action.status,
                error: action.error ?? null,
              }
            : msg.editProposal,
        })),
      }
    case 'REJECT_EDIT_PROPOSAL':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          editProposal: null,
        })),
      }
    case 'FINISH_STREAMING':
      return {
        ...state,
        messages: updateAssistantMessage(state.messages, action.id, msg => ({
          ...msg,
          isStreaming: false,
          reasoning: msg.reasoning
            ? {
                ...msg.reasoning,
                status: 'completed',
                finishedAt: msg.reasoning.finishedAt ?? Date.now(),
              }
            : msg.reasoning,
        })),
        status: 'idle',
      }
    case 'SET_ERROR':
      return {
        ...state,
        status: 'error',
        error: action.error,
        messages: state.messages.filter(msg => !msg.isStreaming),
      }
    case 'CLEAR_MESSAGES':
      return { messages: [], status: 'idle', error: null }
    default:
      return state
  }
}

type AiChatContextValue = {
  messages: AiChatMessage[]
  status: AiChatState['status']
  error: string | null
  sendMessage: (content: string, attachments?: AiChatAttachment[]) => void
  clearMessages: () => void
  stopStreaming: () => void
  applyEditProposal: (messageId: string) => Promise<void>
  rejectEditProposal: (messageId: string) => void
}

const AiChatContext = createContext<AiChatContextValue | undefined>(undefined)

function getProjectId() {
  return window.location.pathname.match(/\/project\/([a-f0-9]+)/)?.[1] ?? null
}

function getCsrfToken() {
  return (
    (
      document.querySelector('meta[name="ol-csrfToken"]') as HTMLMetaElement
    )?.content ?? ''
  )
}

function normalizeComparableSourceText(content: string) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '')
}

function buildRequestBody(
  history: AiChatMessage[],
  userContent: string,
  editorCtx: EditorContentInfo,
  options?: {
    rejectedEditProposal?: RejectedEditProposalPayload | null
    attachments?: AiChatAttachment[]
  }
) {
  const contextParts: string[] = []

  if (editorCtx.fileName) {
    contextParts.push(`Current file: ${editorCtx.fileName}`)
  }

  if (editorCtx.documentContent) {
    const maxLen = 60_000
    const doc =
      editorCtx.documentContent.length > maxLen
        ? editorCtx.documentContent.slice(0, maxLen) + '\n... (truncated)'
        : editorCtx.documentContent
    contextParts.push(`Full document content:\n\`\`\`latex\n${doc}\n\`\`\``)
  }

  return {
    messages: [
      ...history.map(m => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments ?? [],
      })),
      ...(userContent || (options?.attachments?.length ?? 0) > 0
        ? [
            {
              role: 'user' as const,
              content: userContent,
              attachments: options?.attachments ?? [],
            },
          ]
        : []),
    ],
    context: contextParts.length > 0 ? contextParts.join('\n\n') : null,
    currentDocumentId: editorCtx.currentDocumentId,
    currentFileName: editorCtx.fileName,
    currentDocumentContent: editorCtx.documentContent,
    selectedText: editorCtx.selectedText,
    selectionRange: editorCtx.selectionRange,
    rejectedEditProposal: options?.rejectedEditProposal ?? null,
  }
}

function parseSseEventBlock(block: string) {
  const dataLines = block
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6))

  if (dataLines.length === 0) return null

  return dataLines.join('\n')
}

function summarizeReasoning(content: string, fallback = 'Thought process') {
  const firstLine = content
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)
  return firstLine || fallback
}

function handleAssistantEvent(
  assistantId: string,
  parsed: Record<string, unknown>,
  dispatch: Dispatch<AiChatAction>
) {
  const type = typeof parsed.type === 'string' ? parsed.type : null

  if (type && ['start', 'start-step'].includes(type)) {
    return
  }

  if (
    type &&
    ['assistant_delta', 'assistant', 'content', 'message_delta'].includes(type)
  ) {
    const content = typeof parsed.content === 'string' ? parsed.content : null
    if (content) {
      dispatch({ type: 'APPEND_CHUNK', id: assistantId, chunk: content })
    }
    return
  }

  if (type && ['reasoning', 'thinking', 'thought'].includes(type)) {
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    const summary =
      typeof parsed.summary === 'string'
        ? parsed.summary
        : typeof parsed.label === 'string'
          ? parsed.label
          : summarizeReasoning(content, 'Thought')

    dispatch({
      type: 'SET_REASONING',
      id: assistantId,
      reasoning: {
        summary,
        content,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
      },
    })
    return
  }

  if (type === 'reasoning-start') {
    dispatch({
      type: 'SET_REASONING',
      id: assistantId,
      reasoning: {
        summary: 'Thinking',
        content: '',
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
      },
    })
    return
  }

  if (type === 'reasoning-delta') {
    const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
    if (delta) {
      dispatch({
        type: 'APPEND_REASONING_DELTA',
        id: assistantId,
        delta,
      })
    }
    return
  }

  if (type === 'reasoning-end') {
    dispatch({ type: 'FINISH_REASONING', id: assistantId })
    return
  }

  if (type && ['tool_call', 'function_call', 'tool_result'].includes(type)) {
    const callId =
      typeof parsed.callId === 'string'
        ? parsed.callId
        : typeof parsed.id === 'string'
          ? parsed.id
          : `${typeof parsed.name === 'string' ? parsed.name : 'tool'}-0`

    const name =
      typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.tool === 'string'
          ? parsed.tool
          : 'tool'

    dispatch({
      type: 'UPSERT_TOOL_CALL',
      id: assistantId,
      toolCall: {
        id: callId,
        name,
        args: parsed.arguments ?? parsed.args ?? null,
        status:
          typeof parsed.status === 'string'
            ? (parsed.status as AiChatToolCall['status'])
            : type === 'tool_result'
              ? 'completed'
              : 'running',
        resultSummary:
          typeof parsed.resultSummary === 'string'
            ? parsed.resultSummary
            : typeof parsed.result === 'string'
              ? parsed.result
              : null,
      },
    })
    return
  }

  if (type === 'tool-input-start') {
    const toolCallId =
      typeof parsed.toolCallId === 'string' ? parsed.toolCallId : 'tool-call'
    dispatch({
      type: 'UPSERT_TOOL_CALL',
      id: assistantId,
      toolCall: {
        id: toolCallId,
        name:
          typeof parsed.toolName === 'string' ? parsed.toolName : 'tool',
        title: typeof parsed.title === 'string' ? parsed.title : null,
        args: null,
        rawInput: '',
        status: 'running',
      },
    })
    return
  }

  if (type === 'tool-input-delta') {
    const toolCallId =
      typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null
    const delta =
      typeof parsed.inputTextDelta === 'string' ? parsed.inputTextDelta : ''
    if (toolCallId && delta) {
      dispatch({
        type: 'APPEND_TOOL_CALL_INPUT',
        id: assistantId,
        toolCallId,
        delta,
      })
    }
    return
  }

  if (type === 'tool-input-available') {
    const toolCallId =
      typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null
    if (toolCallId) {
      dispatch({
        type: 'UPSERT_TOOL_CALL',
        id: assistantId,
        toolCall: {
          id: toolCallId,
          name:
            typeof parsed.toolName === 'string' ? parsed.toolName : 'tool',
          title: typeof parsed.title === 'string' ? parsed.title : undefined,
          args: parsed.input ?? null,
          status: 'running',
        },
      })
    }
    return
  }

  if (type === 'finish-step') {
    dispatch({ type: 'COMPLETE_RUNNING_TOOL_CALLS', id: assistantId })
    return
  }

  if (type === 'finish') {
    dispatch({ type: 'FINISH_REASONING', id: assistantId })
    return
  }

  if (type && ['edit_proposal', 'replace_lines', 'patch'].includes(type)) {
    const docId =
      typeof parsed.docId === 'string' ? parsed.docId : parsed.currentDocumentId
    const proposal = {
      docId: typeof docId === 'string' ? docId : '',
      path: typeof parsed.path === 'string' ? parsed.path : null,
      fromLine: Number(parsed.fromLine ?? 0),
      toLine: Number(parsed.toLine ?? 0),
      existingContent:
        typeof parsed.existingContent === 'string' ? parsed.existingContent : '',
      newContent:
        typeof parsed.newContent === 'string' ? parsed.newContent : '',
      rationale:
        typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
      status: 'pending' as const,
      error: null,
    }

    if (proposal.docId && proposal.newContent) {
      dispatch({
        type: 'SET_EDIT_PROPOSAL',
        id: assistantId,
        proposal,
      })
    }
    return
  }

  if (typeof parsed.content === 'string') {
    dispatch({ type: 'APPEND_CHUNK', id: assistantId, chunk: parsed.content })
  }
}

export const AiChatProvider: FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    status: 'idle',
    error: null,
  })
  const abortControllerRef = useRef<AbortController | null>(null)
  const { getEditorContext } = useEditorContent()
  const { setIgnoringExternalUpdates } = useEditorManagerContext()
  const { view } = useEditorViewContext()
  const { currentDocumentId } = useEditorOpenDocContext()

  const stopStreaming = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const sendMessageInternal = useCallback(
    async (
      content: string,
      options?: {
        visibleToConversation?: boolean
        rejectedEditProposal?: RejectedEditProposalPayload | null
        attachments?: AiChatAttachment[]
      }
    ) => {
      const trimmedContent = content.trim()
      const rejectedEditProposal = options?.rejectedEditProposal ?? null
      const attachments = options?.attachments ?? []
      if (!trimmedContent && !rejectedEditProposal && attachments.length === 0) return

      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }

      const editorCtx = getEditorContext()
      const visibleToConversation = options?.visibleToConversation ?? true

      if (visibleToConversation && trimmedContent) {
        const userMessage: AiChatMessage = {
          id: `user-${Date.now()}`,
          role: 'user',
          content: trimmedContent,
          timestamp: new Date(),
          attachments,
          editorContext: {
            currentDocumentId: editorCtx.currentDocumentId,
            fileName: editorCtx.fileName,
            selectedText: editorCtx.selectedText,
            selectionRange: editorCtx.selectionRange,
            hasDocumentContent: !!editorCtx.documentContent,
          },
        }
        dispatch({ type: 'SEND_MESSAGE', message: userMessage })
      } else if (visibleToConversation && attachments.length > 0) {
        const userMessage: AiChatMessage = {
          id: `user-${Date.now()}`,
          role: 'user',
          content: '',
          timestamp: new Date(),
          attachments,
          editorContext: {
            currentDocumentId: editorCtx.currentDocumentId,
            fileName: editorCtx.fileName,
            selectedText: editorCtx.selectedText,
            selectionRange: editorCtx.selectionRange,
            hasDocumentContent: !!editorCtx.documentContent,
          },
        }
        dispatch({ type: 'SEND_MESSAGE', message: userMessage })
      }

      const assistantId = `assistant-${Date.now()}`
      dispatch({ type: 'START_STREAMING', id: assistantId })

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const projectId = getProjectId()
        if (!projectId) {
          throw new Error('Missing project id')
        }
        const body = buildRequestBody(state.messages, trimmedContent, editorCtx, {
          rejectedEditProposal,
          attachments,
        })

        const response = await fetch(`/api/project/${projectId}/ai-chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': getCsrfToken(),
          },
          body: JSON.stringify(body),
          signal: abortController.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('No response body')
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const events = buffer.split('\n\n')
          buffer = events.pop() || ''

          for (const event of events) {
            const data = parseSseEventBlock(event)
            if (!data) continue
            if (data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data)
              if (parsed && typeof parsed === 'object') {
                const eventType =
                  typeof parsed.type === 'string' ? parsed.type : null
                if (eventType === 'tool-input-start') {
                  flushSync(() => {
                    handleAssistantEvent(
                      assistantId,
                      parsed as Record<string, unknown>,
                      dispatch
                    )
                  })
                } else {
                  handleAssistantEvent(
                    assistantId,
                    parsed as Record<string, unknown>,
                    dispatch
                  )
                }
              }
            } catch {
              if (data.trim()) {
                dispatch({
                  type: 'APPEND_CHUNK',
                  id: assistantId,
                  chunk: data,
                })
              }
            }
          }
        }

        dispatch({ type: 'FINISH_STREAMING', id: assistantId })
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          dispatch({ type: 'FINISH_STREAMING', id: assistantId })
        } else {
          dispatch({
            type: 'SET_ERROR',
            error:
              err instanceof Error ? err.message : 'Failed to get AI response',
          })
        }
      } finally {
        abortControllerRef.current = null
      }
    },
    [getEditorContext, state.messages]
  )

  const applyEditProposal = useCallback(
    async (messageId: string) => {
      const projectId = getProjectId()
      const message = state.messages.find(msg => msg.id === messageId)
      const proposal = message?.editProposal

      if (!proposal) return

      dispatch({
        type: 'SET_EDIT_STATUS',
        id: messageId,
        status: 'applying',
      })

      try {
        if (
          view &&
          currentDocumentId &&
          proposal.docId === currentDocumentId &&
          proposal.fromLine >= 1 &&
          proposal.toLine >= proposal.fromLine &&
          proposal.toLine <= view.state.doc.lines
        ) {
          const fromLine = view.state.doc.line(proposal.fromLine)
          const toLine = view.state.doc.line(proposal.toLine)
          const currentContent = Array.from(
            { length: proposal.toLine - proposal.fromLine + 1 },
            (_, index) => view.state.doc.line(proposal.fromLine + index).text
          ).join('\n')

          if (
            normalizeComparableSourceText(currentContent) !==
            normalizeComparableSourceText(proposal.existingContent)
          ) {
            throw new Error(
              'Document content has changed. Please ask AI to regenerate the patch.'
            )
          }

          view.dispatch({
            changes: {
              from: fromLine.from,
              to: toLine.to,
              insert: proposal.newContent,
            },
          })

          dispatch({
            type: 'SET_EDIT_STATUS',
            id: messageId,
            status: 'applied',
          })
          return
        }

        if (!projectId) {
          throw new Error('Missing project id')
        }

        setIgnoringExternalUpdates(true)
        const response = await fetch(`/api/project/${projectId}/ai-chat/apply-edit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': getCsrfToken(),
          },
          body: JSON.stringify(proposal),
        })

        if (!response.ok) {
          const text = await response.text()
          throw new Error(text || `HTTP ${response.status}: ${response.statusText}`)
        }

        dispatch({
          type: 'SET_EDIT_STATUS',
          id: messageId,
          status: 'applied',
        })
      } catch (error) {
        dispatch({
          type: 'SET_EDIT_STATUS',
          id: messageId,
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to apply edit',
        })
      } finally {
        window.setTimeout(() => {
          setIgnoringExternalUpdates(false)
        }, 1500)
      }
    },
    [currentDocumentId, setIgnoringExternalUpdates, state.messages, view]
  )

  const sendMessage = useCallback(
    async (content: string, attachments?: AiChatAttachment[]) => {
      await sendMessageInternal(content, {
        visibleToConversation: true,
        attachments: attachments ?? [],
      })
    },
    [sendMessageInternal]
  )

  const rejectEditProposal = useCallback(
    (messageId: string) => {
      stopStreaming()

      dispatch({
        type: 'REJECT_EDIT_PROPOSAL',
        id: messageId,
      })
    },
    [stopStreaming]
  )

  const clearMessages = useCallback(() => {
    stopStreaming()
    dispatch({ type: 'CLEAR_MESSAGES' })
  }, [stopStreaming])

  return (
    <AiChatContext.Provider
      value={{
        messages: state.messages,
        status: state.status,
        error: state.error,
        sendMessage,
        clearMessages,
        stopStreaming,
        applyEditProposal,
        rejectEditProposal,
      }}
    >
      {children}
    </AiChatContext.Provider>
  )
}

export function useAiChatContext() {
  const context = useContext(AiChatContext)
  if (!context) {
    throw new Error('useAiChatContext must be used within AiChatProvider')
  }
  return context
}
