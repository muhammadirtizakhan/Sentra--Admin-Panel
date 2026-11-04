'use strict';

// Application confirmation: keyboard accessible, text-only content, no browser confirm().
let activeConfirmation = false;
function confirmAction({title, message, confirmLabel}) {
  if (activeConfirmation) return Promise.resolve(false);
  activeConfirmation = true;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'sentra-confirm';
  dialog.setAttribute('aria-labelledby', 'sentra-confirm-title');
  dialog.setAttribute('aria-describedby', 'sentra-confirm-message');
  const heading = document.createElement('h2');
  heading.id = 'sentra-confirm-title'; heading.textContent = title;
  const description = document.createElement('p');
  description.id = 'sentra-confirm-message'; description.textContent = message;
  const actions = document.createElement('div'); actions.className = 'sentra-confirm-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'sentra-confirm-cancel'; cancel.textContent = 'Cancel';
  const accept = document.createElement('button');
  accept.type = 'button'; accept.className = 'sentra-confirm-accept'; accept.textContent = confirmLabel;
  actions.append(cancel, accept); dialog.append(heading, description, actions); document.body.append(dialog);
  return new Promise(resolve => {
    let accepted = false;
    dialog.addEventListener('close', () => {
      dialog.remove(); activeConfirmation = false;
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(accepted);
    }, {once:true});
    cancel.onclick = () => dialog.close();
    accept.onclick = () => { accepted = true; dialog.close(); };
    dialog.addEventListener('click', e => {
      const r = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
    });
    try { dialog.showModal(); cancel.focus(); }
    catch { dialog.remove(); activeConfirmation = false; resolve(false); }
  });
}


const $ = selector => document.querySelector(selector);

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));

const number = value =>
  value == null ? '—' : Number(value).toLocaleString();

const pageDetails = {
  overview: {
    title: 'Overview',
    eyebrow: 'WORKSPACE AT A GLANCE',
    description: 'A clear view of company access and your recording library.'
  },
  requests: {
    title: 'Invitation requests',
    eyebrow: 'MANAGE ACCESS',
    description: 'Review requests, assign devices and email invitation codes.'
  },
  users: {
    title: 'Registered users',
    eyebrow: 'COMPANY DIRECTORY',
    description: 'View user accounts and the devices assigned to each person.'
  },
  recordings: {
    title: 'Recording library',
    eyebrow: 'PROCESSING & STORAGE',
    description: 'Review saved recordings and their processing and upload statuses.'
  },
  settings: {
    title: 'Settings',
    eyebrow: 'ADMIN PREFERENCES',
    description: 'Manage browser notifications and learn about the SENTRA workspace.'
  }
};

const state = {
  signedIn: false,
  page: 'overview',
  requests: [],
  devices: [],
  emailConfigured: false,
  users: [],
  usersPage: 1,
  usersTotal: 0,
  recordings: [],
  recordingsPage: 1,
  recordingsTotal: 0,
  pageSize: 50,
  sending: false,
  loadVersion: 0
};

function notify(message = '', isError = false) {
  const element = $('#admin-message');
  element.textContent = message;
  element.classList.toggle('is-error', isError);
}

function dateLabel(value) {
  if (!value) return 'Not recorded';

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? 'Not recorded'
    : date.toLocaleString();
}

function badge(value) {
  const text = String(value || 'unknown');
  const normalized = text.toLowerCase();

  let color = '';

  if ([
    'active',
    'approved',
    'ready',
    'completed',
    'done',
    'processed',
    'finished'
  ].includes(normalized)) {
    color = 'badge-green';
  } else if ([
    'pending',
    'sending',
    'processing',
    'uploading',
    'queued',
    'recording'
  ].includes(normalized)) {
    color = 'badge-amber';
  } else if ([
    'disabled',
    'failed',
    'rejected',
    'error',
    'cancelled'
  ].includes(normalized)) {
    color = 'badge-red';
  }

  return `<span class="badge ${color}">${esc(text)}</span>`;
}

