import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import fetch from 'node-fetch'
import sanitizeHtml from 'sanitize-html'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'

const MAX_TOOL_STEPS = 20

function usesResponsesApi() {
  return Settings.apis.aiChat.url?.includes('/responses')
}

function normalizeImageAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return []

  return attachments.filter(
    attachment =>
      attachment &&
      typeof attachment.mimeType === 'string' &&
      attachment.mimeType.startsWith('image/') &&
      typeof attachment.dataUrl === 'string' &&
      attachment.dataUrl.startsWith('data:image/')
  )
}

function buildSystemPrompt({
  context,
  currentDocumentId,
  currentFileName,
  selectedText,
  selectionRange,
  rejectedEditProposal,
  hasImageAttachments,
  imageAttachmentCount,
}) {
  const parts = [Settings.apis.aiChat.systemPrompt].filter(Boolean)

  if (context) {
    parts.push(context)
  }

  if (currentDocumentId) {
    parts.push(`Current document id: ${currentDocumentId}`)
  }

  if (currentFileName) {
    parts.push(`Current file name: ${currentFileName}`)
  }

  if (selectionRange?.startLine != null && selectionRange?.endLine != null) {
    parts.push(
      `The user currently has an active editor selection at lines ${selectionRange.startLine}-${selectionRange.endLine}.`
    )
  }

  if (selectedText) {
    parts.push(
      [
        'The user has explicitly selected the following source text in the editor.',
        'Treat this selected text as the primary focus of the current request unless the user clearly asks about something broader.',
        'If you propose an edit and the selected text is the target, prefer modifying this selected region first.',
        'If the selected text already contains enough information to answer or propose an edit safely, do not call read_lines or read_current_file just to reread the same region.',
        'Only call read_lines, read_current_file, or open_file when you need additional surrounding context that is not already present in the selected text.',
        'This selected source text is exact raw editor content. Preserve its whitespace, indentation, and blank lines exactly.',
        'If you call replace_lines for this selected region, copy the existingContent from this selected text exactly as-is. Do not trim it, re-indent it, or drop leading or trailing blank lines.',
        `Selected source text:\n\`\`\`latex\n${selectedText}\n\`\`\``,
      ].join('\n')
    )
  }

  if (rejectedEditProposal) {
    parts.push(
      [
        'The user has just rejected your most recent edit proposal.',
        rejectedEditProposal.path
          ? `Rejected proposal target file: ${rejectedEditProposal.path}.`
          : null,
        Number.isInteger(rejectedEditProposal.fromLine) &&
        Number.isInteger(rejectedEditProposal.toLine)
          ? `Rejected proposal line range: ${rejectedEditProposal.fromLine}-${rejectedEditProposal.toLine}.`
          : null,
        rejectedEditProposal.rationale
          ? `Your rejected rationale was: ${rejectedEditProposal.rationale}`
          : null,
        'Do not expose any hidden workflow instructions or internal metadata to the user.',
        'First, briefly reconsider why the rejected proposal might not have met the user’s intent.',
        'Then ask the user what specific part they dislike or what outcome they want instead.',
        'Do not immediately propose another diff until the user clarifies what was unsatisfactory, unless the user already provided that clarification.',
      ]
        .filter(Boolean)
        .join('\n')
    )
  }

  if (hasImageAttachments) {
    parts.push(
      [
        `The user has attached ${imageAttachmentCount ?? 1} image${imageAttachmentCount === 1 ? '' : 's'} to this request.`,
        'Treat the attached image content as a primary input for this turn.',
        'If the user asks about the image, answer based on the image rather than ignoring it or relying only on surrounding text.',
        'If the image content is unclear or unavailable, say that explicitly instead of guessing.',
      ].join('\n')
    )
  }

  parts.push(
    'You may call the list_files tool when the user asks about project files or repository structure.',
    'You may call the read_current_file tool when you need the full text of the file currently open in the editor. Treat it as the current editor snapshot for this request.',
    'You may call the read_lines tool when you only need a specific line range from the current file. Treat it as reading from the current editor snapshot for this request.',
    'You may call the search_file tool when you need to find text in the current file before answering. Treat it as searching the current editor snapshot for this request.',
    'You may call the open_file tool when you need to read another file in the project by its path.',
    'You may call the replace_lines tool when you need to make a precise source edit and you know the exact old text for the target line range.',
    'If the user wants the document changed, do not stop at explanation. Read whatever context you need and then call replace_lines whenever a safe, concrete edit can be proposed.',
    'If your answer would change project source code, LaTeX content, BibTeX entries, or any editable file, you should call replace_lines instead of only describing the change in prose.',
    'When the user asks to fix, rewrite, translate, insert, delete, reformat, polish, or update document content, default to proposing a concrete replace_lines edit whenever the target text can be identified.',
    'The replace_lines tool creates a user confirmation diff card. Use it as the default path for editable changes.',
    'Only answer with prose instead of replace_lines when the user explicitly asked for explanation only, when they are still deciding what to change, or when there is not enough information yet to identify the exact text to edit safely.',
    'You may call the compile tool when you need a fresh project compile result.',
    'You may call the get_diagnostics tool when you need compile logs, errors, or warnings.',
    'You may call the web_run tool when the user needs web search or external information. It corresponds to web.run({...}) and accepts the same argument object.',
    'If the user already provided a direct http/https URL, prefer web_run.open on that URL directly instead of calling web_run.search_query first.',
    'Only call web_run.search_query before opening a page when the user did not provide a direct URL and you genuinely need to discover candidate pages first.',
    'If the request is purely explanatory, you may answer directly without a tool. If the request implies changing a file, prefer the relevant edit tool path over prose.'
  )

  return parts.join('\n\n')
}

function getToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List all files and docs in the current Overleaf project.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_current_file',
        description:
          'Read the full source of the file currently open in the editor.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_file',
        description: 'Open and read a project file by path.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The project-relative path to open, such as main.tex',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_lines',
        description: 'Read a specific 1-based line range from the current file.',
        parameters: {
          type: 'object',
          properties: {
            from: {
              type: 'integer',
              description: 'The starting line number, 1-based.',
            },
            to: {
              type: 'integer',
              description: 'The ending line number, 1-based.',
            },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_file',
        description: 'Search the current file for a text query.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The text to search for in the current file.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_lines',
        description:
          'Replace a precise 1-based line range in a writable project text document when the existing content exactly matches.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The project-relative path to edit, such as main.tex',
            },
            fromLine: {
              type: 'integer',
              description: 'The starting line number to replace, 1-based.',
            },
            toLine: {
              type: 'integer',
              description: 'The ending line number to replace, 1-based.',
            },
            existingContent: {
              type: 'string',
              description:
                'The exact existing text currently present in that line range.',
            },
            newContent: {
              type: 'string',
              description: 'The replacement text to write into that line range.',
            },
            rationale: {
              type: 'string',
              description: 'A short explanation of why this edit is needed.',
            },
          },
          required: [
            'path',
            'fromLine',
            'toLine',
            'existingContent',
            'newContent',
            'rationale',
          ],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_run',
        description:
          'Run an external web tool equivalent to web.run({...}) for search and retrieval.',
        parameters: {
          type: 'object',
          properties: {
            search_query: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  q: { type: 'string' },
                  recency: { type: 'integer' },
                  domains: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['q'],
                additionalProperties: false,
              },
            },
            open: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ref_id: { type: 'string' },
                  lineno: { type: 'integer' },
                },
                required: ['ref_id'],
                additionalProperties: false,
              },
            },
            find: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ref_id: { type: 'string' },
                  pattern: { type: 'string' },
                },
                required: ['ref_id', 'pattern'],
                additionalProperties: false,
              },
            },
            click: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ref_id: { type: 'string' },
                  id: { type: 'integer' },
                },
                required: ['ref_id', 'id'],
                additionalProperties: false,
              },
            },
            image_query: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  q: { type: 'string' },
                  recency: { type: 'integer' },
                  domains: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['q'],
                additionalProperties: false,
              },
            },
            response_length: {
              type: 'string',
              enum: ['short', 'medium', 'long'],
            },
          },
          additionalProperties: true,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'compile',
        description: 'Compile the current Overleaf project.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_diagnostics',
        description:
          'Get compile diagnostics, especially output.log content and compile status.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
  ]
}

function getResponsesToolDefinitions() {
  return getToolDefinitions().map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

function buildChatMessages({
  messages,
  context,
  currentDocumentId,
  currentFileName,
  selectedText,
  selectionRange,
  rejectedEditProposal,
  hasImageAttachments,
  imageAttachmentCount,
}) {
  const systemPrompt = buildSystemPrompt({
    context,
    currentDocumentId,
    currentFileName,
    selectedText,
    selectionRange,
    rejectedEditProposal,
    hasImageAttachments,
    imageAttachmentCount,
  })

  return [
    { role: 'system', content: systemPrompt },
    ...messages.map(({ role, content, tool_calls, tool_call_id, attachments }) => {
      const imageAttachments = normalizeImageAttachments(attachments)
      const message = {
        role,
        content:
          role === 'user' && imageAttachments.length > 0
            ? [
                ...(content
                  ? [
                      {
                        type: 'text',
                        text: content,
                      },
                    ]
                  : []),
                ...imageAttachments.map(attachment => ({
                  type: 'image_url',
                  image_url: {
                    url: attachment.dataUrl,
                  },
                })),
              ]
            : content,
      }
      if (tool_calls) {
        message.tool_calls = tool_calls
      }
      if (tool_call_id) {
        message.tool_call_id = tool_call_id
      }
      return message
    }),
  ]
}

function buildResponsesInputItems({ messages }) {
  return messages.map(({ role, content, attachments }) => {
    const imageAttachments = normalizeImageAttachments(attachments)

    return {
      type: 'message',
      role,
      content:
        role === 'user' && imageAttachments.length > 0
          ? [
              ...(content
                ? [
                    {
                      type: 'input_text',
                      text: content,
                    },
                  ]
                : []),
              ...imageAttachments.map(attachment => ({
                type: 'input_image',
                image_url: attachment.dataUrl,
              })),
            ]
          : content,
    }
  })
}

function buildUpstreamPayload({
  messages,
  context,
  currentDocumentId,
  currentFileName,
  selectedText,
  selectionRange,
  rejectedEditProposal,
  hasImageAttachments,
  imageAttachmentCount,
  stream = true,
  includeTools = true,
  toolChoice = 'auto',
}) {
  if (usesResponsesApi()) {
    const systemPrompt = buildSystemPrompt({
      context,
      currentDocumentId,
      currentFileName,
      selectedText,
      selectionRange,
      rejectedEditProposal,
      hasImageAttachments,
      imageAttachmentCount,
    })

    const payload = {
      model: Settings.apis.aiChat.model,
      stream,
      instructions: systemPrompt,
      input: buildResponsesInputItems({ messages }),
      reasoning: {
        summary: 'auto',
      },
    }

    if (includeTools) {
      payload.tools = getResponsesToolDefinitions()
      payload.tool_choice = toolChoice
    }

    return payload
  }

  const payload = {
    model: Settings.apis.aiChat.model,
    stream,
    messages: buildChatMessages({
      messages,
      context,
      currentDocumentId,
      currentFileName,
      selectedText,
      selectionRange,
      rejectedEditProposal,
      hasImageAttachments,
      imageAttachmentCount,
    }),
  }

  if (includeTools) {
    payload.tools = getToolDefinitions()
    payload.tool_choice = toolChoice
  }

  return payload
}

function writeSseHeaders(res) {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function callUpstream(payload, { projectId, signal }) {
  const headers = {
    'Content-Type': 'application/json',
  }

  if (Settings.apis.aiChat.apiKey) {
    headers.Authorization = `Bearer ${Settings.apis.aiChat.apiKey}`
  }

  const response = await fetch(Settings.apis.aiChat.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    logger.error(
      {
        projectId,
        status: response.status,
        body: errorText,
      },
      'ai-chat upstream request failed'
    )
    throw new Error(errorText || 'AI upstream request failed')
  }

  return response.json()
}

async function callUpstreamStream(payload, { projectId, signal }) {
  const headers = {
    'Content-Type': 'application/json',
  }

  if (Settings.apis.aiChat.apiKey) {
    headers.Authorization = `Bearer ${Settings.apis.aiChat.apiKey}`
  }

  const response = await fetch(Settings.apis.aiChat.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    logger.error(
      {
        projectId,
        status: response.status,
        body: errorText,
      },
      'ai-chat upstream streaming request failed'
    )
    throw new Error(errorText || 'AI upstream streaming request failed')
  }

  return response
}

function extractAssistantMessage(response) {
  return response?.choices?.[0]?.message ?? null
}

async function listProjectFiles(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId)
  const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)

  return docs
    .concat(files)
    .sort((a, b) => (a.path > b.path ? 1 : a.path < b.path ? -1 : 0))
    .map(entity => ({
      path: entity.path,
      type: entity.doc != null ? 'doc' : 'file',
    }))
}

function formatAssistantContent(content) {
  if (Array.isArray(content)) {
    return content
      .map(item => item?.text ?? item?.content ?? '')
      .filter(Boolean)
      .join('')
  }

  return typeof content === 'string' ? content : ''
}

