let dashboard = { groups: [], matches: [], activeMemberCount: 0, matchesMade: 0 };
let roundsGenerated = 3;
let authenticated = false;
let currentSession = null;

const matchesList = document.querySelector('#matches-list');
const groupsList = document.querySelector('#groups-list');
const toast = document.querySelector('#toast');
const themePanel = document.querySelector('#theme-panel');
const themeForm = document.querySelector('#theme-form');
const groupManagement = document.querySelector('#group-management');
const managedGroupSelect = document.querySelector('#managed-group-select');

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.colorMode = theme.colorMode;
  root.style.setProperty('--theme-primary', theme.primaryColor);
  root.style.setProperty('--theme-secondary', theme.secondaryColor);
  root.style.setProperty('--theme-accent', theme.accentColor);
  root.style.setProperty('--theme-paper', theme.paperColor);
  root.style.setProperty('--theme-ink', theme.inkColor);
  document.querySelector('#brand-logo').textContent = theme.logoText;
  document.querySelector('#brand-name').textContent = theme.brandName;
  document.querySelector('#brand-tagline').textContent = theme.tagline;
  document.querySelector('#hero-title').textContent = theme.pageTitle;
  document.title = `${theme.brandName} | ${theme.pageTitle}`;
  for (const [field, value] of Object.entries(theme)) {
    const input = themeForm.elements.namedItem(field);
    if (input) input.value = value;
  }
}

async function loadTheme() {
  try {
    const response = await fetch('/api/theme');
    if (response.ok) applyTheme(await response.json());
  } catch (error) {
    console.info('Using the default local theme.', error);
  }
}

async function loadSession() {
  try {
    const response = await fetch('/api/auth/session');
    if (!response.ok) return;
    const session = await response.json();
    currentSession = session;
    const authActions = document.querySelector('#auth-actions');
    authenticated = session.authenticated;
    if (session.authenticated) {
      await loadDashboard();
      if (session.user?.systemRole !== 'system_admin' && !(session.user?.groupIds?.length)) {
        document.querySelector('#add-group').disabled = true;
        document.querySelector('#add-group').title = 'Group admin access required';
      }
      document.querySelector('#current-user-name').textContent = session.user?.name ?? 'Signed in';
      document.querySelector('#current-user-role').textContent = session.user?.systemRole === 'system_admin' ? 'System admin' : 'Group member';
      document.querySelector('#match-action-label').textContent = session.user?.systemRole === 'system_admin' ? 'System admin action' : 'Group action';
      document.querySelector('#match-action-title').textContent = 'Ready to make a few introductions?';
      document.querySelector('#match-action-copy').textContent = 'Generate the next round for your group. Previous pairings will be skipped automatically.';
      document.querySelector('#generate-match').textContent = 'Generate matches ↗';
      document.querySelector('#opt-out-toggle').disabled = false;
      authActions.innerHTML = `<span>${session.user?.name ?? 'Signed in'}</span><button type="button" id="logout-button">Sign out</button>`;
      document.querySelector('#logout-button').addEventListener('click', async () => {
        await fetch('/auth/logout', { method: 'POST' });
        window.location.reload();
      });
    } else {
      document.querySelectorAll('.requires-auth').forEach((element) => element.addEventListener('click', () => showToast('Sign in to continue.')));
    }
  } catch (error) {
    console.info('Authentication status is unavailable.', error);
  }
}

async function loadDashboard() {
  const response = await fetch('/api/dashboard');
  if (!response.ok) return;
  dashboard = await response.json();
  document.querySelector('#member-count').textContent = dashboard.activeMemberCount;
  document.querySelector('#match-count').textContent = dashboard.matchesMade;
  renderMatches();
  renderGroups();
}

async function loadManagedGroup() {
  const groupId = managedGroupSelect.value;
  if (!groupId) return;
  const group = dashboard.groups.find((candidate) => candidate.id === groupId);
  const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/members`);
  if (!response.ok) return;
  const data = await response.json();
  document.querySelector('#group-settings-form [name="groupSize"]').value = String(group?.groupSize ?? 2);
  document.querySelector('#group-settings-form [name="resetThresholdPercent"]').value = group?.resetThresholdPercent ?? 15;
  document.querySelector('#managed-members').innerHTML = data.members.map((member) => {
    const adminBadge = member.isAdmin ? '<b class="admin-badge">Group admin</b>' : '';
    const action = member.isAdmin && currentSession?.user?.systemRole === 'system_admin'
      ? `<button type="button" data-unassign-admin="${escapeHtml(member.userId)}" title="Unassign group admin">−</button>`
      : `<button type="button" data-remove-member="${escapeHtml(member.id)}" title="Remove member">×</button>`;
    return `<div class="managed-member"><span>${escapeHtml(member.name)} ${adminBadge}<small>${escapeHtml(member.email)}</small></span>${action}</div>`;
  }).join('');
  document.querySelectorAll('[data-remove-member]').forEach((button) => button.addEventListener('click', async () => {
    await fetch(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(button.dataset.removeMember)}`, { method: 'DELETE' });
    await loadManagedGroup();
    await loadDashboard();
  }));
  document.querySelectorAll('[data-unassign-admin]').forEach((button) => button.addEventListener('click', async () => {
    await fetch(`/api/groups/${encodeURIComponent(groupId)}/admins/${encodeURIComponent(button.dataset.unassignAdmin)}`, { method: 'DELETE' });
    await loadManagedGroup();
  }));
}

