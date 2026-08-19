import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMatches, pairKey, type Member } from './matching.js';

const members: Member[] = [
  { id: 'a', email: 'a@example.com', name: 'A', optedOut: false },
  { id: 'b', email: 'b@example.com', name: 'B', optedOut: false },
  { id: 'c', email: 'c@example.com', name: 'C', optedOut: false },
  { id: 'd', email: 'd@example.com', name: 'D', optedOut: false }
];

test('excludes opted-out members from a generated round', () => {
  const result = generateMatches([{ ...members[0], optedOut: true }, ...members.slice(1)], new Set(), { groupSize: 2, resetThresholdPercent: 15 });
  assert.equal(result.activeMemberCount, 3);
  assert.equal(result.matches.flatMap((match) => match.participantIds).includes('a'), false);
});

test('does not repeat a pair while a fresh pairing exists', () => {
  const history = new Set([pairKey('a', 'b')]);
  const result = generateMatches(members, history, { groupSize: 2, resetThresholdPercent: 15 });
  assert.equal(result.resetPerformed, false);
  assert.equal(result.matches.some((match) => match.participantIds.includes('a') && match.participantIds.includes('b')), false);
});

test('resets history when the configured exhausted-member threshold is reached', () => {
  const history = new Set([pairKey('a', 'b'), pairKey('a', 'c'), pairKey('a', 'd')]);
  const result = generateMatches(members, history, { groupSize: 2, resetThresholdPercent: 25 });
  assert.equal(result.resetPerformed, true);
  assert.equal(history.has(pairKey('a', 'b')), true);
});
