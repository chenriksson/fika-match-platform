import express from 'express';
import session from 'express-session';
import { Client, Issuer } from 'openid-client';
import { generateMatches, type Member } from './matching.js';
import { createMatchNotification, sendNotification } from './mail.js';
import {
  claimNotification,
  initializeDatabase,
  loadDemoState,
  loadTheme,
  markNotificationFailed,
  markNotificationSent,
  saveRound,
  setMemberOptOut,
  updateTheme,
  updateDemoConfig
} from './db.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const oidcState = new Map<string, { client: Client; provider: string }>();

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET ?? 'local-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false }
}));
app.use(express.static('.'));

app.get('/api/health', (_request, response) => response.json({ ok: true, mode: 'local' }));
app.get('/api/theme', async (_request, response) => response.json(await loadTheme()));
app.patch('/api/theme', async (request, response) => {
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
app.get('/api/groups/demo', async (_request, response) => {
  const state = await loadDemoState();
  return response.json({ id: 'demo', name: 'Fika Berlin', members: state.members, config: state.config });
});

app.patch('/api/groups/demo/members/:memberId/opt-out', async (request, response) => {
  const member = await setMemberOptOut(request.params.memberId, Boolean(request.body.optedOut));
  if (!member) return response.status(404).json({ error: 'Member not found' });
  return response.json({ member });
});

app.patch('/api/groups/demo/config', async (request, response) => {
  const { groupSize, resetThresholdPercent } = request.body as { groupSize?: number; resetThresholdPercent?: number };
  if (groupSize !== undefined && ![2, 3, 4].includes(groupSize)) return response.status(400).json({ error: 'groupSize must be 2, 3, or 4' });
  if (resetThresholdPercent !== undefined && (resetThresholdPercent < 0 || resetThresholdPercent > 100)) return response.status(400).json({ error: 'resetThresholdPercent must be between 0 and 100' });
  const config = await updateDemoConfig({ groupSize: groupSize as 2 | 3 | 4 | undefined, resetThresholdPercent });
  return response.json({ config });
});

app.post('/api/groups/demo/matches', async (request, response) => {
  const state = await loadDemoState();
  const result = generateMatches(state.members, state.history, state.config);
  const generationKey = String(request.get('Idempotency-Key') ?? request.body.generationKey ?? crypto.randomUUID());
  const notifications = result.matches.map((match) => createMatchNotification(match.participantIds.map((id) => {
    const member = state.members.find((candidate) => candidate.id === id);
    return { email: member?.email ?? '', name: member?.name ?? id };
  }), match));
  const saved = await saveRound(generationKey, result, state.history, notifications);
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
  if (!client) return response.json({ mode: 'mock', provider, message: 'Configure provider credentials in .env to enable OIDC.' });
  const state = crypto.randomUUID();
  oidcState.set(state, { client, provider });
  const redirectUri = `${request.protocol}://${request.get('host')}/auth/callback/${provider}`;
  return response.redirect(client.authorizationUrl({ scope: 'openid email profile', response_mode: 'query', redirect_uri: redirectUri, state }));
});

app.get('/auth/callback/:provider', async (request, response) => {
  const state = String(request.query.state ?? '');
  const pending = oidcState.get(state);
  if (!pending) return response.status(400).send('Invalid OIDC state');
  oidcState.delete(state);
  const redirectUri = `${request.protocol}://${request.get('host')}/auth/callback/${pending.provider}`;
  const tokenSet = await pending.client.callback(redirectUri, request.query as Record<string, string>, { state });
  const profile = tokenSet.claims();
  (request.session as { user?: unknown }).user = { sub: profile.sub, email: profile.email, name: profile.name };
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