async function openGroupManagement() {
  if (!authenticated) {
    showToast('Sign in to continue.');
    return;
  }
  managedGroupSelect.innerHTML = dashboard.groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
  document.querySelector('#assign-admin-form').style.display = currentSession?.user?.systemRole === 'system_admin' ? 'grid' : 'none';
  groupManagement.classList.add('open');
  groupManagement.setAttribute('aria-hidden', 'false');
  await loadManagedGroup();
}

function renderMatches() {
  if (dashboard.matches.length === 0) {
    matchesList.innerHTML = '<p class="empty-state">No persisted matches yet.</p>';
    return;
  }
  matchesList.innerHTML = dashboard.matches.map((match) => {
    const names = match.participantNames.map(escapeHtml).join(' & ');
    const initials = match.participantNames.map((name) => escapeHtml(name.slice(0, 1))).join('');
    return `
    <div class="match-row">
      <div class="match-avatars"><div class="avatar avatar-amber">${initials}</div></div>
      <div class="match-details"><strong>${names}</strong><span>${escapeHtml(match.groupName)}</span></div>
      <span class="match-date">${new Date(match.createdAt).toLocaleDateString()}</span>
    </div>`;
  }).join('');
}

function renderGroups() {
  if (dashboard.groups.length === 0) {
    groupsList.innerHTML = '<p class="empty-state">No assigned groups yet.</p>';
    return;
  }
  dashboard.groups.forEach((group, index) => group.icon = ['✦', '⌁', '◌'][index % 3]);
  groupsList.innerHTML = dashboard.groups.map(group => `
    <div class="group-row">
      <div class="group-icon icon-coral">${group.icon}</div>
      <div class="group-details"><strong>${escapeHtml(group.name)}</strong><span>Persisted group</span></div>
      <span>${group.memberCount} members</span>
    </div>`).join('');
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 3200);
}

document.querySelector('#generate-match').addEventListener('click', async () => {
  if (!authenticated) {
    showToast('Sign in to continue.');
    return;
  }
  const optedOut = document.querySelector('#opt-out-toggle').checked;
  try {
    const optOutResponse = await fetch('/api/me/opt-out', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optedOut })
    });
    if (!optOutResponse.ok && optOutResponse.status !== 404) throw new Error('Opt-out update failed');
    const response = await fetch('/api/groups/demo/matches', { method: 'POST' });
    if (!response.ok) throw new Error('Match generation failed');
    await loadDashboard();
  } catch (error) {
    console.info('Running frontend-only prototype fallback.', error);
  }
  showToast(`Round generated${optedOut ? '. You opted out this round.' : '. Previous pairings were skipped.'}`);
});

document.querySelector('#add-group').addEventListener('click', openGroupManagement);
document.querySelector('#close-groups').addEventListener('click', () => {
  groupManagement.classList.remove('open');
  groupManagement.setAttribute('aria-hidden', 'true');
});
document.querySelector('#managed-group-select').addEventListener('change', loadManagedGroup);
document.querySelector('#create-group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  const response = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) return showToast('Group could not be created.');
  const createdGroup = await response.json();
  await loadDashboard();
  await openGroupManagement();
  managedGroupSelect.value = createdGroup.id;
  await loadManagedGroup();
  showToast('Group created.');
});
document.querySelector('#group-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const groupId = values.groupId;
  delete values.groupId;
  const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/config`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
  if (response.ok) {
    await loadDashboard();
    await loadManagedGroup();
  }
  showToast(response.ok ? 'Group settings saved.' : 'Group settings could not be saved.');
});
document.querySelector('#add-member-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const groupId = managedGroupSelect.value;
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    return showToast(result.error ?? 'Member could not be added.');
  }
  event.currentTarget.reset();
  await loadDashboard();
  await loadManagedGroup();
  showToast('Member added.');
});
document.querySelector('#assign-admin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  const response = await fetch(`/api/groups/${encodeURIComponent(managedGroupSelect.value)}/admins`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (response.ok) await loadManagedGroup();
  showToast(response.ok ? 'Group admin assigned.' : 'User must sign in once before assignment.');
});
document.querySelector('#theme-settings').addEventListener('click', () => {
  if (!authenticated) {
    showToast('Sign in to continue.');
    return;
  }
  themePanel.classList.add('open');
  themePanel.setAttribute('aria-hidden', 'false');
});
document.querySelector('#close-theme').addEventListener('click', () => {
  themePanel.classList.remove('open');
  themePanel.setAttribute('aria-hidden', 'true');
});
themeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const theme = Object.fromEntries(new FormData(themeForm).entries());
  try {
    const response = await fetch('/api/theme', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(theme)
    });
    if (!response.ok) throw new Error('Theme update failed');
    applyTheme(await response.json());
    themePanel.classList.remove('open');
    themePanel.setAttribute('aria-hidden', 'true');
    showToast('Theme updated.');
  } catch (error) {
    showToast('Theme could not be saved.');
    console.error(error);
  }
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  const matchingNav = document.querySelector(`.nav-item[data-view="${button.dataset.view}"]`);
  if (matchingNav) matchingNav.classList.add('active');
  document.querySelector('#page-label').textContent = button.dataset.view === 'overview' ? 'Overview' : button.textContent.trim();
  if (button.dataset.view !== 'overview') showToast(`${button.textContent.trim()} view is part of the next prototype slice.`);
}));

renderMatches();
renderGroups();
loadTheme();
loadSession();
