import { get, route } from 'remix/routes'

export const routes = route({
  assets: get('/assets/*path'),
  home: get('/'),
  events: get('/events'),
  vendor: get('/vendor/*path'),
})

/** Development-only pages, mapped by the router when `NODE_ENV` is `development` (unpackaged app). */
export const devRoutes = route({
  editor: get('/dev/editor'),
})