function showLogin(message = '') {
  state.signedIn = false;
  state.loadVersion++;

  state.requests = [];
  state.devices = [];
  state.users = [];
  state.recordings = [];

  $('#admin-login').hidden = false;
  $('#admin-workspace').hidden = true;

  $('#admin-requests').replaceChildren();
  $('#users-table-body').replaceChildren();
  $('#recordings-table-body').replaceChildren();
  $('#overview-stats').replaceChildren();
  $('#users-chart').replaceChildren();
  $('#recordings-chart').replaceChildren();

  document.body.classList.remove('menu-open');

  if (message) notify(message);
}

async function api(endpoint, body) {
  const response = await fetch('/api/company-admin/' + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined
      ? {}
      : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error('The server returned an unexpected response. Please retry.');
  }

  if (response.status === 401) {
    showLogin('Please sign in to the company admin area.');

    const error = new Error(data.error || 'Company admin login required');
    error.unauthorized = true;
    throw error;
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Request failed. Please retry.');
  }

  return data;
}

function routeName() {
  const requested = location.hash.slice(1).split('?')[0];
  return Object.hasOwn(pageDetails, requested) ? requested : 'overview';
}

function navigate(page) {
  const target = Object.hasOwn(pageDetails, page) ? page : 'overview';

  if (location.hash === '#' + target) {
    if (state.signedIn) {
      loadCurrent().catch(handleError);
    }
  } else {
    location.hash = target;
  }
}

function handleError(error) {
  if (!error.unauthorized) {
    notify(error.message || 'Unable to complete this request.', true);
  }
}

function displayPage() {
  state.page = routeName();

  const details = pageDetails[state.page];

  $('#header-title').textContent = details.title;
  $('#page-title').textContent = details.title;
  $('#page-eyebrow').textContent = details.eyebrow;
  $('#page-description').textContent = details.description;

  for (const page of Object.keys(pageDetails)) {
    $('#panel-' + page).hidden = page !== state.page;
  }

  document.querySelectorAll('.nav-button').forEach(button => {
    const active = button.dataset.go === state.page;
    button.classList.toggle('active', active);

    if (active) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });

  document.body.classList.remove('menu-open');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
}

function updateTime() {
  $('#last-updated').textContent =
    'Updated ' + new Date().toLocaleTimeString();
}

function setPending(count) {
  const element = $('#nav-pending');

  element.textContent = number(count);
  element.hidden = !count;
}

function renderStats(data) {
  const metrics = data.metrics;

  const cards = [
    ['Registered users', metrics.users, 'All registered accounts', '◎'],
    ['Active users', metrics.activeUsers,
      `${number(metrics.disabledUsers)} disabled accounts`, '◉'],
    ['Pending invitations', metrics.pendingRequests,
      'Requests waiting for review', '✉'],
    ['Total recordings', metrics.recordings,
      'Saved recording records', '▷'],
    ['Completed recordings', metrics.completedRecordings,
      'Recognized completion statuses', '✓'],
    ['Video uploads ready', metrics.readyMedia,
      data.mediaAvailable ? 'Media marked ready' : 'Media data unavailable', '↑']
  ];

  $('#overview-stats').innerHTML = cards.map(
    ([label, value, note, symbol]) => `
      <article class="stat-card">
        <span class="stat-decoration" aria-hidden="true">${symbol}</span>
        <span class="stat-label">${esc(label)}</span>
        <strong class="stat-value">${number(value)}</strong>
        <span class="stat-note">${esc(note)}</span>
      </article>
    `
  ).join('');

  setPending(metrics.pendingRequests);
}

