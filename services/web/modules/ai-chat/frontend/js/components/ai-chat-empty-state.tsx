import MaterialIcon from '@/shared/components/material-icon'

type Suggestion = {
  icon: string
  text: string
}

const START_CHAT_SUGGESTIONS: Suggestion[] = [
  { icon: 'prompt_suggestion', text: 'What can the assistant do for me?' },
  { icon: 'prompt_suggestion', text: 'Create a Beamer presentation' },
  { icon: 'prompt_suggestion', text: 'Insert a bullet list' },
  { icon: 'prompt_suggestion', text: 'Insert a figure' },
]

type AiChatEmptyStateProps = {
  onSelectPrompt: (text: string) => void
}

function AiChatEmptyState({ onSelectPrompt }: AiChatEmptyStateProps) {
  return (
    <div className="ai-chat-empty-state-v2">
      <div className="ai-chat-empty-section">
        <div className="ai-chat-empty-section-header">Start a chat</div>
        <ul className="ai-chat-empty-action-list">
          {START_CHAT_SUGGESTIONS.map(({ icon, text }) => (
            <li key={text}>
              <button
                className="ai-chat-empty-action-item"
                onClick={() => onSelectPrompt(text)}
                type="button"
              >
                <MaterialIcon
                  type={icon}
                  className="ai-chat-empty-action-icon"
                />
                <div className="ai-chat-empty-action-content">
                  <span className="ai-chat-empty-action-text">{text}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default AiChatEmptyState