function extractStreamingTextDelta(parsed) {
  if (parsed?.type === 'response.output_text.delta' && typeof parsed?.delta === 'string') {
    return parsed.delta
  }

  if (parsed?.type === 'response.output_text.done' && typeof parsed?.text === 'string') {
    return parsed.text
  }

  if (
    parsed?.type === 'response.content_part.added' &&
    parsed?.part?.type === 'text' &&
    typeof parsed?.part?.text === 'string'
  ) {
    return parsed.part.text
  }

  if (
    parsed?.type === 'response.content_part.done' &&
    parsed?.part?.type === 'text' &&
    typeof parsed?.part?.text === 'string'
  ) {
    return parsed.part.text
  }

  if (
    parsed?.type === 'response.output_item.done' &&
    parsed?.item?.type === 'message' &&
    Array.isArray(parsed?.item?.content)
  ) {
    return parsed.item.content
      .map(item => {
        if (typeof item?.text === 'string') return item.text
        if (typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .join('')
  }

  if (typeof parsed?.delta === 'string') {
    return parsed.delta
  }

  return (
    parsed?.choices?.[0]?.delta?.content ??
    parsed?.choices?.[0]?.message?.content ??
    parsed?.content ??
    null
  )
}

function extractStreamingReasoningDelta(parsed) {
  return parsed?.choices?.[0]?.delta?.reasoning_content ?? null
}

function mergeStreamedToolCalls(toolCalls, deltaToolCalls = [], options = {}) {
  const replaceArguments = options.replaceArguments === true

  for (const partialToolCall of deltaToolCalls) {
    const index = Number.isInteger(partialToolCall?.index)
      ? partialToolCall.index
      : toolCalls.length

    if (!toolCalls[index]) {
      toolCalls[index] = {
        id: partialToolCall?.id ?? '',
        type: partialToolCall?.type ?? 'function',
        function: {
          name: partialToolCall?.function?.name ?? '',
          arguments: partialToolCall?.function?.arguments ?? '',
        },
      }
      continue
    }

    if (partialToolCall?.id) {
      toolCalls[index].id = partialToolCall.id
    }

    if (partialToolCall?.type) {
      toolCalls[index].type = partialToolCall.type
    }

    if (partialToolCall?.function?.name) {
      toolCalls[index].function.name += partialToolCall.function.name
    }

    if (partialToolCall?.function?.arguments) {
      toolCalls[index].function.arguments = replaceArguments
        ? partialToolCall.function.arguments
        : toolCalls[index].function.arguments + partialToolCall.function.arguments
    }
  }
}

async function collectStreamedAssistantMessage({
  payload,
  projectId,
  signal,
  res,
  emitAssistantDeltas = false,
}) {
  const response = await callUpstreamStream(payload, { projectId, signal })
  let buffer = ''
  let content = ''
  let reasoningContent = ''
  const toolCalls = []
  let responseId = null
  let reasoningStarted = false

  const ensureReasoningStarted = () => {
    if (reasoningStarted || !res) return
    reasoningStarted = true
    writeSseEvent(res, { type: 'reasoning-start' })
  }

  for await (const chunk of response.body) {
    if (signal?.aborted) {
      break
    }

    buffer += chunk.toString('utf8')
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const event of events) {
      const dataLines = event
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))

      for (const data of dataLines) {
        logger.debug({ projectId, data }, 'ai-chat upstream raw event')

        if (data === '[DONE]') {
          if (reasoningStarted && res) {
            writeSseEvent(res, { type: 'reasoning-end' })
          }
          return {
            role: 'assistant',
            content,
            reasoning_content: reasoningContent,
            tool_calls: toolCalls.filter(Boolean),
            response_id: responseId,
            reasoning_started: reasoningStarted,
          }
        }

        try {
          const parsed = JSON.parse(data)
          if (usesResponsesApi()) {
            if (typeof parsed?.response_id === 'string') {
              responseId = parsed.response_id
            } else if (typeof parsed?.response?.id === 'string') {
              responseId = parsed.response.id
            }

            if (
              parsed?.type === 'response.reasoning_summary_text.delta' ||
              parsed?.type === 'response.reasoning_text.delta'
            ) {
              const reasoningDelta =
                typeof parsed.delta === 'string' ? parsed.delta : ''
              if (reasoningDelta) {
                ensureReasoningStarted()
                writeSseEvent(res, {
                  type: 'reasoning-delta',
                  delta: reasoningDelta,
                })
              }
              continue
            }

            if (
              parsed?.type === 'response.reasoning_summary_text.done' ||
              parsed?.type === 'response.reasoning_text.done'
            ) {
              ensureReasoningStarted()
              continue
            }

            if (parsed?.type === 'response.output_item.added') {
              const item = parsed.item
              if (item?.type === 'function_call') {
                const index = Number.isInteger(parsed.output_index)
                  ? parsed.output_index
                  : toolCalls.length
                toolCalls[index] = {
                  id: item.call_id ?? item.id ?? '',
                  type: 'function',
                  function: {
                    name: item.name ?? '',
                    arguments: item.arguments ?? '',
                  },
                }
              }
              continue
            }

            if (parsed?.type === 'response.function_call_arguments.delta') {
              mergeStreamedToolCalls(toolCalls, [
                {
                  index: parsed.output_index,
                  id: parsed.call_id ?? parsed.item_id,
                  function: {
                    name: parsed.name ?? '',
                    arguments: parsed.delta ?? '',
                  },
                },
              ])
              continue
            }

            if (parsed?.type === 'response.function_call_arguments.done') {
              mergeStreamedToolCalls(toolCalls, [
                {
                  index: parsed.output_index,
                  id: parsed.call_id ?? parsed.item_id,
                  function: {
                    name: parsed.name ?? '',
                    arguments: parsed.arguments ?? '',
                  },
                },
              ], { replaceArguments: true })
              continue
            }
          }

          const choice = parsed?.choices?.[0]
          const delta = choice?.delta ?? {}
          const reasoningDelta = extractStreamingReasoningDelta(parsed)
          const deltaContent = extractStreamingTextDelta(parsed)

          if (typeof reasoningDelta === 'string' && reasoningDelta) {
            reasoningContent += reasoningDelta
            ensureReasoningStarted()
            writeSseEvent(res, {
              type: 'reasoning-delta',
              delta: reasoningDelta,
            })
          }

          if (typeof deltaContent === 'string' && deltaContent) {
            content += deltaContent
            if (emitAssistantDeltas && res) {
              writeSseEvent(res, { type: 'assistant_delta', content: deltaContent })
            }
          }

          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            mergeStreamedToolCalls(toolCalls, delta.tool_calls)
          }
        } catch (error) {
          logger.warn(
            { error, projectId, data },
            'ai-chat upstream streaming event could not be parsed'
          )
        }
      }
    }
  }

  return {
    role: 'assistant',
    content,
    reasoning_content: reasoningContent,
    tool_calls: toolCalls.filter(Boolean),
    response_id: responseId,
    reasoning_started: reasoningStarted,
  }
}

