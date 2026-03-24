import { useMemo } from 'react'
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

type AiChatMarkdownProps = {
  content: string
}

function stripHiddenReasoning(content: string) {
  return content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/&lt;think&gt;[\s\S]*?(?:&lt;\/think&gt;|$)/gi, '')
    .trim()
}

export default function AiChatMarkdown({ content }: AiChatMarkdownProps) {
  const html = useMemo(() => {
    const cleanContent = stripHiddenReasoning(content)
    const rendered = marked.parse(cleanContent, {
      breaks: true,
      gfm: true,
    })

    return sanitizeHtml(rendered, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([
        'img',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'pre',
        'code',
      ]),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        a: ['href', 'name', 'target', 'rel'],
        code: ['class'],
      },
      transformTags: {
        a: sanitizeHtml.simpleTransform('a', {
          target: '_blank',
          rel: 'noreferrer noopener',
        }),
      },
    })
  }, [content])

  if (!html) {
    return null
  }

  return (
    <div
      className="ai-chat-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
