import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { Client, Issuer } from 'openid-client';
import { generateMatches, type Member } from './matching.js';
import { createMatchNotification, sendNotification } from './mail.js';
import {
  claimNotification,
  addGroupMember,
  assignGroupAdmin,
  createGroup,
  initializeDatabase,
  loadDemoState,
  loadGroupMembers,
  loadGroupState,
  removeGroupAdmin,
  loadTheme,
  markNotificationFailed,
  markNotificationSent,
  saveRound,
  removeGroupMember,
  setMemberOptOut,
  setGroupMemberOptOut,
  setAuthenticatedMemberOptOut,
  loadAuthorization,
  loadDashboard,
  upsertAuthenticatedUser,
  updateTheme,
  updateGroupConfig
} from './db.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const oidcState = new Map<string, { client: Client; provider: 'google' | 'microsoft'; nonce: string }>();
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://fika:fika@localhost:5432/fika' });
const PgSession = connectPgSimple(session);

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET ?? 'local-only-change-me',
  store: new PgSession({ pool: sessionPool, createTableIfMissing: true }),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static('.'));

type SessionUser = { id?: string; sub?: string; email?: string; name?: string; systemRole?: 'system_admin' | 'user'; groupIds?: string[] };
const localDemoAdmin = process.env.NODE_ENV !== 'production' && process.env.LOCAL_DEMO_ADMIN !== 'false';

async function authorization(request: express.Request): Promise<ReturnType<typeof loadAuthorization> extends Promise<infer Value> ? Value : never> {
  if (localDemoAdmin) return { userId: 'local-demo-admin', name: 'Local system admin', email: '', systemRole: 'system_admin', groupIds: ['demo'], memberIds: ['jordan'] };
  const user = (request.session as { user?: SessionUser }).user;
  if (!user?.id) return undefined;
  return loadAuthorization(user.id, user.systemRole);
}

function requireSystemAdmin(request: express.Request, response: express.Response, next: express.NextFunction): void {
  void authorization(request).then((user) => {
    if (user?.systemRole === 'system_admin') return next();
    return response.status(user ? 403 : 401).json({ error: user ? 'System administrator role required' : 'Authentication required' });
  }).catch(next);
}

function requireGroupAdmin(groupId: string) {
  return (request: express.Request, response: express.Response, next: express.NextFunction): void => {
    void authorization(request).then((user) => {
      if (user?.systemRole === 'system_admin' || user?.groupIds.includes(groupId)) return next();
      return response.status(user ? 403 : 401).json({ error: user ? 'Group administrator role required' : 'Authentication required' });
    }).catch(next);
  };
}

function requireGroupMember(groupId: string) {
  return (request: express.Request, response: express.Response, next: express.NextFunction): void => {
    void authorization(request).then(async (user) => {
      if (user?.systemRole === 'system_admin' || user?.groupIds.includes(groupId)) return next();
      if (user?.memberIds.length) {
        const state = await loadDemoState();
        if (state.members.some((member) => user.memberIds.includes(member.id))) return next();
      }
      return response.status(user ? 403 : 401).json({ error: user ? 'Group membership required' : 'Authentication required' });
    }).catch(next);
  };
}

app.get('/api/auth/session', async (request, response) => {
  const user = await authorization(request);
  return response.json({ authenticated: Boolean(user), localDemoAdmin, user: user ? { id: user.userId, name: user.name, email: user.email, systemRole: user.systemRole, groupIds: user.groupIds } : null });
});

app.get('/api/dashboard', async (request, response) => {
  const user = await authorization(request);
  if (!user) return response.status(401).json({ error: 'Authentication required' });
  return response.json(await loadDashboard(user));
});

app.post('/auth/logout', (request, response, next) => {
  request.session.destroy((error) => {
    if (error) return next(error);
    return response.status(204).end();
  });
});

app.patch('/api/me/opt-out', async (request, response) => {
  const user = await authorization(request);
  if (!user) return response.status(401).json({ error: 'Authentication required' });
  const member = await setAuthenticatedMemberOptOut(user.userId, Boolean(request.body.optedOut));
  if (!member) return response.status(404).json({ error: 'No group membership is linked to this account' });
  return response.json({ member });
});