function buildResponsesFollowupPayload({
  previousResponseId,
  toolResults,
  context,
  currentDocumentId,
  currentFileName,
  selectedText,
  selectionRange,
}) {
  const systemPrompt = buildSystemPrompt({
    context,
    currentDocumentId,
    currentFileName,
    selectedText,
    selectionRange,
  })

  return {
    model: Settings.apis.aiChat.model,
    stream: true,
    previous_response_id: previousResponseId,
    instructions: systemPrompt,
    reasoning: {
      summary: 'auto',
    },
    input: toolResults.map(toolResult => ({
      type: 'function_call_output',
      call_id: toolResult.toolCallId,
      output: JSON.stringify(toolResult.output),
    })),
    tools: getResponsesToolDefinitions(),
    tool_choice: 'auto',
  }
}

async function streamAssistantResponse({
  payload,
  projectId,
  signal,
  res,
}) {
  const response = await callUpstreamStream(payload, { projectId, signal })

  let buffer = ''

  for await (const chunk of response.body) {
    if (signal?.aborted) {
      break
    }

    buffer += chunk.toString('utf8')
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const event of events) {
      const dataLines = event
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))

      for (const data of dataLines) {
        if (data === '[DONE]') {
          return
        }

        try {
          const parsed = JSON.parse(data)
          const content = extractStreamingTextDelta(parsed)
          if (typeof content === 'string' && content) {
            writeSseEvent(res, { type: 'assistant_delta', content })
          }
        } catch (error) {
          logger.warn(
            { error, projectId, data },
            'ai-chat upstream streaming event could not be parsed'
          )
        }
      }
    }
  }
}

async function runListFilesTool({ projectId, toolCall }) {
  logger.info(
    { projectId, toolCallId: toolCall.id, toolName: toolCall.function?.name },
    'ai-chat executing list_files'
  )
  const entities = await listProjectFiles(projectId)
  const preview = entities
    .slice(0, 20)
    .map(entity => `${entity.type}: ${entity.path}`)
    .join('\n')
  const suffix =
    entities.length > 20 ? `\n... and ${entities.length - 20} more` : ''

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'list_files',
    title: 'List files',
    input: {},
    resultSummary: preview + suffix,
    output: {
      project_id: projectId,
      entities,
    },
  }
}

async function runReadCurrentFileTool({
  projectId,
  currentDocumentId,
  currentFileName,
  currentDocumentContent,
  toolCall,
}) {
  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
      currentDocumentId,
      currentFileName,
    },
    'ai-chat executing read_current_file'
  )

  if (!currentDocumentId) {
    throw new Error('No current document is available to read.')
  }

  const lines =
    typeof currentDocumentContent === 'string'
      ? currentDocumentContent.split('\n')
      : (
          await DocumentUpdaterHandler.promises.getDocument(
            projectId,
            currentDocumentId,
            -1
          )
        ).lines

  const content = lines.join('\n')
  const preview = lines.slice(0, 20).join('\n')
  const suffix = lines.length > 20 ? '\n... (truncated in preview)' : ''

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'read_current_file',
    title: 'Read current file',
    input: {},
    resultSummary: preview + suffix,
    output: {
      project_id: projectId,
      doc_id: currentDocumentId,
      path: currentFileName ?? null,
      line_count: lines.length,
      content,
    },
  }
}

function parseToolArguments(toolCall) {
  const rawArguments = toolCall.function?.arguments

  if (typeof rawArguments !== 'string' || !rawArguments.trim()) {
    return {}
  }

  const normalized = rawArguments.trim().replace(/^```json\s*/i, '').replace(/```$/i, '')

  try {
    return JSON.parse(normalized)
  } catch (error) {
    throw new Error(
      `Failed to parse tool arguments for ${toolCall.function?.name ?? 'tool'}.`
    )
  }
}

function getPreliminaryToolTitle(toolCall) {
  const name = toolCall.function?.name ?? 'tool'
  try {
    const args = parseToolArguments(toolCall)
    if (name === 'replace_lines' && args.fromLine && args.toLine) {
      return `Replace lines ${args.fromLine}-${args.toLine}`
    }
    if (name === 'read_lines' && args.from && args.to) {
      return `Read lines ${args.from}-${args.to}`
    }
    if (name === 'read_current_file') return 'Read current file'
    if (name === 'list_files') return 'List files'
    if (name === 'open_file' && args.path) return `Open file: ${args.path}`
    if (name === 'search_file' && args.query) return `Search: ${args.query}`
    if (name === 'compile') return 'Compile'
    if (name === 'get_diagnostics') return 'Get diagnostics'
    if (name === 'web_run') return 'Web search'
  } catch {}
  return name
}

async function getCurrentDocumentLines(
  projectId,
  currentDocumentId,
  currentDocumentContent
) {
  if (typeof currentDocumentContent === 'string') {
    return currentDocumentContent.split('\n')
  }

  if (!currentDocumentId) {
    throw new Error('No current document is available.')
  }

  const { lines } = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    currentDocumentId,
    -1
  )

  return lines
}

async function runReadLinesTool({
  projectId,
  currentDocumentId,
  currentFileName,
  currentDocumentContent,
  toolCall,
}) {
  const parsedArguments = parseToolArguments(toolCall)
  const from = Number(parsedArguments.from)
  const to = Number(parsedArguments.to)

  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
      currentDocumentId,
      currentFileName,
      from,
      to,
    },
    'ai-chat executing read_lines'
  )

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error('read_lines requires integer "from" and "to" arguments.')
  }

  const lines = await getCurrentDocumentLines(
    projectId,
    currentDocumentId,
    currentDocumentContent
  )
  const startIndex = from - 1
  const endIndex = to

  if (startIndex < 0 || endIndex < startIndex || endIndex > lines.length) {
    throw new Error(
      `Invalid line range ${from}-${to} for current file with ${lines.length} lines.`
    )
  }

  const selectedLines = lines.slice(startIndex, endIndex)
  const content = selectedLines.join('\n')
  const numberedContent = selectedLines
    .map((line, index) => `L${from + index}: ${line}`)
    .join('\n')

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'read_lines',
    title: `Read lines ${from}-${to}`,
    input: { from, to },
    resultSummary: numberedContent,
    output: {
      project_id: projectId,
      doc_id: currentDocumentId,
      path: currentFileName ?? null,
      from,
      to,
      line_count: selectedLines.length,
      content,
    },
  }
}

