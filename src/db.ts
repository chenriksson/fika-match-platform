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

export type Authorization = {
  userId: string;
  name: string;
  email: string;
  systemRole: 'system_admin' | 'user';
  groupIds: string[];
  memberIds: string[];
};

export type DashboardData = {
  groups: Array<{ id: string; name: string; memberCount: number; groupSize: 2 | 3 | 4; resetThresholdPercent: number }>;
  matches: Array<{ participantNames: string[]; createdAt: string; groupName: string }>;
  activeMemberCount: number;
  matchesMade: number;
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

export async function upsertAuthenticatedUser(profile: { sub: string; email: string; name: string }): Promise<Authorization> {
  const result = await pool.query<{ id: string; system_role: 'system_admin' | 'user' }>(
    `INSERT INTO app_users (id, oidc_subject, email, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (oidc_subject) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING id, system_role`,
    [profile.sub, profile.sub, profile.email, profile.name]
  );
  const user = result.rows[0];
  if (!user) throw new Error('Authenticated user could not be persisted');
  await pool.query(
    'UPDATE members SET user_id = $1 WHERE user_id IS NULL AND LOWER(email) = LOWER($2)',
    [user.id, profile.email]
  );
  const authorization = await loadAuthorization(user.id, user.system_role);
  if (!authorization) throw new Error('Authenticated user authorization could not be loaded');
  return authorization;
}

export async function loadAuthorization(userId: string, systemRole?: 'system_admin' | 'user'): Promise<Authorization | undefined> {
  const userResult = await pool.query<{ id: string; name: string; email: string; system_role: 'system_admin' | 'user' }>(
    'SELECT id, name, email, system_role FROM app_users WHERE id = $1',
    [userId]
  );
  const user = userResult.rows[0];
  if (!user && !systemRole) return undefined;
  const role = user?.system_role ?? systemRole;
  if (!role) return undefined;
  const groups = await pool.query<{ group_id: string }>('SELECT group_id FROM group_admins WHERE user_id = $1', [userId]);
  const members = await pool.query<{ id: string }>('SELECT id FROM members WHERE user_id = $1', [userId]);
  return { userId, name: user?.name ?? '', email: user?.email ?? '', systemRole: role, groupIds: groups.rows.map((row) => row.group_id), memberIds: members.rows.map((row) => row.id) };
}

export async function loadDashboard(authorization: Authorization): Promise<DashboardData> {
  const groupResult = authorization.systemRole === 'system_admin'
    ? await pool.query<{ id: string; name: string; member_count: string; group_size: 2 | 3 | 4; reset_threshold_percent: string }>(
      `SELECT groups.id, groups.name, groups.group_size, groups.reset_threshold_percent, COUNT(members.id)::text AS member_count
       FROM groups LEFT JOIN members ON members.group_id = groups.id
       GROUP BY groups.id, groups.name ORDER BY groups.name`
    )
    : await pool.query<{ id: string; name: string; member_count: string; group_size: 2 | 3 | 4; reset_threshold_percent: string }>(
      `SELECT groups.id, groups.name, groups.group_size, groups.reset_threshold_percent, COUNT(members.id)::text AS member_count
       FROM groups
       LEFT JOIN members ON members.group_id = groups.id
       WHERE groups.id IN (
         SELECT group_id FROM group_admins WHERE user_id = $1
         UNION
         SELECT group_id FROM members WHERE user_id = $1
       )
       GROUP BY groups.id, groups.name ORDER BY groups.name`,
      [authorization.userId]
    );
  const groupIds = groupResult.rows.map((group) => group.id);
  if (groupIds.length === 0) return { groups: [], matches: [], activeMemberCount: 0, matchesMade: 0 };
  const matchResult = await pool.query<{ participant_names: string[]; created_at: string; group_name: string }>(
    `SELECT ARRAY_AGG(members.name ORDER BY members.name) AS participant_names,
            rounds.created_at::text AS created_at, groups.name AS group_name
     FROM rounds
     JOIN groups ON groups.id = rounds.group_id
     JOIN matches ON matches.round_id = rounds.id
     JOIN match_participants ON match_participants.match_id = matches.id
     JOIN members ON members.id = match_participants.member_id
     WHERE rounds.group_id = ANY($1::text[])
     GROUP BY matches.id, rounds.created_at, groups.name
     ORDER BY rounds.created_at DESC, matches.id DESC
     LIMIT 8`,
    [groupIds]
  );
  const activeResult = await pool.query<{ active_count: string }>(
    'SELECT COUNT(*)::text AS active_count FROM members WHERE group_id = ANY($1::text[]) AND opted_out = FALSE',
    [groupIds]
  );
  const countResult = await pool.query<{ match_count: string }>(
    'SELECT COUNT(*)::text AS match_count FROM matches JOIN rounds ON rounds.id = matches.round_id WHERE rounds.group_id = ANY($1::text[])',
    [groupIds]
  );
  return {
    groups: groupResult.rows.map((group) => ({ id: group.id, name: group.name, memberCount: Number(group.member_count), groupSize: group.group_size, resetThresholdPercent: Number(group.reset_threshold_percent) })),
    matches: matchResult.rows.map((match) => ({ participantNames: match.participant_names, createdAt: match.created_at, groupName: match.group_name })),
    activeMemberCount: Number(activeResult.rows[0]?.active_count ?? 0),
    matchesMade: Number(countResult.rows[0]?.match_count ?? 0)
  };
}

export async function loadDemoState(): Promise<DemoState> {
  return loadGroupState('demo');
}

export async function loadGroupState(groupId: string): Promise<DemoState> {
  const groupResult = await pool.query<{ group_size: 2 | 3 | 4; reset_threshold_percent: string }>(
    'SELECT group_size, reset_threshold_percent FROM groups WHERE id = $1',
    [groupId]
  );
  const memberResult = await pool.query<Member>(
    'SELECT id, email, name, opted_out AS "optedOut" FROM members WHERE group_id = $1 ORDER BY id',
    [groupId]
  );
  const historyResult = await pool.query<{ left_member_id: string; right_member_id: string }>(
    'SELECT left_member_id, right_member_id FROM pair_history WHERE group_id = $1',
    [groupId]
  );
  const group = groupResult.rows[0];
  if (!group) throw new Error(`Group ${groupId} was not initialized`);

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
  return setGroupMemberOptOut('demo', memberId, optedOut);
}

export async function setGroupMemberOptOut(groupId: string, memberId: string, optedOut: boolean): Promise<Member | undefined> {
  const result = await pool.query<Member>(
    'UPDATE members SET opted_out = $1 WHERE group_id = $2 AND id = $3 RETURNING id, email, name, opted_out AS "optedOut"',
    [optedOut, groupId, memberId]
  );
  return result.rows[0];
}

export async function setAuthenticatedMemberOptOut(userId: string, optedOut: boolean): Promise<Member | undefined> {
  const result = await pool.query<Member>(
    `UPDATE members SET opted_out = $1
     WHERE user_id = $2
     RETURNING id, email, name, opted_out AS "optedOut"`,
    [optedOut, userId]
  );
  return result.rows[0];
}

export async function updateDemoConfig(config: Partial<MatchConfig>): Promise<MatchConfig> {
  return updateGroupConfig('demo', config);
}

export async function updateGroupConfig(groupId: string, config: Partial<MatchConfig>): Promise<MatchConfig> {
  const result = await pool.query<{ group_size: 2 | 3 | 4; reset_threshold_percent: string }>(
    `UPDATE groups
     SET group_size = COALESCE($1, group_size),
         reset_threshold_percent = COALESCE($2, reset_threshold_percent)
     WHERE id = $3
     RETURNING group_size, reset_threshold_percent`,
    [config.groupSize ?? null, config.resetThresholdPercent ?? null, groupId]
  );
  const group = result.rows[0];
  if (!group) throw new Error(`Group ${groupId} was not initialized`);
  return { groupSize: group.group_size, resetThresholdPercent: Number(group.reset_threshold_percent) };
}

export type GroupMember = Member & { groupId: string; userId?: string; isAdmin: boolean };

export async function createGroup(id: string, name: string, config: MatchConfig): Promise<{ id: string; name: string; config: MatchConfig }> {
  const result = await pool.query<{ id: string; name: string; group_size: 2 | 3 | 4; reset_threshold_percent: string }>(
    `INSERT INTO groups (id, name, group_size, reset_threshold_percent)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, group_size, reset_threshold_percent`,
    [id, name, config.groupSize, config.resetThresholdPercent]
  );
  const group = result.rows[0];
  return { id: group.id, name: group.name, config: { groupSize: group.group_size, resetThresholdPercent: Number(group.reset_threshold_percent) } };
}

export async function loadGroupMembers(groupId: string): Promise<GroupMember[]> {
  const result = await pool.query<GroupMember>(
    `SELECT members.id, members.group_id AS "groupId", members.user_id AS "userId",
            members.email, members.name, members.opted_out AS "optedOut",
            EXISTS (SELECT 1 FROM group_admins WHERE group_admins.group_id = members.group_id AND group_admins.user_id = members.user_id) AS "isAdmin"
     FROM members WHERE group_id = $1 ORDER BY name`,
    [groupId]
  );
  return result.rows;
}

export async function addGroupMember(groupId: string, memberId: string, email: string, name: string): Promise<GroupMember> {
  const result = await pool.query<GroupMember>(
    `INSERT INTO members (id, group_id, email, name, user_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM app_users WHERE LOWER(email) = LOWER($3) LIMIT 1))
     RETURNING id, group_id AS "groupId", user_id AS "userId", email, name, opted_out AS "optedOut",
       FALSE AS "isAdmin"`,
    [memberId, groupId, email, name]
  );
  return result.rows[0];
}

export async function removeGroupMember(groupId: string, memberId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM members WHERE group_id = $1 AND id = $2', [groupId, memberId]);
  return result.rowCount === 1;
}

export async function assignGroupAdmin(groupId: string, email: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO group_admins (group_id, user_id)
     SELECT $1, id FROM app_users WHERE LOWER(email) = LOWER($2)
     ON CONFLICT DO NOTHING`,
    [groupId, email]
  );
  return result.rowCount === 1;
}

export async function removeGroupAdmin(groupId: string, userId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM group_admins WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  return result.rowCount === 1;
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
  notifications: MatchNotification[] = [],
  groupId = 'demo'
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roundResult = await client.query<{ id: string }>(
      `INSERT INTO rounds (group_id, generation_key, reset_performed)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, generation_key) DO NOTHING
       RETURNING id`,
      [groupId, generationKey, result.resetPerformed]
    );
    const round = roundResult.rows[0];
    if (!round) {
      await client.query('ROLLBACK');
      return false;
    }

    if (result.resetPerformed) {
      await client.query('DELETE FROM pair_history WHERE group_id = $1', [groupId]);
    }
    for (const match of result.matches) {
      const matchResult = await client.query<{ id: string }>('INSERT INTO matches (round_id) VALUES ($1) RETURNING id', [round.id]);
      for (const memberId of match.participantIds) {
        await client.query('INSERT INTO match_participants (match_id, member_id) VALUES ($1, $2)', [matchResult.rows[0].id, memberId]);
      }
    }
    await saveHistory(client, groupId, history);
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

async function saveHistory(client: PoolClient, groupId: string, history: Set<string>): Promise<void> {
  for (const key of history) {
    const [leftMemberId, rightMemberId] = key.split(':');
    await client.query(
      `INSERT INTO pair_history (group_id, left_member_id, right_member_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, left_member_id, right_member_id) DO NOTHING`,
      [groupId, leftMemberId, rightMemberId]
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
