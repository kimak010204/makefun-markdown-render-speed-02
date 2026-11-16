// Driver for the markdown-render-speed-02 entry.
//
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (a JSON array of
// {"id", "markdown"}), renders each one with parse() from ./parse.js, and
// writes $MAKEFUN_OUTPUT_DIR/html.json (a JSON array of the HTML strings,
// in the cases' order).
//
// Runs on Node 22, which strips TypeScript types natively, so this file
// uses erasable syntax only: no enums, no parameter properties, no
// namespaces. Only Node built-ins are used; there is no network access
// and no other input, so the output is fully deterministic.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