async function runSearchFileTool({
  projectId,
  currentDocumentId,
  currentFileName,
  currentDocumentContent,
  toolCall,
}) {
  const parsedArguments = parseToolArguments(toolCall)
  const query =
    typeof parsedArguments.query === 'string' ? parsedArguments.query.trim() : ''

  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
      currentDocumentId,
      currentFileName,
      query,
    },
    'ai-chat executing search_file'
  )

  if (!query) {
    throw new Error('search_file requires a non-empty "query" argument.')
  }

  const lines = await getCurrentDocumentLines(
    projectId,
    currentDocumentId,
    currentDocumentContent
  )
  const matches = lines
    .map((line, index) => ({ lineNumber: index + 1, line }))
    .filter(entry => entry.line.includes(query))

  const preview = matches.length
    ? matches
        .slice(0, 20)
        .map(entry => `L${entry.lineNumber}: ${entry.line}`)
        .join('\n')
    : `No matches found for "${query}".`

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'search_file',
    title: 'Search file',
    input: { query },
    resultSummary: preview,
    output: {
      project_id: projectId,
      doc_id: currentDocumentId,
      path: currentFileName ?? null,
      query,
      total_matches: matches.length,
      matches: matches.slice(0, 100).map(entry => ({
        line: entry.lineNumber,
        content: entry.line,
      })),
    },
  }
}

function validateWebRunArgs(args) {
  const presentKeys = Object.keys(args).filter(key => args[key] != null)
  const supportedKeys = presentKeys.filter(key =>
    ['search_query', 'open', 'response_length'].includes(key)
  )

  if (supportedKeys.length === 0) {
    throw new Error(
      'web_run currently supports search_query, open, and response_length.'
    )
  }

  const unsupportedKeys = presentKeys.filter(key => !supportedKeys.includes(key))
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `web_run does not support these fields yet: ${unsupportedKeys.join(', ')}`
    )
  }

  return supportedKeys
}

function mapResponseLengthToMaxResults(responseLength) {
  if (responseLength === 'long') return 10
  if (responseLength === 'medium') return 7
  return 5
}

function buildTavilySearchPayload(input) {
  const queries = Array.isArray(input.search_query) ? input.search_query : []
  const firstQuery = queries.find(
    item => item && typeof item.q === 'string' && item.q.trim()
  )

  if (!firstQuery) {
    throw new Error('web_run.search_query requires at least one query with a non-empty q field.')
  }

  return {
    query: firstQuery.q.trim(),
    search_depth: 'basic',
    max_results: mapResponseLengthToMaxResults(input.response_length),
    include_answer: true,
  }
}

function extractOpenTarget(input) {
  const openItems = Array.isArray(input.open) ? input.open : []
  const firstOpen = openItems.find(
    item => item && typeof item.ref_id === 'string' && item.ref_id.trim()
  )

  if (!firstOpen) {
    throw new Error('web_run.open requires at least one item with ref_id.')
  }

  return firstOpen.ref_id.trim()
}

function createSearchRefId(step, index) {
  return `turn${step}search${index}`
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

function htmlToReadableText(html) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')

  const text = sanitizeHtml(withoutScripts, {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  return text
}

async function runWebOpen(input, webState) {
  const target = extractOpenTarget(input)
  const resolvedTarget = webState?.searchRefs?.get(target) ?? target

  if (!isHttpUrl(resolvedTarget)) {
    throw new Error(
      'web_run.open currently expects ref_id to be either a known search result reference or a full http/https URL.'
    )
  }

  const response = await fetch(resolvedTarget, {
    method: 'GET',
    headers: {
      'User-Agent': 'Overleaf-AI-Chat/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(Settings.apis.aiChat.webRun.timeout),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `web_run.open failed with status ${response.status}`)
  }

  const html = await response.text()
  const text = htmlToReadableText(html).slice(0, 12000)

  return {
    opened_url: resolvedTarget,
    content: text,
  }
}

function attachSearchRefsToResults(output, step, webState) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.results)) {
    return output
  }

  const results = output.results.map((item, index) => {
    const refId = createSearchRefId(step, index)
    const url =
      typeof item?.url === 'string'
        ? item.url
        : typeof item?.link === 'string'
          ? item.link
          : null

    if (url) {
      webState.searchRefs.set(refId, url)
    }

    return {
      ...item,
      ref_id: refId,
    }
  })

  return {
    ...output,
    results,
  }
}

function summarizeWebRunResult(result) {
  if (typeof result === 'string') {
    return result.slice(0, 4000)
  }

  if (Array.isArray(result)) {
    return JSON.stringify(result.slice(0, 10), null, 2)
  }

  if (result && typeof result === 'object') {
    if (typeof result.opened_url === 'string') {
      return `Opened URL:\n${result.opened_url}`
    }

    if (Array.isArray(result.results)) {
      return result.results
        .slice(0, 8)
        .map((item, index) => {
          const refId =
            typeof item.ref_id === 'string' ? item.ref_id : `Result ${index + 1}`
          const title =
            typeof item.title === 'string'
              ? item.title
              : typeof item.name === 'string'
                ? item.name
                : `Result ${index + 1}`
          const url =
            typeof item.url === 'string'
              ? item.url
              : typeof item.link === 'string'
                ? item.link
                : typeof item.ref_id === 'string'
                  ? item.ref_id
                  : ''
          const snippet =
            typeof item.snippet === 'string'
              ? item.snippet
              : typeof item.description === 'string'
                ? item.description
                : ''
          return [refId, title, url, snippet].filter(Boolean).join('\n')
        })
        .join('\n\n')
    }

    return JSON.stringify(result, null, 2).slice(0, 4000)
  }

  return 'web.run returned no usable result.'
}

async function runWebRunTool({ projectId, toolCall, webState }) {
  if (!Settings.apis.aiChat.webRun?.enabled) {
    throw new Error('web_run is not enabled.')
  }

  if (!Settings.apis.aiChat.webRun?.url) {
    throw new Error('web_run URL is not configured.')
  }

  const input = parseToolArguments(toolCall)
  const supportedKeys = validateWebRunArgs(input)

  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
      supportedKeys,
    },
    'ai-chat executing web_run'
  )

  let output
  if (Array.isArray(input.open) && input.open.length > 0) {
    output = await runWebOpen(input, webState)
  } else {
    const tavilyPayload = buildTavilySearchPayload(input)
    const headers = {
      'Content-Type': 'application/json',
    }

    if (Settings.apis.aiChat.webRun.apiKey) {
      headers.Authorization = `Bearer ${Settings.apis.aiChat.webRun.apiKey}`
    }

    const response = await fetch(Settings.apis.aiChat.webRun.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(tavilyPayload),
      signal: AbortSignal.timeout(Settings.apis.aiChat.webRun.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || `web_run failed with status ${response.status}`)
    }

    const contentType = response.headers.get('content-type') || ''
    output = contentType.includes('application/json')
      ? await response.json()
      : await response.text()

    output = attachSearchRefsToResults(output, webState.step, webState)
  }

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'web_run',
    title: 'Web search',
    input,
    resultSummary: summarizeWebRunResult(output),
    output,
  }
}

