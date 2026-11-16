// Driver for the markdown-render-speed-02 entry: read every case from
// /input/cases.json (or MAKEFUN_INPUT_DIR), render each one alone with the
// fast parse() from parse.js, and write /output/html.json (or
// MAKEFUN_OUTPUT_DIR) as a JSON array of the HTML strings, in order.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  markdown: string;
}[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  // Each case is rendered alone: parse() keeps no state between calls,
  // so no result can leak from one case into the next.
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