function renderChart(selector, rows, label, color) {
  const container = $(selector);

  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No chart data available.</div>';
    return;
  }

  const values = rows.map(row => Number(row.value) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);

  const width = 600;
  const height = 210;
  const left = 34;
  const right = 16;
  const top = 16;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const maximum = Math.max(1, ...values);

  const points = values.map((value, index) => {
    const x = left + index * plotWidth / Math.max(1, values.length - 1);
    const y = top + plotHeight - value / maximum * plotHeight;

    return { x, y, value, date: rows[index].date };
  });

  const polyline = points.map(point => `${point.x},${point.y}`).join(' ');
  const baseline = top + plotHeight;

  const area = [
    `${points[0].x},${baseline}`,
    polyline,
    `${points.at(-1).x},${baseline}`
  ].join(' ');

  const grid = [0, .5, 1].map(fraction => {
    const y = top + plotHeight - fraction * plotHeight;
    const value = Math.round(maximum * fraction);

    return `
      <line
        x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"
        stroke="#263650" stroke-dasharray="3 5"
      />
      <text x="${left - 8}" y="${y + 4}" text-anchor="end"
        fill="#7e94b4" font-size="10">${value}</text>
    `;
  }).join('');

  const indices = [...new Set([
    0,
    Math.floor((rows.length - 1) / 2),
    rows.length - 1
  ])];

  const labels = indices.map(index => {
    const point = points[index];

    return `
      <text
        x="${point.x}" y="${height - 9}"
        text-anchor="middle" fill="#7e94b4" font-size="10"
      >${esc(point.date.slice(5))}</text>
    `;
  }).join('');

  container.innerHTML = `
    <div class="chart-summary">
      ${number(total)}
      <small>${esc(label)} in this period</small>
    </div>

    <svg
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="${esc(label)} over the last 30 days; total ${total}"
    >
      ${grid}

      <polygon points="${area}" fill="${color}" fill-opacity=".09"></polygon>

      <polyline
        points="${polyline}"
        fill="none"
        stroke="${color}"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></polyline>

      ${points.map(point => `
        <circle
          cx="${point.x}" cy="${point.y}" r="3"
          fill="${color}"
        >
          <title>${esc(point.date)}: ${point.value}</title>
        </circle>
      `).join('')}

      ${labels}
    </svg>
  `;
}

function renderBreakdown(selector, rows) {
  const container = $(selector);

  if (!rows.length) {
    container.innerHTML = '<p class="muted">No records available.</p>';
    return;
  }

  const maximum = Math.max(1, ...rows.map(row => row.count));

  container.innerHTML = rows.map(row => `
    <div class="breakdown-row">
      <span class="breakdown-name">${esc(row.status)}</span>
      <strong class="breakdown-count">${number(row.count)}</strong>

      <div class="breakdown-track">
        <div
          class="breakdown-fill"
          style="--width:${Math.round(row.count / maximum * 100)}%"
        ></div>
      </div>
    </div>
  `).join('');
}

function selectedDevices() {
  const selections = new Map();

  $('#admin-requests').querySelectorAll('[data-id]').forEach(card => {
    selections.set(
      card.dataset.id,
      [...card.querySelectorAll('input:checked')].map(input => input.value)
    );
  });

  return selections;
}

