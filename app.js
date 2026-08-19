const members = [
  { name: 'Maya & Theo', initials: ['MT'], tone: 'avatar-amber', topic: 'Designing better rituals' },
  { name: 'Priya & Sam', initials: ['PS'], tone: 'avatar-coral', topic: 'Making space for curiosity' },
  { name: 'Leo & Nadia', initials: ['LN'], tone: 'avatar-teal', topic: 'Small acts, big changes' },
  { name: 'Ari & Chris', initials: ['AC'], tone: 'avatar-gold', topic: 'Building community locally' }
];
const groups = [
  { name: 'Fika Berlin', count: 24, icon: '✦', tone: 'icon-coral' },
  { name: 'Product Folks', count: 18, icon: '⌁', tone: 'icon-teal' },
  { name: 'New in Town', count: 12, icon: '◌', tone: 'icon-gold' }
];
let roundsGenerated = 3;

const matchesList = document.querySelector('#matches-list');
const groupsList = document.querySelector('#groups-list');
const toast = document.querySelector('#toast');
const themePanel = document.querySelector('#theme-panel');
const themeForm = document.querySelector('#theme-form');

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

function renderMatches() {
  matchesList.innerHTML = members.map((match, index) => `
    <div class="match-row">
      <div class="match-avatars"><div class="avatar ${match.tone}">${match.initials[0]}</div><div class="avatar avatar-amber">${String.fromCharCode(74 + index)}</div></div>
      <div class="match-details"><strong>${match.name}</strong><span>${match.topic}</span></div>
      <span class="match-date">${index === 0 ? 'Today' : `${index + 1}d ago`}</span>
    </div>`).join('');
}

function renderGroups() {
  groupsList.innerHTML = groups.map(group => `
    <div class="group-row">
      <div class="group-icon ${group.tone}">${group.icon}</div>
      <div class="group-details"><strong>${group.name}</strong><span>Last round ${group.name === 'Fika Berlin' ? 'today' : '2d ago'}</span></div>
      <span>${group.count} members</span>
    </div>`).join('');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 3200);
}

document.querySelector('#generate-match').addEventListener('click', async () => {
  roundsGenerated += 1;
  document.querySelector('#match-count').textContent = 18 + roundsGenerated;
  renderMatches();
  const optedOut = document.querySelector('#opt-out-toggle').checked;
  try {
    await fetch('/api/groups/demo/members/jordan/opt-out', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optedOut })
    });
    await fetch('/api/groups/demo/matches', { method: 'POST' });
  } catch (error) {
    console.info('Running frontend-only prototype fallback.', error);
  }
  showToast(`Round ${roundsGenerated} generated${optedOut ? '. You opted out this round.' : '. Previous pairings were skipped.'}`);
});

document.querySelector('#add-group').addEventListener('click', () => showToast('Group creation is next in the admin slice.'));
document.querySelector('#theme-settings').addEventListener('click', () => {
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
