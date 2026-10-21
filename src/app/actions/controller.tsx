import { createController } from 'remix/router'

import { eventHub } from '../../main/events.ts'
import { assets } from '../assets.ts'
import { routes } from '../routes.ts'
import { serveVendorFile } from '../vendor.ts'
import { HomePage } from './home-page.tsx'

export default createController(routes, {
  actions: {
    async assets(context) {
      return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
    },
    home(context) {
      return context.render(<HomePage />)
    },
    events(context) {
      return eventHub.subscribe(context.request.signal)
    },
    vendor(context) {
      return serveVendorFile(context.request, context.params.path)
    },
  },
})
