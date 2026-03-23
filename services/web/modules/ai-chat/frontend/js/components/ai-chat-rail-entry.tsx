import { lazy, Suspense } from 'react'
import type { RailElement } from '@/features/ide-react/util/rail-types'

const AiChatPane = lazy(
  () => import(/* webpackChunkName: "ai-chat-pane" */ './ai-chat-pane')
)

const aiChatRailEntry: RailElement = {
  key: 'ai-chat' as const,
  icon: 'smart_toy',
  title: 'AI Chat',
  component: (
    <Suspense fallback={null}>
      <AiChatPane />
    </Suspense>
  ),
}

export default aiChatRailEntry