function renderRequests() {
  const savedSelections = selectedDevices();
  const query = $('#request-search').value.trim().toLowerCase();
  const status = $('#request-status').value;

  const rows = state.requests.filter(request =>
    (!query || `${request.name} ${request.email}`.toLowerCase().includes(query)) &&
    (!status || request.status === status)
  );

  $('#email-warning').hidden = state.emailConfigured;

  $('#admin-requests').innerHTML = rows.map(request => {
    const rejected = request.status === 'rejected';
    const selected = savedSelections.get(request.id) || [];

    const devices = state.devices.map(device => `
      <label class="device-choice">
        <input
          type="checkbox"
          value="${esc(device.device_id)}"
          ${selected.includes(device.device_id) ? 'checked' : ''}
        >

        <span>
          <strong>${esc(device.camera_name || 'Recording device')}</strong>
          <small>${esc(device.device_id)}</small>
        </span>
      </label>
    `).join('');

    return `
      <article class="request-card" data-id="${esc(request.id)}">
        <div class="request-person">
          <span class="avatar" aria-hidden="true">
            ${esc(String(request.name || '?').slice(0, 1).toUpperCase())}
          </span>

          <div>
            <h2>${esc(request.name)}</h2>
            <span class="request-email">${esc(request.email)}</span>
          </div>
        </div>

        <div class="request-meta">
          ${badge(request.status)}
          <span class="request-date">${esc(dateLabel(request.created_at))}</span>
        </div>

        ${request.last_error ? `
          <p class="request-error">${esc(request.last_error)}</p>
        ` : ''}

        <fieldset ${rejected ? 'disabled' : ''}>
          <legend>Assign devices</legend>
          ${devices || `
            <p class="muted">
              No synced device IDs. Process or sync a recording in Python first.
            </p>
          `}
        </fieldset>

        ${rejected ? `
          <p class="muted">This request was rejected.</p>
        ` : `
          <div class="request-actions">
            <button
              type="button"
              class="button button-primary"
              data-send
              ${!state.emailConfigured || !state.devices.length ? 'disabled' : ''}
            >
              ${request.status === 'approved' ? 'Resend invitation' : 'Send invitation'}
            </button>

            ${['pending', 'failed'].includes(request.status) ? `
              <button
                type="button"
                class="button button-quiet"
                data-reject
              >
                Reject
              </button>
            ` : ''}
          </div>
        `}
        <div class="request-actions">
          <button type="button" class="button invitation-delete" data-delete-invitation
            ${request.status === 'sending' ? 'disabled' : ''}>Delete invitation</button>
        </div>
      </article>
    `;
  }).join('') || `
    <div class="empty-state">
      ${state.requests.length
        ? 'No requests match these filters.'
        : 'No invitation requests yet.'}
    </div>
  `;
}

function pagination(prefix, page, total) {
  const pages = Math.max(1, Math.ceil(total / state.pageSize));

  $(`#${prefix}-page-info`).textContent =
    `Page ${page} of ${pages} · ${number(total)} total`;

  $(`#${prefix}-prev`).disabled = page <= 1;
  $(`#${prefix}-next`).disabled = page >= pages;
}

function renderUsers() {
  const query = $('#user-search').value.trim().toLowerCase();

  const rows = state.users.filter(user =>
    !query ||
    `${user.name} ${user.email} ${(user.devices || []).join(' ')}`
      .toLowerCase()
      .includes(query)
  );

  $('#users-table-body').innerHTML = rows.map(user => `
    <tr>
      <td>
        <span class="cell-title">${esc(user.name)}</span>
        <span class="cell-subtitle">${esc(user.email)}</span>
      </td>

      <td>${badge(user.disabled ? 'Disabled' : 'Active')}</td>

      <td>
        ${(user.devices || []).map(device => `
          <span class="device-tag">${esc(device)}</span>
        `).join('') || '<span class="cell-subtitle">No devices assigned</span>'}
      </td>

      <td>${esc(dateLabel(user.created_at))}</td>
      <td class="user-actions-cell">
        <button type="button" class="button delete-user-button" data-delete-user="${esc(user.id)}">Delete user</button>
      </td>
    </tr>
  `).join('') || `
    <tr>
      <td colspan="5">
        ${query ? 'No matching users on this page.' : 'No users in this view.'}
      </td>
    </tr>
  `;

  pagination('users', state.usersPage, state.usersTotal);
}

function renderRecordings() {
  const query = $('#recording-search').value.trim().toLowerCase();

  const rows = state.recordings.filter(recording =>
    !query ||
    [
      recording.camera_name,
      recording.device_id,
      recording.status,
      recording.media?.status,
      recording.media?.detections_status
    ].join(' ').toLowerCase().includes(query)
  );

  $('#recordings-table-body').innerHTML = rows.map(recording => `
    <tr>
      <td>
        <span class="cell-title">
          ${esc(recording.camera_name || 'Unnamed recording')}
        </span>

        <span class="cell-subtitle">
          ${esc(recording.source_type || 'Source type not recorded')}
          · ${recording.duration_sec == null
            ? 'Duration unavailable'
            : Math.round(Number(recording.duration_sec) || 0) + ' sec'}
        </span>
      </td>

      <td>
        ${recording.device_id
          ? `<span class="device-tag">${esc(recording.device_id)}</span>`
          : '<span class="cell-subtitle">Not assigned</span>'}
      </td>

      <td>${badge(recording.status)}</td>
      <td>${badge(recording.media?.status || 'Not available')}</td>
      <td>${badge(recording.media?.detections_status || 'Not available')}</td>
      <td>${esc(dateLabel(recording.created_at))}</td>
    </tr>
  `).join('') || `
    <tr>
      <td colspan="6">
        ${query
          ? 'No matching recordings on this page.'
          : 'No recordings available.'}
      </td>
    </tr>
  `;

  pagination('recordings', state.recordingsPage, state.recordingsTotal);
}

