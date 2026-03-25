import { useEffect, useMemo, useRef, useState } from 'react'
import { diffWordsWithSpace } from 'diff'
import MaterialIcon from '@/shared/components/material-icon'
import {
  useAiChatContext,
  type AiChatMessage,
  type AiChatToolCall,
} from '../context/ai-chat-context'
import AiChatMarkdown from './ai-chat-markdown'

function AiChatMessageList({ messages }: { messages: AiChatMessage[] }) {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="conversation-content ai-chat-messages">
      {messages.map(message => (
        <AiChatMessageCard key={message.id} message={message} />
      ))}
      <div ref={messagesEndRef} />
    </div>
  )
}

function AiChatMessageCard({ message }: { message: AiChatMessage }) {
  return (
    <div
      className={`workbench-message ai-chat-message ai-chat-message-${message.role} ${
        message.role === 'assistant' ? 'from-assistant' : 'from-user'
      }`}
    >
      <div className="workbench-message-content ai-chat-message-card">
        <div className="ai-chat-message-body">
          <div className="ai-chat-message-header">
            <div className="ai-chat-message-avatar">
              {message.role === 'assistant' ? (
                <span className="ai-chat-avatar-icon">
                  <MaterialIcon type="smart_toy" />
                </span>
              ) : (
                <span className="ai-chat-avatar-icon ai-chat-avatar-user">
                  <MaterialIcon type="person" />
                </span>
              )}
            </div>
            <div className="ai-chat-message-role">
              {message.role === 'assistant' ? 'AI Assistant' : 'You'}
            </div>
          </div>
          {message.editorContext && <ContextBadges ctx={message.editorContext} />}
          {message.role === 'assistant' && message.reasoning && (
            <ReasoningPanel reasoning={message.reasoning} />
          )}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <ToolCallList toolCalls={message.toolCalls} />
          )}
          <div className="ai-chat-message-content">
            <AiChatMarkdown content={message.content} />
          </div>
          {message.editProposal && (
            <EditProposalCard
              messageId={message.id}
              proposal={message.editProposal}
            />
          )}
          {message.isStreaming && (
            <div className="ai-chat-message-streaming">
              <span className="ai-chat-cursor" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReasoningPanel({
  reasoning,
}: {
  reasoning: NonNullable<AiChatMessage['reasoning']>
}) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const hasContent = !!reasoning.content.trim()
  const isRunning = reasoning.status === 'running'

  useEffect(() => {
    if (!isRunning) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [isRunning])

  const elapsedSeconds = useMemo(() => {
    const end = reasoning.finishedAt ?? now
    return Math.max(1, Math.round((end - reasoning.startedAt) / 1000))
  }, [now, reasoning.finishedAt, reasoning.startedAt])

  return (
    <div className="reasoning ai-chat-reasoning">
      <button
        type="button"
        className="reasoning-toggle ai-chat-reasoning-toggle"
        onClick={() => setExpanded(value => !value)}
      >
        <div className="reasoning-label ai-chat-reasoning-label">
          <span className="ai-chat-reasoning-status-icon">
            {isRunning ? (
              <span className="ai-chat-spinner" aria-hidden="true" />
            ) : (
              <MaterialIcon type="check_circle" />
            )}
          </span>
          <span className="mx-1 reasoning-label-text">
            {`Thought for ${elapsedSeconds}s`}
          </span>
          <span
            className={`ai-chat-reasoning-chevron ${expanded ? 'is-expanded' : ''}`}
          >
            <MaterialIcon type="expand_more" />
          </span>
        </div>
      </button>
      <div
        className={`reasoning-content ai-chat-reasoning-content ${
          expanded ? '' : 'reasoning-collapsed'
        }`}
      >
        <div className="space-y-4 whitespace-normal *:first:mt-0 *:last:mb-0">
          {hasContent ? (
            <AiChatMarkdown content={reasoning.content} />
          ) : (
            <p className="ai-chat-reasoning-placeholder">Thinking...</p>
          )}
        </div>
      </div>
    </div>
  )
}

function ToolCallList({ toolCalls }: { toolCalls: AiChatToolCall[] }) {
  return (
    <div className="ai-chat-tool-use-group">
      {toolCalls.map(toolCall => (
        <ToolUseItem key={toolCall.id} toolCall={toolCall} />
      ))}
    </div>
  )
}

function ToolUseItem({ toolCall }: { toolCall: AiChatToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetails =
    !!toolCall.resultSummary ||
    !!toolCall.rawInput ||
    hasDisplayableArgs(toolCall.args)
  const isPendingApproval =
    toolCall.status === 'pending' && toolCall.name === 'replace_lines'

  return (
    <div className="tool-use rounded w-100 ai-chat-tool-use">
      <button
        type="button"
        aria-expanded={expanded}
        className="d-flex w-100 align-items-center p-0 bg-transparent border-0 text-start small tool-header ai-chat-tool-header"
        onClick={() => hasDetails && setExpanded(value => !value)}
      >
        <div className="d-flex align-items-center ai-chat-tool-header-main">
          <span className="me-1 d-flex align-items-center ai-chat-tool-header-icon">
            {isPendingApproval ? (
              <MaterialIcon
                type="schedule"
                className="ai-chat-tool-status-pending"
              />
            ) : toolCall.status === 'completed' ? (
              <MaterialIcon type="check_circle" />
            ) : (
              <span className="ai-chat-spinner ai-chat-tool-spinner" aria-hidden="true" />
            )}
          </span>
          <span>{toolCall.title || toolCall.name}</span>
        </div>
        {hasDetails && (
          <span
            className={`ai-chat-tool-chevron ${expanded ? 'is-expanded' : ''}`}
          >
            <MaterialIcon type="expand_more" />
          </span>
        )}
      </button>
      {hasDetails && (
        <div className={`ai-chat-tool-details ${expanded ? '' : 'is-collapsed'}`}>
          {toolCall.title && toolCall.title !== toolCall.name && (
            <div className="ai-chat-tool-detail-label">{toolCall.name}</div>
          )}
          {toolCall.rawInput && (
            <pre className="ai-chat-tool-call-args">
              <code>{toolCall.rawInput}</code>
            </pre>
          )}
          {!toolCall.rawInput && hasDisplayableArgs(toolCall.args) && (
            <pre className="ai-chat-tool-call-args">
              <code>{JSON.stringify(toolCall.args, null, 2)}</code>
            </pre>
          )}
          {toolCall.resultSummary && (
            <pre className="ai-chat-tool-call-result">
              <code>{toolCall.resultSummary}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function hasDisplayableArgs(args: unknown) {
  if (args == null) return false
  if (typeof args !== 'object') return true
  if (Array.isArray(args)) return args.length > 0
  return Object.keys(args).length > 0
}

function DiffCode({
  existingContent,
  newContent,
}: {
  existingContent: string
  newContent: string
}) {
  const parts = useMemo(
    () => diffWordsWithSpace(existingContent, newContent),
    [existingContent, newContent]
  )

  return (
    <code className="workbench-code-diff-code ai-chat-code-diff-code">
      <del>
        {parts.map((part, index) => {
          if (part.added) return null
          return (
            <span
              key={`old-${index}`}
              className={part.removed ? 'ai-chat-diff-token-removed' : undefined}
            >
              {part.value}
            </span>
          )
        })}
      </del>
      <ins>
        {parts.map((part, index) => {
          if (part.removed) return null
          return (
            <span
              key={`new-${index}`}
              className={part.added ? 'ai-chat-diff-token-added' : undefined}
            >
              {part.value}
            </span>
          )
        })}
      </ins>
    </code>
  )
}

function EditProposalCard({
  messageId,
  proposal,
}: {
  messageId: string
  proposal: NonNullable<AiChatMessage['editProposal']>
}) {
  const { applyEditProposal } = useAiChatContext()
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) {
    return null
  }

  return (
    <div className="tool-content tool-use collapse show ai-chat-edit-tool-content">
      <div className="workbench-code-suggestion ai-chat-edit-proposal">
        {proposal.rationale && (
          <p className="ai-chat-edit-proposal-rationale">{proposal.rationale}</p>
        )}
        {!collapsed && (
          <>
            <div className="workbench-code-diff ai-chat-code-diff">
              <div className="workbench-code-diff-line-number ai-chat-code-diff-line-number">
                <button type="button" className="btn btn-link btn-sm" disabled>
                  {proposal.fromLine}
                </button>
              </div>
              <DiffCode
                existingContent={proposal.existingContent}
                newContent={proposal.newContent}
              />
            </div>
            {proposal.path && (
              <div className="ai-chat-edit-proposal-lines">
                {proposal.path}
                {' · '}
                {`Lines ${proposal.fromLine}-${proposal.toLine}`}
              </div>
            )}
          </>
        )}
        <div className="d-flex justify-content-between align-items-center gap-2 workbench-code-diff-actions ai-chat-edit-actions">
          <div className="d-flex align-items-center gap-2">
            <button
              type="button"
              data-ol-loading="false"
              className="d-inline-grid btn btn-ghost btn-sm"
              onClick={() => setCollapsed(value => !value)}
            >
              <span className="button-content" aria-hidden="false">
                {collapsed ? 'Show changes' : 'Hide changes'}
              </span>
            </button>
          </div>
          <div className="d-flex align-items-center gap-2">
            <button
              type="button"
              data-ol-loading="false"
              className="d-inline-grid btn btn-secondary btn-sm"
              disabled={proposal.status === 'applying' || proposal.status === 'applied'}
              onClick={() => setDismissed(true)}
            >
              <span className="button-content" aria-hidden="false">不要</span>
            </button>
            <button
              type="button"
              data-ol-loading="false"
              className="d-inline-grid btn btn-secondary btn-sm"
              disabled={proposal.status === 'applying' || proposal.status === 'applied'}
              onClick={() => void applyEditProposal(messageId)}
            >
              <span className="button-content" aria-hidden="false">
                {proposal.status === 'applied'
                  ? 'Applied'
                  : proposal.status === 'applying'
                    ? 'Applying...'
                    : 'Apply '}
                {proposal.status !== 'applied' && proposal.status !== 'applying' && (
                  <MaterialIcon type="arrow_right_alt" />
                )}
              </span>
            </button>
          </div>
        </div>
        {proposal.error && (
          <div className="ai-chat-edit-error">{proposal.error}</div>
        )}
      </div>
    </div>
  )
}

function ContextBadges({
  ctx,
}: {
  ctx: NonNullable<AiChatMessage['editorContext']>
}) {
  const hasBadge = ctx.fileName || ctx.selectionRange
  if (!hasBadge) return null

  return (
    <div className="ai-chat-context-badges">
      {ctx.fileName && (
        <span className="ai-chat-badge">
          <MaterialIcon type="description" />
          {ctx.fileName}
        </span>
      )}
      {ctx.selectionRange && (
        <span className="ai-chat-badge ai-chat-badge-selection">
          <MaterialIcon type="rate_review" />
          {`Lines ${ctx.selectionRange.startLine}-${ctx.selectionRange.endLine}`}
        </span>
      )}
    </div>
  )
}

export default AiChatMessageList
