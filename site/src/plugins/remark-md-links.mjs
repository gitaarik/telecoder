// The docs are plain .md files that link to each other by relative path
// (`../guides/sharing.md#group-roles`), so they also read fine on GitHub.
// On the site those links need to be routes (`/guides/sharing/#group-roles`).
import path from 'node:path';
import { visit } from 'unist-util-visit';

const CONTENT_ROOT = path.resolve('src/content/docs');

export default function remarkMdLinks() {
  return (tree, file) => {
    const source = file.history[0];
    if (!source || !source.startsWith(CONTENT_ROOT)) return;
    visit(tree, ['link', 'definition'], (node) => {
      const match = /^([^:#?]+)\.mdx?(#.*)?$/.exec(node.url);
      if (!match) return;
      const target = path.relative(CONTENT_ROOT, path.resolve(path.dirname(source), match[1]));
      const slug = target.replace(/(^|\/)index$/, '').toLowerCase();
      node.url = `/${slug}${slug ? '/' : ''}${match[2] ?? ''}`;
    });
  };
}