async function loadCurrent() {
  if (!state.signedIn) return;

  const version = ++state.loadVersion;
  const page = state.page;

  $('#page-loading').hidden = false;
  $('#admin-content').setAttribute('aria-busy', 'true');
  $('#admin-refresh').disabled = true;

  try {
    if (page === 'overview') {
      const data = await api('overview');

      if (version !== state.loadVersion) return;

      renderStats(data);

      renderChart(
        '#users-chart',
        data.charts.users,
        'registrations',
        '#8ca6ff'
      );

      renderChart(
        '#recordings-chart',
        data.charts.recordings,
        'recordings added',
        '#66ccb7'
      );

      renderBreakdown('#recording-statuses', data.recordingStatuses);
      renderBreakdown('#invitation-statuses', data.invitationStatuses);

      $('#sidebar-company').textContent = data.company || 'SENTRA';

      $('#overview-note').textContent =
        `Charts use ${data.timezone}. Completed recordings count only saved ` +
        `statuses: ${data.completionStatuses.join(', ')}. ` +
        (data.mediaAvailable
          ? 'Processing and Drive upload statuses are independent.'
          : 'Media status data is currently unavailable.');
    }

    if (page === 'requests') {
      const data = await api('requests');

      if (version !== state.loadVersion) return;

      state.requests = data.requests || [];
      state.devices = data.devices || [];
      state.emailConfigured = Boolean(data.emailConfigured);

      renderRequests();
    }

    if (page === 'users') {
      const filter = $('#user-status').value;

      const data = await api(
        `users?page=${state.usersPage}` +
        `&status=${encodeURIComponent(filter)}`
      );

      if (version !== state.loadVersion) return;

      state.users = data.users;
      state.usersPage = data.page;
      state.usersTotal = data.total;
      state.pageSize = data.pageSize;

      renderUsers();
    }

    if (page === 'recordings') {
      const data = await api(`recordings?page=${state.recordingsPage}`);

      if (version !== state.loadVersion) return;

      state.recordings = data.recordings;
      state.recordingsPage = data.page;
      state.recordingsTotal = data.total;
      state.pageSize = data.pageSize;

      renderRecordings();
    }

    if (version === state.loadVersion) updateTime();
  } finally {
    if (version === state.loadVersion) {
      $('#page-loading').hidden = true;
      $('#admin-content').setAttribute('aria-busy', 'false');
      $('#admin-refresh').disabled = false;
    }
  }
}

async function enterWorkspace(session) {
  state.signedIn = true;

  $('#admin-login').hidden = true;
  $('#admin-workspace').hidden = false;
  $('#admin-identity').textContent = session.email || '';

  notify('');
  displayPage();

  await loadCurrent();
}

$('#admin-login-form').addEventListener('submit', async event => {
  event.preventDefault();

  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  notify('');

  try {
    await api('login', Object.fromEntries(new FormData(event.target)));
    event.target.reset();

    const session = await api('session');

    await enterWorkspace(session);
  } catch (error) {
    handleError(error);
  } finally {
    button.disabled = false;
  }
});