function normalizeProjectPath(filePath) {
  if (typeof filePath !== 'string') return null
  const normalized = filePath.trim().replace(/^\/+/, '')
  return normalized || null
}

async function resolveProjectPath(projectId, filePath) {
  const normalizedPath = normalizeProjectPath(filePath)
  if (!normalizedPath) {
    throw new Error('open_file requires a non-empty path.')
  }

  const project = await ProjectGetter.promises.getProject(projectId)
  const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)

  const docEntry = docs.find(
    entity => normalizeProjectPath(entity.path) === normalizedPath
  )
  if (docEntry) {
    return { type: 'doc', path: normalizedPath, entity: docEntry.doc }
  }

  const fileEntry = files.find(
    entity => normalizeProjectPath(entity.path) === normalizedPath
  )
  if (fileEntry) {
    return { type: 'file', path: normalizedPath, entity: fileEntry.file }
  }

  throw new Error(`Project file not found: ${normalizedPath}`)
}

async function readBlobAsUtf8(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isLikelyBinaryText(content) {
  return content.includes('\u0000')
}

function normalizeComparableSourceText(content) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '')
}

async function readStreamAsUtf8(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function summarizeCompileOutputFiles(outputFiles = []) {
  if (!Array.isArray(outputFiles) || outputFiles.length === 0) {
    return 'No output files were produced.'
  }

  return outputFiles
    .slice(0, 20)
    .map(file => {
      const path = typeof file?.path === 'string' ? file.path : 'unknown'
      const type = typeof file?.type === 'string' ? file.type : 'file'
      return `${type}: ${path}`
    })
    .join('\n')
}

async function compileProjectForTool({ projectId, userId }) {
  const compile = await CompileManager.promises.compile(projectId, userId, {})
  const limits =
    compile?.limits ??
    (await CompileManager.promises.getProjectCompileLimits(projectId))

  return {
    ...compile,
    limits,
  }
}

async function fetchCompileLog({
  projectId,
  userId,
  compileState,
}) {
  if (
    !compileState?.clsiServerId ||
    !compileState?.buildId ||
    !compileState?.limits
  ) {
    return null
  }

  try {
    const stream = await ClsiManager.promises.getOutputFileStream(
      projectId,
      userId,
      compileState.limits,
      compileState.clsiServerId,
      compileState.buildId,
      'output.log'
    )

    const content = await readStreamAsUtf8(stream)
    return content || null
  } catch (error) {
    logger.warn(
      {
        error,
        projectId,
        buildId: compileState.buildId,
      },
      'ai-chat could not fetch output.log'
    )
    return null
  }
}

function buildValidationProblemSummary(validationProblems = []) {
  if (!Array.isArray(validationProblems) || validationProblems.length === 0) {
    return ''
  }

  return validationProblems
    .slice(0, 20)
    .map(problem => {
      if (typeof problem === 'string') {
        return problem
      }
      const message =
        typeof problem?.message === 'string'
          ? problem.message
          : JSON.stringify(problem)
      return message
    })
    .join('\n')
}

async function runCompileTool({
  projectId,
  userId,
  toolCall,
}) {
  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
    },
    'ai-chat executing compile'
  )

  const compileState = await compileProjectForTool({ projectId, userId })
  const outputFilesSummary = summarizeCompileOutputFiles(compileState.outputFiles)
  const validationSummary = buildValidationProblemSummary(
    compileState.validationProblems
  )
  const resultSummary = [
    `status: ${compileState.status ?? 'unknown'}`,
    outputFilesSummary,
    validationSummary,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'compile',
    title: 'Compile project',
    input: {},
    resultSummary,
    output: {
      project_id: projectId,
      status: compileState.status ?? 'unknown',
      output_files: Array.isArray(compileState.outputFiles)
        ? compileState.outputFiles.map(file => ({
            path: file?.path ?? null,
            type: file?.type ?? null,
            build: file?.build ?? null,
          }))
        : [],
      validation_problems: Array.isArray(compileState.validationProblems)
        ? compileState.validationProblems
        : [],
    },
    nextCompileState: compileState,
  }
}

async function runDiagnosticsTool({
  projectId,
  userId,
  toolCall,
  compileState,
}) {
  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
      hasCompileState: Boolean(compileState),
    },
    'ai-chat executing get_diagnostics'
  )

  const effectiveCompileState =
    compileState ?? (await compileProjectForTool({ projectId, userId }))
  const outputLog = await fetchCompileLog({
    projectId,
    userId,
    compileState: effectiveCompileState,
  })

  const validationSummary = buildValidationProblemSummary(
    effectiveCompileState.validationProblems
  )
  const logPreview = outputLog
    ? outputLog.slice(-12000)
    : 'No output.log content was available for the latest compile.'
  const resultSummary = [
    `status: ${effectiveCompileState.status ?? 'unknown'}`,
    validationSummary,
    logPreview,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'get_diagnostics',
    title: 'Get diagnostics',
    input: {},
    resultSummary,
    output: {
      project_id: projectId,
      status: effectiveCompileState.status ?? 'unknown',
      validation_problems: Array.isArray(effectiveCompileState.validationProblems)
        ? effectiveCompileState.validationProblems
        : [],
      output_log: outputLog,
    },
    nextCompileState: effectiveCompileState,
  }
}

async function runOpenFileTool({ projectId, toolCall }) {
  const parsedArguments = parseToolArguments(toolCall)

  const targetPath =
    typeof parsedArguments.path === 'string' ? parsedArguments.path : null
  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
      targetPath,
    },
    'ai-chat executing open_file'
  )
  const resolved = await resolveProjectPath(projectId, targetPath)

  if (resolved.type === 'doc') {
    const { lines } = await DocumentUpdaterHandler.promises.getDocument(
      projectId,
      resolved.entity._id,
      -1
    )
    const content = lines.join('\n')
    const preview = lines.slice(0, 20).join('\n')
    const suffix = lines.length > 20 ? '\n... (truncated in preview)' : ''

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name ?? 'open_file',
      title: 'Open file',
      input: { path: resolved.path },
      resultSummary: preview + suffix,
      output: {
        project_id: projectId,
        path: resolved.path,
        type: 'doc',
        line_count: lines.length,
        content,
      },
    }
  }

  const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
    projectId,
    resolved.entity.hash,
    'GET'
  )
  const content = await readBlobAsUtf8(stream)

  if (isLikelyBinaryText(content)) {
    throw new Error(
      `The file "${resolved.path}" does not look like a UTF-8 text file.`
    )
  }

  const lines = content.split('\n')
  const preview = lines.slice(0, 20).join('\n')
  const suffix = lines.length > 20 ? '\n... (truncated in preview)' : ''

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'open_file',
    title: 'Open file',
    input: { path: resolved.path },
    resultSummary: preview + suffix,
    output: {
      project_id: projectId,
      path: resolved.path,
      type: 'file',
      line_count: lines.length,
      content,
    },
  }
}

