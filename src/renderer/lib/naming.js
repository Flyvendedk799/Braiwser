// How the side panels name a piece of a page. Shared by Sections and Layers so
// the same element reads the same way in both, and so a row says "Hero" or
// "Pricing table" where a devtools tree would say "div.x7a".

const SEMANTIC = {
  header: 'Header',
  nav: 'Navigation',
  main: 'Main',
  footer: 'Footer',
  aside: 'Sidebar',
  section: 'Section',
  article: 'Article',
  form: 'Form',
  figure: 'Figure',
  figcaption: 'Caption',
  ul: 'List',
  ol: 'List',
  li: 'List item',
  table: 'Table',
  video: 'Video',
  audio: 'Audio',
  img: 'Image',
  picture: 'Image',
  svg: 'Graphic',
  canvas: 'Canvas',
  button: 'Button',
  a: 'Link',
  input: 'Field',
  textarea: 'Field',
  select: 'Select',
  label: 'Label',
  p: 'Text',
  blockquote: 'Quote',
  pre: 'Code',
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
};

export const ICON_FOR = {
  header: 'layers',
  nav: 'layers',
  main: 'layers',
  footer: 'layers',
  section: 'layers',
  aside: 'layers',
  article: 'file',
  ul: 'file',
  ol: 'file',
  table: 'file',
  form: 'edit',
  input: 'edit',
  textarea: 'edit',
  img: 'camera',
  picture: 'camera',
  video: 'camera',
  button: 'inspect',
  a: 'locate',
};

// Landmarks read better by their role than by the heading that happens to sit
// inside them: <main> is "Main", not "Let's build something together".
const LANDMARK = /^(header|nav|main|footer|aside)$/;

// "hero-banner" / "heroBanner" / "hero_banner" -> "Hero banner"
export function prettify(raw) {
  const words = String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_./]+/g, ' ')
    .trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

// What to call this node — what a person would recognise on the page.
export function displayName(node) {
  if (!node) return '';
  const tag = node.tag || 'div';
  if (LANDMARK.test(tag)) {
    if (node.label) return node.label;
    // An id only wins when it says something the tag doesn't (#hero, not #main).
    const fromId = node.id ? prettify(node.id) : '';
    if (fromId && fromId.toLowerCase() !== SEMANTIC[tag].toLowerCase() && fromId.toLowerCase() !== tag) return fromId;
    return SEMANTIC[tag];
  }
  if (node.heading) return node.heading;
  if (node.label) return node.label;
  // Interactive leaves are known by their words, not by their id.
  const own = (node.text || '').trim();
  if (own && /^(button|a|summary|label|option|legend)$/.test(tag)) {
    return own.length > 42 ? own.slice(0, 42) + '…' : own;
  }
  if (node.id) return prettify(node.id);
  if (SEMANTIC[tag] && tag !== 'p' && tag !== 'li' && tag !== 'a' && tag !== 'button') return SEMANTIC[tag];
  const text = (node.text || '').trim();
  if (text) return text.length > 42 ? text.slice(0, 42) + '…' : text;
  if (node.classes && node.classes.length) {
    const useful = node.classes.find((c) => c.length > 2 && !/^(is|has|js)-/.test(c));
    if (useful) return prettify(useful);
  }
  return SEMANTIC[tag] || '<' + tag + '>';
}

// The same name, clipped for places with no room for a sentence — a
// breadcrumb full of "Styr læring, mennesker og indsigt i én flade." is worse
// than useless.
export function shortName(node, max = 16) {
  const full = displayName(node);
  if (full.length <= max) return full;
  const cut = full.slice(0, max).replace(/[\s,.;:–—-]+$/, '');
  return (cut || full.slice(0, max)) + '…';
}

// The precise thing, for the people who want it: tag#id.class
export function selectorLabel(node) {
  if (!node) return '';
  let s = node.tag || '';
  if (node.id) s += '#' + node.id;
  else if (node.classes && node.classes.length) s += '.' + node.classes[0];
  return s;
}