$('#admin-logout').addEventListener('click', async () => {
  if (state.sending) {
    notify('Please wait for the invitation action to finish.');
    return;
  }

  const button = $('#admin-logout');
  button.disabled = true;

  try {
    if (window.sentraAdminPushDisable) await window.sentraAdminPushDisable();
    await api('logout', {});
    showLogin('You have signed out of company admin.');
    location.hash = 'overview';
  } catch (error) {
    handleError(error);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('[data-go]').forEach(button => {
  button.addEventListener('click', () => navigate(button.dataset.go));
});

window.addEventListener('hashchange', () => {
  if (!state.signedIn) return;

  displayPage();
  loadCurrent().catch(handleError);
});

$('#admin-refresh').addEventListener('click', () => {
  if (state.sending) {
    notify('Please wait for the invitation action to finish.');
    return;
  }

  notify('');
  loadCurrent().catch(handleError);
});

$('#mobile-menu').addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');

  $('#mobile-menu').setAttribute('aria-expanded', String(open));
});

$('#request-search').addEventListener('input', renderRequests);
$('#request-status').addEventListener('change', renderRequests);

$('#user-search').addEventListener('input', renderUsers);

$('#user-status').addEventListener('change', () => {
  state.usersPage = 1;
  loadCurrent().catch(handleError);
});

$('#recording-search').addEventListener('input', renderRecordings);

$('#users-prev').addEventListener('click', () => {
  state.usersPage = Math.max(1, state.usersPage - 1);
  loadCurrent().catch(handleError);
});

$('#users-next').addEventListener('click', () => {
  state.usersPage++;
  loadCurrent().catch(handleError);
});

$('#recordings-prev').addEventListener('click', () => {
  state.recordingsPage = Math.max(1, state.recordingsPage - 1);
  loadCurrent().catch(handleError);
});

$('#recordings-next').addEventListener('click', () => {
  state.recordingsPage++;
  loadCurrent().catch(handleError);
});

$('#admin-requests').addEventListener('click', async event => {
  const button = event.target.closest('[data-send], [data-reject], [data-delete-invitation]');

  if (!button || state.sending) return;

  const card = button.closest('[data-id]');
  if (!card) return;

  const deleting = button.hasAttribute('data-delete-invitation');
  const request = state.requests.find(item => item.id === card.dataset.id);
  if (deleting && !await confirmAction({title:'Delete invitation?',message:`Delete the request for ${request?.email || 'this email'}?\n\nUnused codes for this email will stop working. Existing accounts and recordings will remain.`,confirmLabel:'Delete invitation'})) return;
  const send = button.hasAttribute('data-send');

  const devices = [...card.querySelectorAll('input:checked')]
    .map(input => input.value);

  if (send && !devices.length) {
    notify('Select at least one device for this user.', true);
    return;
  }

  state.sending = true;
  button.disabled = true;

  notify(deleting ? 'Deleting invitation…' : send ? 'Sending invitation…' : 'Updating request…');

  try {
    const result = await api(
      `requests/${encodeURIComponent(card.dataset.id)}` +
      (deleting ? '/delete' : send ? '/send' : '/reject'),
      send ? { devices } : {}
    );

    const message = result.message || 'Request rejected.';

    await loadCurrent();
    notify(message);
  } catch (error) {
    handleError(error);
  } finally {
    state.sending = false;
    button.disabled = false;
  }
});

(async () => {
  try {
    const session = await api('session');
    await enterWorkspace(session);
  } catch (error) {
    handleError(error);
  }
})();
let deletingUser = false;

$('#users-table-body').addEventListener('click', async event => {
  const button = event.target.closest('[data-delete-user]');
  if (!button || deletingUser) return;

  const id = button.dataset.deleteUser;
  const user = state.users.find(item => item.id === id);
  if (!user) return;

  const confirmed = window.confirm(
    `Permanently delete ${user.email}?\n\n` +
    'Their account and linked access will be removed. ' +
    'Recordings and evidence will remain.'
  );

  if (!confirmed) return;

  deletingUser = true;
  button.disabled = true;

  try {
    await api(`users/${encodeURIComponent(id)}/delete`, {});

    state.users = state.users.filter(item => item.id !== id);
    state.usersTotal = Math.max(0, state.usersTotal - 1);
    renderUsers();

    notify('User deleted successfully.');

    try {
      await loadCurrent();
    } catch {
      notify(
        'User deleted, but refreshing the list failed. Click Refresh.',
        true
      );
    }
  } catch (error) {
    handleError(error);
  } finally {
    deletingUser = false;
    button.disabled = false;
  }
});