async function resolveWritableProjectDoc(projectId, filePath) {
  const resolved = await resolveProjectPath(projectId, filePath)

  if (resolved.type !== 'doc') {
    throw new Error(
      `The file "${resolved.path}" is not a writable text document in Overleaf.`
    )
  }

  return resolved
}

async function runReplaceLinesTool({
  projectId,
  userId,
  currentDocumentId,
  currentFileName,
  currentDocumentContent,
  selectedText,
  selectionRange,
  toolCall,
}) {
  const parsedArguments = parseToolArguments(toolCall)
  const path =
    typeof parsedArguments.path === 'string' ? parsedArguments.path : null
  let fromLine = Number(parsedArguments.fromLine)
  let toLine = Number(parsedArguments.toLine)
  let existingContent =
    typeof parsedArguments.existingContent === 'string'
      ? parsedArguments.existingContent
      : null
  const newContent =
    typeof parsedArguments.newContent === 'string'
      ? parsedArguments.newContent
      : null
  const rationale =
    typeof parsedArguments.rationale === 'string'
      ? parsedArguments.rationale.trim()
      : ''

  logger.info(
    {
      projectId,
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name,
      path,
      fromLine,
      toLine,
    },
    'ai-chat executing replace_lines'
  )

  if (!path) {
    throw new Error('replace_lines requires a non-empty "path" argument.')
  }

  if (!Number.isInteger(fromLine) || !Number.isInteger(toLine)) {
    throw new Error(
      'replace_lines requires integer "fromLine" and "toLine" arguments.'
    )
  }

  if (existingContent == null || newContent == null) {
    throw new Error(
      'replace_lines requires string "existingContent" and "newContent" arguments.'
    )
  }

  const resolved = await resolveWritableProjectDoc(projectId, path)
  const isCurrentOpenDoc =
    currentDocumentId &&
    resolved.entity._id?.toString() === currentDocumentId &&
    (!currentFileName || normalizeProjectPath(currentFileName) === resolved.path)

  if (
    isCurrentOpenDoc &&
    selectionRange?.startLine != null &&
    selectionRange?.endLine != null &&
    typeof selectedText === 'string'
  ) {
    fromLine = selectionRange.startLine
    toLine = selectionRange.endLine
    existingContent = selectedText
  }

  const lines =
    typeof currentDocumentContent === 'string' && isCurrentOpenDoc
      ? currentDocumentContent.split('\n')
      : (
          await DocumentUpdaterHandler.promises.getDocument(
            projectId,
            resolved.entity._id,
            -1
          )
        ).lines
  const startIndex = fromLine - 1
  const endIndex = toLine

  if (startIndex < 0 || endIndex < startIndex || endIndex > lines.length) {
    throw new Error(
      `Invalid edit range ${fromLine}-${toLine} for ${resolved.path}.`
    )
  }

  const currentContent = lines.slice(startIndex, endIndex).join('\n')
  if (
    normalizeComparableSourceText(currentContent) !==
    normalizeComparableSourceText(existingContent)
  ) {
    throw new Error(
      'Document content has changed. Please read the file again and regenerate the edit.'
    )
  }

  const preview = [
    `Prepared a proposed edit for ${resolved.path} lines ${fromLine}-${toLine}.`,
    rationale ? `Reason: ${rationale}` : '',
    newContent,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? 'replace_lines',
    title: `Replace lines ${fromLine}-${toLine}`,
    input: {
      path: resolved.path,
      fromLine,
      toLine,
      rationale,
    },
    resultSummary: preview,
    output: {
      project_id: projectId,
      doc_id: resolved.entity._id,
      path: resolved.path,
      fromLine,
      toLine,
      existingContent,
      newContent,
      rationale,
      applied: false,
      requires_confirmation: true,
    },
  }
}

async function executeSupportedTool({
  projectId,
  userId,
  currentDocumentId,
  currentFileName,
  currentDocumentContent,
  selectedText,
  selectionRange,
  toolCall,
  webState,
  compileState,
}) {
  if (toolCall.function?.name === 'replace_lines') {
    return runReplaceLinesTool({
      projectId,
      userId,
      currentDocumentId,
      currentFileName,
      currentDocumentContent,
      selectedText,
      selectionRange,
      toolCall,
    })
  }

  if (toolCall.function?.name === 'compile') {
    return runCompileTool({
      projectId,
      userId,
      toolCall,
    })
  }

  if (toolCall.function?.name === 'get_diagnostics') {
    return runDiagnosticsTool({
      projectId,
      userId,
      toolCall,
      compileState,
    })
  }

  if (toolCall.function?.name === 'read_lines') {
    return runReadLinesTool({
      projectId,
      currentDocumentId,
      currentFileName,
      currentDocumentContent,
      toolCall,
    })
  }

  if (toolCall.function?.name === 'search_file') {
    return runSearchFileTool({
      projectId,
      currentDocumentId,
      currentFileName,
      currentDocumentContent,
      toolCall,
    })
  }

  if (toolCall.function?.name === 'web_run') {
    return runWebRunTool({
      projectId,
      toolCall,
      webState,
    })
  }

  if (toolCall.function?.name === 'read_current_file') {
    return runReadCurrentFileTool({
      projectId,
      currentDocumentId,
      currentFileName,
      currentDocumentContent,
      toolCall,
    })
  }

  if (toolCall.function?.name === 'open_file') {
    return runOpenFileTool({
      projectId,
      toolCall,
    })
  }

  return runListFilesTool({
    projectId,
    toolCall,
  })
}

