import { createController } from 'remix/router'

import { devRoutes } from '../../routes.ts'
import { EditorDemoPage } from './editor-demo-page.tsx'

/** Development-only pages; `router.ts` maps them only when the app is not packaged. */
export default createController(devRoutes, {
  actions: {
    editor(context) {
      return context.render(<EditorDemoPage />)
    },
  },
})
