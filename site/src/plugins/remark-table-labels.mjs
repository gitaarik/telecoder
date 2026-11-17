// On a phone the docs tables stack: each row becomes a little card, its first
// cell the title and the rest underneath (src/styles/theme.css). Stacked, a
// cell loses its column header, so this copies the header onto the cell as
// `data-label`, which the CSS prints in front of it ("Default: —").
//
// Two-column tables need no labels: the second column is always the
// explanation of the first. Nor does a column headed "Description".
import { visit } from 'unist-util-visit';

const text = (node) =>
  'value' in node ? node.value : (node.children ?? []).map(text).join('');

export default function remarkTableLabels() {
  return (tree) => {
    visit(tree, 'table', (table) => {
      const [head, ...rows] = table.children;
      if (!head || head.children.length < 3) return;
      const labels = head.children.map((cell) => text(cell).trim());
      for (const row of rows) {
        row.children.forEach((cell, i) => {
          const label = labels[i];
          if (i === 0 || !label || /^description$/i.test(label)) return;
          cell.data = { ...cell.data, hProperties: { ...cell.data?.hProperties, dataLabel: label } };
        });
      }
    });
  };
}
