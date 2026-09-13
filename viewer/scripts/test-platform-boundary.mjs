import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../app/germany-station-map.tsx', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('const distance ='), source.indexOf('type OfficialImageryConfig'));
const compiled = ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('exports', compiled)(module.exports);
const boundary = module.exports.platformLongAxis;
const polygon = [
  { lat: 50.3051073, lon: 8.811868 },
  { lat: 50.3044965, lon: 8.8139365 },
  { lat: 50.3044717, lon: 8.8139188 },
  { lat: 50.3048661, lon: 8.8125835 },
  { lat: 50.3050827, lon: 8.81185 },
  { lat: 50.3051073, lon: 8.811868 },
];
const rail = [polygon[0], polygon[1]].map((point) => ({ lat: point.lat + 0.00003, lon: point.lon + 0.00002 }));
assert.deepEqual(boundary(polygon, [rail]), [polygon[0], polygon[1]]);
assert.deepEqual(boundary(polygon, [polygon.slice(2, 5)]), polygon.slice(2, 5));
const openEdge = polygon.slice(0, 3);
assert.deepEqual(boundary(openEdge, [rail]), openEdge);
console.log('Assenheim: track-facing boundary endpoints and open-edge preservation passed.');
