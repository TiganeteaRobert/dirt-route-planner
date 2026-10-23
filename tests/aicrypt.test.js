import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptBundle, WrongPassphrase } from '../core/aicrypt.js';
import { makeBundle, TEST_PASS } from './fixtures/aibundle.mjs';
import { loadGraph } from '../core/routing.js';

test('the AI bundle opens with its passphrase, whatever the case and spaces', async () => {
  const buf = makeBundle();
  const { data } = await decryptBundle(buf, `  ${TEST_PASS.toUpperCase()} `);
  assert.equal(data.v, 1);
  assert.equal(data.ai.features.length, 2);
  assert.equal(data.graph.classes[13], 'ai');
  const G = loadGraph(data.graph);
  assert.equal(G.classes[G.e.cls[2]], 'ai');
});

test('a wrong passphrase or a foreign file is refused', async () => {
  const buf = makeBundle();
  await assert.rejects(decryptBundle(buf, 'nope'), WrongPassphrase);
  await assert.rejects(decryptBundle(new Uint8Array(100), TEST_PASS), /not a DirtScout AI file/);
});
