// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import remarkMdLinks from './src/plugins/remark-md-links.mjs';
import remarkTableLabels from './src/plugins/remark-table-labels.mjs';

export default defineConfig({
  site: 'https://telecoder.dev',
  markdown: { processor: unified({ remarkPlugins: [remarkMdLinks, remarkTableLabels] }) },
  integrations: [
    starlight({
      title: 'TeleCoder',
      description:
        'Claude Code in Telegram. The real agent runs on your machine; you drive it from Telegram’s native apps.',
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/telecoderbot/telecoder' }],
      editLink: { baseUrl: 'https://github.com/telecoderbot/telecoder/edit/main/site/' },
      lastUpdated: true,
      customCss: ['./src/styles/theme.css'],
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap',
          },
        },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://telecoder.dev/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }, 'compare'] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Help', items: [{ autogenerate: { directory: 'help' } }] },
        {
          label: 'Project',
          items: [
            { label: 'Changelog', link: '/changelog/' },
            'about',
            { label: 'Roadmap', link: 'https://github.com/telecoderbot/telecoder/blob/main/ROADMAP.md' },
            { label: 'Contributing', link: 'https://github.com/telecoderbot/telecoder/blob/main/CONTRIBUTING.md' },
          ],
        },
      ],
    }),
  ],
});
