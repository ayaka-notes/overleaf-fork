import AiChatRouter from './app/src/AiChatRouter.mjs'
import McpRouter from './app/src/McpRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const AiChatModule = {
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      AiChatRouter.apply(webRouter, privateApiRouter, publicApiRouter)
      McpRouter.apply(webRouter, privateApiRouter, publicApiRouter)
    },
  },
}

export default AiChatModule
