import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import type { MatchConfig, Member, Match } from './matching.js';
import type { MatchNotification } from './mail.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://fika:fika@localhost:5432/fika'
});

export type DemoState = {
  members: Member[];
  config: MatchConfig;
  history: Set<string>;
};

export type ThemeConfig = {
  logoText: string;
  brandName: string;
  pageTitle: string;
  tagline: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  paperColor: string;
  inkColor: string;
  colorMode: 'light' | 'dark';
};

export type ClaimedNotification = MatchNotification & {
  id: string;
  attempts: number;
};

export async function initializeDatabase(): Promise<void> {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
}

export async function loadDemoState(): Promise<DemoState> {
  const groupResult = await pool.query<{ group_size: 2 | 3 | 4; reset_threshold_percent: string }>(
    'SELECT group_size, reset_threshold_percent FROM groups WHERE id = $1',
    ['demo']
  );
  const memberResult = await pool.query<Member>(
    'SELECT id, email, name, opted_out AS "optedOut" FROM members WHERE group_id = $1 ORDER BY id',
    ['demo']
  );
  const historyResult = await pool.query<{ left_member_id: string; right_member_id: string }>(
    'SELECT left_member_id, right_member_id FROM pair_history WHERE group_id = $1',
    ['demo']
  );
  const group = groupResult.rows[0];
  if (!group) throw new Error('Demo group was not initialized');

  return {
    members: memberResult.rows,
    config: {
      groupSize: group.group_size,
      resetThresholdPercent: Number(group.reset_threshold_percent)
    },
    history: new Set(historyResult.rows.map(({ left_member_id, right_member_id }) => `${left_member_id}:${right_member_id}`))
  };
}

export async function setMemberOptOut(memberId: string, optedOut: boolean): Promise<Member | undefined> {
  const result = await pool.query<Member>(
    'UPDATE members SET opted_out = $1 WHERE group_id = $2 AND id = $3 RETURNING id, email, name, opted_out AS "optedOut"',
    [optedOut, 'demo', memberId]
  );
  return result.rows[0];
}

export async function updateDemoConfig(config: Partial<MatchConfig>): Promise<MatchConfig> {
  const result = await pool.query<{ group_size: 2 | 3 | 4; reset_threshold_percent: string }>(
    `UPDATE groups
     SET group_size = COALESCE($1, group_size),
         reset_threshold_percent = COALESCE($2, reset_threshold_percent)
     WHERE id = $3
     RETURNING group_size, reset_threshold_percent`,
    [config.groupSize ?? null, config.resetThresholdPercent ?? null, 'demo']
  );
  const group = result.rows[0];
  if (!group) throw new Error('Demo group was not initialized');
  return { groupSize: group.group_size, resetThresholdPercent: Number(group.reset_threshold_percent) };
}

export async function loadTheme(): Promise<ThemeConfig> {
  const result = await pool.query<{
    logo_text: string;
    brand_name: string;
    page_title: string;
    tagline: string;
    primary_color: string;
    secondary_color: string;
    accent_color: string;
    paper_color: string;
    ink_color: string;
    color_mode: 'light' | 'dark';
  }>('SELECT logo_text, brand_name, page_title, tagline, primary_color, secondary_color, accent_color, paper_color, ink_color, color_mode FROM app_theme WHERE id = 1');
  const theme = result.rows[0];
  if (!theme) throw new Error('App theme was not initialized');
  return toThemeConfig(theme);
}

export async function updateTheme(theme: ThemeConfig): Promise<ThemeConfig> {
  const result = await pool.query<{
    logo_text: string;
    brand_name: string;
    page_title: string;
    tagline: string;
    primary_color: string;
    secondary_color: string;
    accent_color: string;
    paper_color: string;
    ink_color: string;
    color_mode: 'light' | 'dark';
  }>(
    `UPDATE app_theme
     SET logo_text = $1, brand_name = $2, page_title = $3, tagline = $4,
         primary_color = $5, secondary_color = $6, accent_color = $7,
         paper_color = $8, ink_color = $9, color_mode = $10, updated_at = NOW()
     WHERE id = 1
       RETURNING logo_text, brand_name, page_title, tagline, primary_color, secondary_color, accent_color, paper_color, ink_color, color_mode`,
      [theme.logoText, theme.brandName, theme.pageTitle, theme.tagline, theme.primaryColor, theme.secondaryColor, theme.accentColor, theme.paperColor, theme.inkColor, theme.colorMode]
  );
  const updatedTheme = result.rows[0];
  if (!updatedTheme) throw new Error('App theme was not initialized');
  return toThemeConfig(updatedTheme);
}

