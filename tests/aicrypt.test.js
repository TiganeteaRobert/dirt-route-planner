import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptBundle, gunzipJson, WrongPassphrase } from '../core/aicrypt.js';
import { makeBundle, TEST_PASS } from './fixtures/aibundle.mjs';
import { loadGraph } from '../core/routing.js';

test('the AI bundle opens with its passphrase, whatever the case and spaces', async () => {
  const buf = makeBundle();
  const { meta, graphGz, tiles } = await decryptBundle(buf, `  ${TEST_PASS.toUpperCase()} `);
  assert.equal(meta.v, 2);
  assert.equal(meta.stats.lines, 2);
  assert.equal(String.fromCharCode(...tiles.subarray(0, 7)), 'PMTiles');
  const graph = await gunzipJson(graphGz);
  assert.equal(graph.classes[13], 'ai');
  const G = loadGraph(graph);
  assert.equal(G.classes[G.e.cls[2]], 'ai');
});

test('a wrong passphrase or a foreign file is refused', async () => {
  const buf = makeBundle();
  await assert.rejects(decryptBundle(buf, 'nope'), WrongPassphrase);
  await assert.rejects(decryptBundle(new Uint8Array(100), TEST_PASS), /not a DirtScout AI file/);
});

test('the AI sensitivity drops only the AI edges the model is less sure of', async () => {
  const { filterAiEdges } = await import('../core/usergraph.js');
  const g = await gunzipJson((await decryptBundle(makeBundle(), TEST_PASS)).graphGz);
  const aiCount = (json, cls = 'ai') => json.edges.cls.filter((c) => json.classes[c] === cls).length;
  assert.equal(aiCount(filterAiEdges(g, 0.3)), 2);
  assert.equal(aiCount(filterAiEdges(g, 0.5)), 1);
  assert.equal(aiCount(filterAiEdges(g, 0.9)), 0);
  assert.equal(aiCount(filterAiEdges(g, 0.3), 'gap'), 1);           // a gap goes with the tracks it joins
  assert.equal(aiCount(filterAiEdges(g, 0.5), 'gap'), 0);
  const f = filterAiEdges(g, 0.9);
  assert.equal(f.edges.a.length, 2);
  assert.equal(f.ids.length, 2);
  assert.equal(f.geom.length, 2);
  assert.equal(filterAiEdges(g, 0.3), g);                  // nothing left out: the same object
});