app.get('/api/health', (_request, response) => response.json({ ok: true, mode: 'local' }));
app.get('/api/theme', requireSystemAdmin, async (_request, response) => response.json(await loadTheme()));
app.patch('/api/theme', requireSystemAdmin, async (request, response) => {
  const theme = request.body as Record<string, unknown>;
  const textFields = ['logoText', 'brandName', 'pageTitle', 'tagline'] as const;
  const colorFields = ['primaryColor', 'secondaryColor', 'accentColor', 'paperColor', 'inkColor'] as const;
  if ([...textFields, ...colorFields].some((field) => typeof theme[field] !== 'string' || theme[field].trim().length === 0)) {
    return response.status(400).json({ error: 'All theme fields are required' });
  }
  if (theme.colorMode !== 'light' && theme.colorMode !== 'dark') {
    return response.status(400).json({ error: 'colorMode must be light or dark' });
  }
  if (textFields.some((field) => String(theme[field]).length > 120)) {
    return response.status(400).json({ error: 'Theme text fields are too long' });
  }
  if (colorFields.some((field) => !/^#[0-9a-fA-F]{6}$/.test(String(theme[field])))) {
    return response.status(400).json({ error: 'Theme colors must be six-digit hex values' });
  }
  const updatedTheme = await updateTheme({
    logoText: String(theme.logoText).trim(),
    brandName: String(theme.brandName).trim(),
    pageTitle: String(theme.pageTitle).trim(),
    tagline: String(theme.tagline).trim(),
    primaryColor: String(theme.primaryColor),
    secondaryColor: String(theme.secondaryColor),
    accentColor: String(theme.accentColor),
    paperColor: String(theme.paperColor),
    inkColor: String(theme.inkColor),
    colorMode: theme.colorMode
  });
  return response.json(updatedTheme);
});
app.post('/api/groups', requireSystemAdmin, async (request, response) => {
  const { name, groupSize: rawGroupSize = 2, resetThresholdPercent: rawThreshold = 15 } = request.body as { name?: string; groupSize?: number | string; resetThresholdPercent?: number | string };
  const groupSize = Number(rawGroupSize);
  const resetThresholdPercent = Number(rawThreshold);
  if (!name?.trim() || ![2, 3, 4].includes(groupSize) || resetThresholdPercent < 0 || resetThresholdPercent > 100) {
    return response.status(400).json({ error: 'Valid name, group size, and reset threshold are required' });
  }
  const id = `group-${crypto.randomUUID()}`;
  return response.status(201).json(await createGroup(id, name.trim(), { groupSize: groupSize as 2 | 3 | 4, resetThresholdPercent }));
});

app.get('/api/groups/:groupId/members', (request, response, next) => requireGroupAdmin(String(request.params.groupId))(request, response, next), async (request, response) => {
  return response.json({ members: await loadGroupMembers(String(request.params.groupId)) });
});

app.post('/api/groups/:groupId/members', (request, response, next) => requireGroupAdmin(String(request.params.groupId))(request, response, next), async (request, response) => {
  const { email, name } = request.body as { email?: string; name?: string };
  if (!email?.trim() || !name?.trim()) return response.status(400).json({ error: 'Member name and email are required' });
  const memberId = `member-${crypto.randomUUID()}`;
  try {
    return response.status(201).json({ member: await addGroupMember(String(request.params.groupId), memberId, email.trim(), name.trim()) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      return response.status(409).json({ error: 'A member with this email already exists in the group' });
    }
    throw error;
  }
});

app.delete('/api/groups/:groupId/members/:memberId', (request, response, next) => requireGroupAdmin(String(request.params.groupId))(request, response, next), async (request, response) => {
  const removed = await removeGroupMember(String(request.params.groupId), String(request.params.memberId));
  return removed ? response.status(204).end() : response.status(404).json({ error: 'Member not found' });
});

app.patch('/api/groups/:groupId/members/:memberId/opt-out', (request, response, next) => requireGroupAdmin(String(request.params.groupId))(request, response, next), async (request, response) => {
  const member = await setGroupMemberOptOut(String(request.params.groupId), String(request.params.memberId), Boolean(request.body.optedOut));
  if (!member) return response.status(404).json({ error: 'Member not found' });
  return response.json({ member });
});

app.post('/api/groups/:groupId/admins', requireSystemAdmin, async (request, response) => {
  const { email } = request.body as { email?: string };
  if (!email?.trim()) return response.status(400).json({ error: 'Admin email is required' });
  const assigned = await assignGroupAdmin(String(request.params.groupId), email.trim());
  return assigned ? response.status(201).json({ assigned: true }) : response.status(404).json({ error: 'User not found' });
});

app.delete('/api/groups/:groupId/admins/:userId', requireSystemAdmin, async (request, response) => {
  const removed = await removeGroupAdmin(String(request.params.groupId), String(request.params.userId));
  return removed ? response.status(204).end() : response.status(404).json({ error: 'Group admin assignment not found' });
});

app.patch('/api/groups/:groupId/config', (request, response, next) => requireGroupAdmin(String(request.params.groupId))(request, response, next), async (request, response) => {
  const { groupSize: rawGroupSize, resetThresholdPercent: rawThreshold } = request.body as { groupSize?: number | string; resetThresholdPercent?: number | string };
  const groupSize = rawGroupSize === undefined ? undefined : Number(rawGroupSize);
  const resetThresholdPercent = rawThreshold === undefined ? undefined : Number(rawThreshold);
  if (groupSize !== undefined && ![2, 3, 4].includes(groupSize)) return response.status(400).json({ error: 'groupSize must be 2, 3, or 4' });
  if (resetThresholdPercent !== undefined && (resetThresholdPercent < 0 || resetThresholdPercent > 100)) return response.status(400).json({ error: 'resetThresholdPercent must be between 0 and 100' });
  const config = await updateGroupConfig(String(request.params.groupId), { groupSize: groupSize as 2 | 3 | 4 | undefined, resetThresholdPercent });
  return response.json({ config });
});

app.post('/api/groups/:groupId/matches', (request, response, next) => requireGroupAdmin(String(request.params.groupId))(request, response, next), async (request, response) => {
  const groupId = String(request.params.groupId);
  const state = await loadGroupState(groupId);
  const result = generateMatches(state.members, state.history, state.config);
  const generationKey = String(request.get('Idempotency-Key') ?? request.body.generationKey ?? crypto.randomUUID());
  const notifications = result.matches.map((match) => createMatchNotification(match.participantIds.map((id) => {
    const member = state.members.find((candidate) => candidate.id === id);
    return { email: member?.email ?? '', name: member?.name ?? id };
  }), match));
  const saved = await saveRound(generationKey, result, state.history, notifications, groupId);
  if (!saved) return response.status(409).json({ error: 'A round with this idempotency key already exists' });
  void processNotificationQueue();
  return response.status(201).json(result);
});

let notificationWorkerRunning = false;

async function processNotificationQueue(): Promise<void> {
  if (notificationWorkerRunning) return;
  notificationWorkerRunning = true;
  try {
    const notification = await claimNotification();
    if (!notification) return;
    try {
      await sendNotification(notification);
      await markNotificationSent(notification.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markNotificationFailed(notification.id, notification.attempts, message);
      console.error(`Unable to deliver notification ${notification.id}: ${message}`);
    }
  } finally {
    notificationWorkerRunning = false;
  }
}

async function oidcClient(provider: 'google' | 'microsoft'): Promise<Client | undefined> {
  const clientId = provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = provider === 'google' ? process.env.GOOGLE_CLIENT_SECRET : process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const issuerUrl = provider === 'google' ? 'https://accounts.google.com' : 'https://login.microsoftonline.com/common/v2.0';
  const issuer = await Issuer.discover(issuerUrl);
  return new issuer.Client({ client_id: clientId, client_secret: clientSecret, response_types: ['code'] });
}

app.get('/auth/:provider', async (request, response) => {
  const provider = request.params.provider as 'google' | 'microsoft';
  if (!['google', 'microsoft'].includes(provider)) return response.status(404).send('Unknown identity provider');
  const client = await oidcClient(provider);
  if (!client) return response.status(404).send(`${provider} sign-in is not enabled`);
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  oidcState.set(state, { client, provider, nonce });
  const redirectUri = `${request.protocol}://${request.get('host')}/auth/callback/${provider}`;
  return response.redirect(client.authorizationUrl({ scope: 'openid email profile', response_mode: 'query', redirect_uri: redirectUri, state, nonce }));
});

app.get('/auth/callback/:provider', async (request, response) => {
  const state = String(request.query.state ?? '');
  const pending = oidcState.get(state);
  if (!pending) return response.status(400).send('Invalid OIDC state');
  oidcState.delete(state);
  const redirectUri = `${request.protocol}://${request.get('host')}/auth/callback/${pending.provider}`;
  const tokenSet = await pending.client.callback(redirectUri, request.query as Record<string, string>, { state, nonce: pending.nonce });
  const profile = tokenSet.claims();
  const authorization = await upsertAuthenticatedUser({ sub: profile.sub, email: String(profile.email ?? ''), name: String(profile.name ?? profile.email ?? 'User') });
  (request.session as { user?: SessionUser }).user = { id: authorization.userId, email: profile.email, name: profile.name, systemRole: authorization.systemRole, groupIds: authorization.groupIds };
  return response.redirect(process.env.OIDC_SUCCESS_REDIRECT ?? '/');
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => console.log(`Fika local API listening on http://localhost:${port}`));
    setInterval(() => void processNotificationQueue(), 1000);
  })
  .catch((error) => {
    console.error('Unable to initialize PostgreSQL', error);
    process.exitCode = 1;
  });