function toThemeConfig(theme: {
  logo_text: string;
  brand_name: string;
  page_title: string;
  tagline: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  paper_color: string;
  ink_color: string;
  color_mode: 'light' | 'dark';
}): ThemeConfig {
  return {
    logoText: theme.logo_text,
    brandName: theme.brand_name,
    pageTitle: theme.page_title,
    tagline: theme.tagline,
    primaryColor: theme.primary_color,
    secondaryColor: theme.secondary_color,
    accentColor: theme.accent_color,
    paperColor: theme.paper_color,
    inkColor: theme.ink_color,
    colorMode: theme.color_mode
  };
}

export async function saveRound(
  generationKey: string,
  result: { matches: Match[]; resetPerformed: boolean },
  history: Set<string>,
  notifications: MatchNotification[] = []
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roundResult = await client.query<{ id: string }>(
      `INSERT INTO rounds (group_id, generation_key, reset_performed)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, generation_key) DO NOTHING
       RETURNING id`,
      ['demo', generationKey, result.resetPerformed]
    );
    const round = roundResult.rows[0];
    if (!round) {
      await client.query('ROLLBACK');
      return false;
    }

    if (result.resetPerformed) {
      await client.query('DELETE FROM pair_history WHERE group_id = $1', ['demo']);
    }
    for (const match of result.matches) {
      const matchResult = await client.query<{ id: string }>('INSERT INTO matches (round_id) VALUES ($1) RETURNING id', [round.id]);
      for (const memberId of match.participantIds) {
        await client.query('INSERT INTO match_participants (match_id, member_id) VALUES ($1, $2)', [matchResult.rows[0].id, memberId]);
      }
    }
    await saveHistory(client, history);
    await saveNotifications(client, round.id, notifications);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function saveNotifications(client: PoolClient, roundId: string, notifications: MatchNotification[]): Promise<void> {
  if (notifications.length === 0) return;
  const values: unknown[] = [];
  const placeholders = notifications.map((notification, index) => {
    const offset = index * 4;
    values.push(roundId, notification.recipientEmails, notification.subject, notification.body);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
  });
  await client.query(
    `INSERT INTO notification_outbox (round_id, recipient_emails, subject, body)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

async function saveHistory(client: PoolClient, history: Set<string>): Promise<void> {
  for (const key of history) {
    const [leftMemberId, rightMemberId] = key.split(':');
    await client.query(
      `INSERT INTO pair_history (group_id, left_member_id, right_member_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, left_member_id, right_member_id) DO NOTHING`,
      ['demo', leftMemberId, rightMemberId]
    );
  }
}

export async function claimNotification(): Promise<ClaimedNotification | undefined> {
  const result = await pool.query<ClaimedNotification>(
    `WITH candidate AS (
       SELECT id
       FROM notification_outbox
       WHERE (status = 'pending' OR (status = 'processing' AND locked_until < NOW()))
         AND available_at <= NOW()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE notification_outbox AS outbox
     SET status = 'processing',
         attempts = outbox.attempts + 1,
         locked_until = NOW() + INTERVAL '1 minute'
     FROM candidate
     WHERE outbox.id = candidate.id
     RETURNING outbox.id, outbox.recipient_emails AS "recipientEmails", outbox.subject,
               outbox.body, outbox.attempts` 
  );
  return result.rows[0];
}

export async function markNotificationSent(id: string): Promise<void> {
  await pool.query(
    `UPDATE notification_outbox
     SET status = 'sent', sent_at = NOW(), locked_until = NULL, last_error = NULL
     WHERE id = $1 AND status = 'processing'`,
    [id]
  );
}

export async function markNotificationFailed(id: string, attempts: number, error: string, maxAttempts = 5): Promise<void> {
  const permanentlyFailed = attempts >= maxAttempts;
  const retryDelaySeconds = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
  await pool.query(
    `UPDATE notification_outbox
     SET status = $2,
         available_at = CASE WHEN $2 = 'pending' THEN NOW() + ($3 * INTERVAL '1 second') ELSE available_at END,
         locked_until = NULL,
         last_error = $4
     WHERE id = $1 AND status = 'processing'`,
    [id, permanentlyFailed ? 'failed' : 'pending', retryDelaySeconds, error.slice(0, 2000)]
  );
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
