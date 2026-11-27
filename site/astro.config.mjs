// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLinksValidator from 'starlight-links-validator'

const repository = 'https://github.com/adrianbrowning/BoostNote'

export default defineConfig({
  // A GitHub Pages project site: https://adrianbrowning.github.io/BoostNote/
  site: 'https://adrianbrowning.github.io',
  base: '/BoostNote',
  integrations: [
    starlight({
      title: 'Boostnote',
      description: 'The Boostnote user guide: what you can do, and how to do it.',
      logo: { src: './src/assets/logo.png' },
      favicon: '/favicon.ico',
      social: [{ icon: 'github', label: 'GitHub', href: repository }],
      editLink: { baseUrl: `${repository}/edit/master/site/` },
      // A link to a page or heading that does not exist fails the build.
      plugins: [starlightLinksValidator()],
      sidebar: [
        { label: 'Start here', items: ['get-started'] },
        {
          label: 'Guides',
          items: [
            'guides/write-notes',
            'guides/organise-notes',
            'guides/find-notes',
            'guides/tabs',
            'guides/quick-capture',
            'guides/share-and-export',
            'guides/bring-notes-in',
            'guides/customise',
            'guides/terminal-and-ai',
          ],
        },
        { label: 'Reference', items: ['reference/shortcuts'] },
      ],
    }),
  ],
  // The shortcuts page reads the app's command table from ../src/shared at build time.
  vite: { server: { fs: { allow: ['..'] } } },
})
