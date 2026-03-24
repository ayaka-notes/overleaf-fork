import {
  createContext,
  FC,
  useCallback,
  useContext,
  useReducer,
  useRef,
} from 'react'
import {
  useEditorContent,
  type EditorContentInfo,
} from '../hooks/use-editor-content'

export type AiChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isStreaming?: boolean
  /** Editor context attached when the message was sent */
  editorContext?: {
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
  | { type: 'FINISH_STREAMING'; id: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_MESSAGES' }

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
          },
        ],
        status: 'streaming',
      }
    case 'APPEND_CHUNK':
      return {
        ...state,
        messages: state.messages.map(msg =>
          msg.id === action.id
            ? { ...msg, content: msg.content + action.chunk }
            : msg
        ),
      }
    case 'FINISH_STREAMING':
      return {
        ...state,
        messages: state.messages.map(msg =>
          msg.id === action.id ? { ...msg, isStreaming: false } : msg
        ),
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
  sendMessage: (content: string) => void
  clearMessages: () => void
  stopStreaming: () => void
}

const AiChatContext = createContext<AiChatContextValue | undefined>(undefined)

/**
 * Build the request body, injecting document context for the backend.
 * The full document is sent as a system-level context so the AI can
 * reference any part of it; the current selection range and selected source
 * text are included so the AI knows where in the file the user is focused.
 */
function buildRequestBody(
  history: AiChatMessage[],
  userContent: string,
  editorCtx: EditorContentInfo
) {
  const contextParts: string[] = []

  if (editorCtx.fileName) {
    contextParts.push(`Current file: ${editorCtx.fileName}`)
  }

  if (editorCtx.documentContent) {
    // Truncate very large documents to avoid blowing up the request
    const maxLen = 60_000
    const doc =
      editorCtx.documentContent.length > maxLen
        ? editorCtx.documentContent.slice(0, maxLen) + '\n... (truncated)'
        : editorCtx.documentContent
    contextParts.push(
      `Full document content:\n\`\`\`latex\n${doc}\n\`\`\``
    )
  }

  const systemContext =
    contextParts.length > 0 ? contextParts.join('\n\n') : null
  return {
    messages: [
      ...history.map(m => ({
        role: m.role,
        content: m.content,
      })),
      { role: 'user', content: userContent },
    ],
    context: systemContext,
    selectedText: editorCtx.selectedText,
    selectionRange: editorCtx.selectionRange,
  }
}

export const AiChatProvider: FC<React.PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    status: 'idle',
    error: null,
  })
  const abortControllerRef = useRef<AbortController | null>(null)
  const { getEditorContext } = useEditorContent()

  const stopStreaming = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return

      // Capture editor state at send time
      const editorCtx = getEditorContext()

      const userMessage: AiChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: content.trim(),
        timestamp: new Date(),
        editorContext: {
          fileName: editorCtx.fileName,
          selectedText: editorCtx.selectedText,
          selectionRange: editorCtx.selectionRange,
          hasDocumentContent: !!editorCtx.documentContent,
        },
      }
      dispatch({ type: 'SEND_MESSAGE', message: userMessage })

      const assistantId = `assistant-${Date.now()}`
      dispatch({ type: 'START_STREAMING', id: assistantId })

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const projectId = window.location.pathname.match(
          /\/project\/([a-f0-9]+)/
        )?.[1]

        const body = buildRequestBody(state.messages, content.trim(), editorCtx)

        const response = await fetch(`/api/project/${projectId}/ai-chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token':
              (
                document.querySelector(
                  'meta[name="ol-csrfToken"]'
                ) as HTMLMetaElement
              )?.content ?? '',
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
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const text = decoder.decode(value, { stream: true })
          // Parse SSE format
          const lines = text.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6)
              if (data === '[DONE]') break
              try {
                const parsed = JSON.parse(data)
                if (parsed.content) {
                  dispatch({
                    type: 'APPEND_CHUNK',
                    id: assistantId,
                    chunk: parsed.content,
                  })
                }
              } catch {
                // If not JSON, treat as plain text chunk
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
    [state.messages, getEditorContext]
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