async function streamChat({
  projectId,
  userId,
  messages,
  context,
  currentDocumentId,
  currentFileName,
  currentDocumentContent,
  selectedText,
  selectionRange,
  rejectedEditProposal,
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

  writeSseHeaders(res)
  writeSseEvent(res, { type: 'start' })

  try {
    const conversationMessages = [...messages]
    const latestUserMessage = [...messages].reverse().find(
      message => message?.role === 'user'
    )
    const imageAttachmentCount = normalizeImageAttachments(
      latestUserMessage?.attachments
    ).length
    const hasImageAttachments = imageAttachmentCount > 0
    let toolExecuted = false
    let compileState = null
    const webState = {
      step: 0,
      searchRefs: new Map(),
    }
    let payload = buildUpstreamPayload({
      messages,
      context,
      currentDocumentId,
      currentFileName,
      selectedText,
      selectionRange,
      rejectedEditProposal,
      hasImageAttachments,
      imageAttachmentCount,
    })
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      webState.step = step
      const assistantMessage = await collectStreamedAssistantMessage({
        payload,
        projectId,
        signal,
        res,
        emitAssistantDeltas: !toolExecuted || usesResponsesApi(),
      })

      if (!assistantMessage) {
        writeSseEvent(res, {
          type: 'assistant_delta',
          content: 'AI returned an empty response.',
        })
        writeSseEvent(res, { type: 'finish', finishReason: 'stop' })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      const toolCalls = assistantMessage.tool_calls ?? []
      logger.info(
        {
          projectId,
          step,
          toolCalls: toolCalls.map(toolCall => ({
            id: toolCall.id,
            name: toolCall.function?.name,
            arguments: toolCall.function?.arguments,
          })),
        },
        'ai-chat response tool calls'
      )

      if (toolCalls.length === 0) {
        if (toolExecuted) {
          if (!usesResponsesApi()) {
            const streamingPayload = buildUpstreamPayload({
              messages: conversationMessages,
              context,
              currentDocumentId,
              currentFileName,
              selectedText,
              selectionRange,
              hasImageAttachments,
              imageAttachmentCount,
              stream: true,
              includeTools: false,
            })

            await streamAssistantResponse({
              payload: streamingPayload,
              projectId,
              signal,
              res,
            })
          }
        }
        writeSseEvent(res, { type: 'finish', finishReason: 'stop' })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      const supportedToolCall = toolCalls.find(toolCall =>
        [
          'list_files',
          'read_current_file',
          'open_file',
          'read_lines',
          'search_file',
          'replace_lines',
          'web_run',
          'compile',
          'get_diagnostics',
        ].includes(toolCall.function?.name ?? '')
      )

      if (!supportedToolCall) {
        writeSseEvent(res, {
          type: 'assistant_delta',
          content: 'The model requested an unsupported tool.',
        })
        writeSseEvent(res, { type: 'finish', finishReason: 'stop' })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      writeSseEvent(res, { type: 'start-step' })
      writeSseEvent(res, {
        type: 'tool-input-start',
        toolCallId: supportedToolCall.id,
        toolName: supportedToolCall.function?.name ?? 'tool',
        title: getPreliminaryToolTitle(supportedToolCall),
      })

      const toolResult = await executeSupportedTool({
        projectId,
        userId,
        currentDocumentId,
        currentFileName,
        currentDocumentContent,
        selectedText,
        selectionRange,
        toolCall: supportedToolCall,
        webState,
        compileState,
      })

      if (toolResult.nextCompileState) {
        compileState = toolResult.nextCompileState
      }

      writeSseEvent(res, {
        type: 'tool-input-available',
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        input: toolResult.input,
        title: toolResult.title,
      })
      writeSseEvent(res, {
        type: 'tool_result',
        callId: toolResult.toolCallId,
        name: toolResult.toolName,
        status: toolResult.toolName === 'replace_lines' ? 'pending' : 'completed',
        resultSummary: toolResult.resultSummary,
      })
      writeSseEvent(res, { type: 'finish-step' })
      if (toolResult.toolName === 'replace_lines') {
        writeSseEvent(res, {
          type: 'edit_proposal',
          docId: toolResult.output.doc_id,
          path: toolResult.output.path,
          fromLine: toolResult.output.fromLine,
          toLine: toolResult.output.toLine,
          existingContent: toolResult.output.existingContent,
          newContent: toolResult.output.newContent,
          rationale: toolResult.output.rationale,
        })
        writeSseEvent(res, { type: 'finish', finishReason: 'stop' })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      writeSseEvent(res, { type: 'finish', finishReason: 'tool-calls' })
      toolExecuted = true

      conversationMessages.push({
        role: 'assistant',
        content: assistantMessage.content ?? '',
        tool_calls: toolCalls,
        ...(assistantMessage.reasoning_content
          ? { reasoning_content: assistantMessage.reasoning_content }
          : {}),
      })
      conversationMessages.push({
        role: 'tool',
        tool_call_id: toolResult.toolCallId,
        content: JSON.stringify(toolResult.output),
      })

      payload = usesResponsesApi()
        ? buildResponsesFollowupPayload({
            previousResponseId: assistantMessage.response_id,
            toolResults: [toolResult],
            context,
            currentDocumentId,
            currentFileName,
            selectedText,
            selectionRange,
          })
        : buildUpstreamPayload({
            messages: conversationMessages,
            context,
            currentDocumentId,
            currentFileName,
            selectedText,
            selectionRange,
            hasImageAttachments,
            imageAttachmentCount,
          })
    }

    writeSseEvent(res, {
      type: 'assistant_delta',
      content: `AI exceeded the maximum tool-call depth (${MAX_TOOL_STEPS}).`,
    })
    writeSseEvent(res, { type: 'finish', finishReason: 'stop' })
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (error) {
    logger.error({ error, projectId }, 'ai-chat tool loop failed')
    writeSseEvent(res, {
      type: 'assistant_delta',
      content: error instanceof Error ? error.message : 'AI chat failed',
    })
    writeSseEvent(res, { type: 'finish', finishReason: 'stop' })
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

async function applyEditProposal({
  projectId,
  docId,
  fromLine,
  toLine,
  existingContent,
  newContent,
  userId,
}) {
  const { lines } = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    docId,
    -1
  )

  const startIndex = fromLine - 1
  const endIndex = toLine

  if (startIndex < 0 || endIndex < startIndex || endIndex > lines.length) {
    throw new Error('Invalid edit range')
  }

  const currentContent = lines.slice(startIndex, endIndex).join('\n')
  if (
    normalizeComparableSourceText(currentContent) !==
    normalizeComparableSourceText(existingContent)
  ) {
    throw new Error(
      'Document content has changed. Please ask AI to regenerate the patch.'
    )
  }

  const replacementLines = newContent === '' ? [] : newContent.split('\n')
  const nextLines = [
    ...lines.slice(0, startIndex),
    ...replacementLines,
    ...lines.slice(endIndex),
  ]

  await DocumentUpdaterHandler.promises.setDocument(
    projectId,
    docId,
    userId,
    nextLines,
    'ai-chat'
  )
}

export default {
  streamChat,
  applyEditProposal,
}
