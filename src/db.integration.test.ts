import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import {
  initializeDatabase,
  loadDemoState,
  saveRound,
  setMemberOptOut,
  updateDemoConfig
} from './db.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://fika:fika@localhost:5432/fika'
});

test('persists demo state and idempotent rounds in PostgreSQL', async (context) => {
  try {
    await pool.query('SELECT 1');
  } catch {
    context.skip('PostgreSQL is not available');
    return;
  }

  await initializeDatabase();
  await pool.query('DELETE FROM rounds WHERE group_id = $1', ['demo']);
  await pool.query('DELETE FROM pair_history WHERE group_id = $1', ['demo']);
  await pool.query('UPDATE members SET opted_out = FALSE WHERE group_id = $1', ['demo']);
  await pool.query(
    'UPDATE groups SET group_size = $1, reset_threshold_percent = $2 WHERE id = $3',
    [2, 15, 'demo']
  );

  const optedOut = await setMemberOptOut('jordan', true);
  assert.equal(optedOut?.optedOut, true);

  const updatedConfig = await updateDemoConfig({ groupSize: 3, resetThresholdPercent: 25 });
  assert.deepEqual(updatedConfig, { groupSize: 3, resetThresholdPercent: 25 });

  const generationKey = `integration-${Date.now()}`;
  const history = new Set(['jordan:maya']);
  const result = {
    matches: [{ participantIds: ['jordan', 'maya', 'theo'] }],
    resetPerformed: false
  };
  const notifications = [{
    recipientEmails: ['jordan@example.com', 'maya@example.com', 'theo@example.com'],
    subject: 'Test notification',
    body: 'Test body'
  }];

  assert.equal(await saveRound(generationKey, result, history, notifications), true);
  assert.equal(await saveRound(generationKey, result, history, notifications), false);

  const state = await loadDemoState();
  assert.equal(state.members.find((member) => member.id === 'jordan')?.optedOut, true);
  assert.deepEqual(state.config, updatedConfig);
  assert.equal(state.history.has('jordan:maya'), true);

  const counts = await pool.query<{ rounds: string; matches: string; participants: string; notifications: string }>(
    `SELECT
       (SELECT COUNT(*) FROM rounds WHERE group_id = $1 AND generation_key = $2) AS rounds,
       (SELECT COUNT(*) FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE group_id = $1 AND generation_key = $2)) AS matches,
       (SELECT COUNT(*) FROM match_participants WHERE match_id IN (SELECT id FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE group_id = $1 AND generation_key = $2))) AS participants,
       (SELECT COUNT(*) FROM notification_outbox WHERE round_id IN (SELECT id FROM rounds WHERE group_id = $1 AND generation_key = $2)) AS notifications`,
    ['demo', generationKey]
  );
  assert.deepEqual(counts.rows[0], { rounds: '1', matches: '1', participants: '3', notifications: '1' });
});

test.after(async () => {
  await pool.query('DELETE FROM rounds WHERE group_id = $1', ['demo']);
  await pool.query('DELETE FROM pair_history WHERE group_id = $1', ['demo']);
  await pool.query('UPDATE members SET opted_out = FALSE WHERE group_id = $1', ['demo']);
  await pool.query(
    'UPDATE groups SET group_size = $1, reset_threshold_percent = $2 WHERE id = $3',
    [2, 15, 'demo']
  );
  await pool.end();
});
