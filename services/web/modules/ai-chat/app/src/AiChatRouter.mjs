import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import AiChatController from './AiChatController.mjs'

export default {
  apply(webRouter) {
    logger.debug({}, 'Init AiChat router')

    webRouter.post(
      '/api/project/:Project_id/ai-chat',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiChatController.streamChat
    )
  },
}
