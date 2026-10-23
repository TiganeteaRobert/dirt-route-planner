import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEdge } from '../core/scoring.js';

test('a detected, travelled forest track with good grade is green', () => {
  const s = scoreEdge({ class: 'track', tt: 2, det: 0.9, tp: 40, tn: 4, len: 800, tree: 0.6, g100: 12, ver: 3 });
  assert.equal(s.name, 'green');
  assert.ok(s.exists >= 0.75);
});

test('an unseen, untravelled path is red (may not exist)', () => {
  const s = scoreEdge({ class: 'path', det: 0, tp: 0, tn: 0, len: 500, tree: 0.9, g100: 15 });
  assert.equal(s.name, 'red');
  assert.ok(s.exists < 0.5);
});

test('hiking scale T3 is red even when it exists', () => {
  const s = scoreEdge({ class: 'path', sac: 'demanding_mountain_hiking', det: 0.9, tp: 100, tn: 5, len: 300, routes: 'mtb' });
  assert.equal(s.name, 'red');
  assert.equal(s.level, 2);
});

test('steep path in deep forest is red; a steep road is only yellow', () => {
  assert.equal(scoreEdge({ class: 'path', tree: 0.85, g100: 22, det: 0.8, tn: 3, tp: 30, len: 200 }).name, 'red');
  assert.equal(scoreEdge({ class: 'tertiary', g100: 28, det: 1 }).name, 'yellow');
});

test('motor access no is a legal flag, not a colour', () => {
  const s = scoreEdge({ class: 'track', acc: 'no', det: 0.9, tn: 3, tp: 10, len: 300 });
  assert.equal(s.legal, 'no');
  assert.ok(s.reasons.some((r) => r.code === 'access'));
});

test('TET overlap lifts existence', () => {
  const p = { class: 'track', det: 0.1, tp: 0, len: 1000 };
  assert.ok(scoreEdge(p, { tet: 0.9 }).exists > scoreEdge(p).exists + 0.25);
});

test('an AI-found track: more sure = more likely, a legal note, no Microsoft bonus', () => {
  const sure = scoreEdge({ class: 'ai', aic: 0.9, det: 0.9, tp: 0, len: 400 });
  const unsure = scoreEdge({ class: 'ai', aic: 0.3, det: 0, tp: 0, len: 400 });
  assert.ok(sure.exists > unsure.exists);
  assert.equal(unsure.name, 'red');
  assert.ok(sure.reasons.some((r) => r.code === 'unknown' && r.d === 'legal'));
  assert.ok(!sure.reasons.some((r) => r.code === 'det'));
  assert.ok(scoreEdge({ class: 'ai', aic: 0.8, tp: 30, tn: 3, len: 400 }).exists >= 0.75);   // ridden: traces lift it
});
