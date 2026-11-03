'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const { hash, verify, passwordHash } = require('./auth');
const { UUID, pages } = require('./data');

const wrap = handler => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const validEmail = value =>
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const PAGE_SIZE = 50;
const SCAN_LIMIT = 50000;

const COMPLETION_STATUSES = [
  'completed',
  'processed',
  'finished',
  'done'
];

function attachAdmin(app, db, { env = process.env, fetcher = fetch } = {}) {
  const fail = (res, status, error) =>
    res.status(status).json({ ok: false, error });

  const adminEmail = () =>
    String(env.ADMIN_EMAIL || '').trim().toLowerCase();

  const configured = () =>
    validEmail(adminEmail()) &&
    typeof env.ADMIN_PASSWORD === 'string' &&
    env.ADMIN_PASSWORD.length >= 12 &&
    typeof env.ADMIN_SESSION_SECRET === 'string' &&
    env.ADMIN_SESSION_SECRET.length >= 32;

  const stamp = () =>
    hash(adminEmail() + ':' + env.ADMIN_PASSWORD);

  const sign = payload =>
    crypto
      .createHmac('sha256', env.ADMIN_SESSION_SECRET)
      .update(payload + ':' + stamp())
      .digest('hex');

  const cookie = 'sentra_company_admin';

  let passwordPromise;

  function authorized(req) {
    try {
      if (!configured()) return false;

      const token = (req.headers.cookie || '')
        .split(';')
        .map(value => value.trim())
        .find(value => value.startsWith(cookie + '='))
        ?.slice(cookie.length + 1) || '';

      const [expiration, nonce, signature, extra] = token.split('.');

      if (
        extra ||
        !/^\d+$/.test(expiration || '') ||
        !/^[a-f0-9]{32}$/.test(nonce || '') ||
        !Number.isFinite(Number(expiration)) ||
        Number(expiration) <= Date.now() ||
        Number(expiration) > Date.now() + 8 * 3600000 ||
        !/^[a-f0-9]{64}$/.test(signature || '')
      ) {
        return false;
      }

      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(sign(expiration + '.' + nonce))
      );
    } catch {
      return false;
    }
  }

  const requireAdmin = (req, res, next) =>
    authorized(req)
      ? next()
      : fail(res, 401, 'Company admin login required');

  require('./admin-push').attachAdminPush(app, db, {env, requireAdmin, identity: () => hash(adminEmail() + ':' + stamp())});

  async function limit(req, res, key, maximum, seconds = 600) {
    if (!db) {
      fail(res, 503, 'Database not configured');
      return false;
    }

    const result = await db.rpc('sentra_take_limit', {
      p_key: hash(key),
      p_max: maximum,
      p_seconds: seconds
    });

    if (result.error) throw result.error;

    if (!result.data) {
      fail(res, 429, 'Too many attempts. Please try again later.');
      return false;
    }

    return true;
  }

  /*
   * Read minimal explicit projections in stable pages.
   * If the safety limit is exceeded, return an error instead of a partial total.
   */
  async function readAll(table, fields, key = 'id') {
    if (!db) throw new Error('Database not configured');

    const rows = [];

    for (let offset = 0; offset <= SCAN_LIMIT; offset += 500) {
      const result = await db
        .from(table)
        .select(fields)
        .order(key)
        .range(offset, offset + 499);

      if (result.error) throw result.error;

      const batch = result.data || [];
      rows.push(...batch);

      if (rows.length > SCAN_LIMIT) {
        const error = new Error(
          'This overview exceeds its record safety limit. No partial total was shown.'
        );

        error.status = 413;
        throw error;
      }

      if (batch.length < 500) return rows;
    }

    throw new Error('Record safety limit exceeded');
  }

  function mediaTableMissing(error) {
    return ['42P01', 'PGRST205'].includes(error?.code);
  }

  async function allMedia() {
    try {
      return {
        available: true,
        rows: await readAll(
          'sentra_video_media',
          'source_id,status,detections_status',
          'source_id'
        )
      };
    } catch (error) {
      if (mediaTableMissing(error)) {
        return { available: false, rows: [] };
      }

      throw error;
    }
  }

  async function mediaForSources(ids) {
    if (!ids.length) return { available: true, rows: [] };

    const result = await db
      .from('sentra_video_media')
      .select('source_id,status,detections_status')
      .in('source_id', ids);

    if (result.error) {
      if (mediaTableMissing(result.error)) {
        return { available: false, rows: [] };
      }

      throw result.error;
    }

    return { available: true, rows: result.data || [] };
  }

  function breakdown(rows, field) {
    const counts = new Map();

    for (const row of rows) {
      const status = String(row[field] || 'unknown');
      counts.set(status, (counts.get(status) || 0) + 1);
    }

    return [...counts].map(([status, count]) => ({ status, count }))
      .sort((first, second) =>
        second.count - first.count ||
        first.status.localeCompare(second.status)
      );
  }

  function chartData(users, recordings) {
    let timezone = String(env.APP_TZ || 'Asia/Karachi');

    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      timezone = 'UTC';
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    function dateKey(value) {
      const date = new Date(value);

      if (!value || Number.isNaN(date.getTime())) return null;

      const parts = Object.fromEntries(
        formatter.formatToParts(date).map(part => [part.type, part.value])
      );

      return `${parts.year}-${parts.month}-${parts.day}`;
    }

    /*
     * Calendar labels are built from today's local date using UTC arithmetic.
     * This avoids duplicating or skipping chart dates around timezone changes.
     */
    const today = dateKey(new Date());
    const calendarDate = new Date(today + 'T12:00:00Z');

    const labels = [];

    for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
      labels.push(
        new Date(calendarDate.getTime() - daysAgo * 86400000)
          .toISOString()
          .slice(0, 10)
      );
    }

    function series(rows) {
      const counts = new Map(labels.map(label => [label, 0]));

      for (const row of rows) {
        const key = dateKey(row.created_at);

        if (counts.has(key)) {
          counts.set(key, counts.get(key) + 1);
        }
      }

      return labels.map(date => ({ date, value: counts.get(date) }));
    }

    return {
      timezone,
      users: series(users),
      recordings: series(recordings)
    };
  }

  function pageNumber(req) {
    const raw = Number(req.query.page || 1);

    return Number.isSafeInteger(raw) && raw > 0
      ? Math.min(raw, 1000000)
      : 1;
  }

  async function countedPage(makeQuery, requestedPage) {
    let page = requestedPage;

    async function read() {
      return makeQuery().range(
        (page - 1) * PAGE_SIZE,
        page * PAGE_SIZE - 1
      );
    }

    let result = await read();

    if (result.error) throw result.error;

    if (!Number.isSafeInteger(result.count) || result.count < 0) {
      throw new Error('Exact record count unavailable');
    }

    const maximumPage = Math.max(1, Math.ceil(result.count / PAGE_SIZE));

    if (page > maximumPage) {
      page = maximumPage;
      result = await read();

      if (result.error) throw result.error;

      if (!Number.isSafeInteger(result.count) || result.count < 0) {
        throw new Error('Exact record count unavailable');
      }
    }

    return {
      rows: result.data || [],
      total: result.count,
      page,
      pageSize: PAGE_SIZE
    };
  }

  /*
   * Public invitation request:
   * this only records a request; it does not issue a code or assign a device.
   */
  app.post('/api/company-admin/login', wrap(async (req, res) => {
    if (!configured()) {
      return fail(
        res,
        503,
        'Set ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters), ' +
        'and ADMIN_SESSION_SECRET (32+ characters) on the server.'
      );
    }

    if (!await limit(req, res, 'company-admin-login:' + req.ip, 10)) {
      return;
    }

    const password = String(req.body?.password || '');

    if (Buffer.byteLength(password) > 128) {
      return fail(res, 400, 'Invalid credentials');
    }

    passwordPromise ||= passwordHash(env.ADMIN_PASSWORD);

    const match = await verify(password, await passwordPromise);

    if (
      String(req.body?.email || '').trim().toLowerCase() !== adminEmail() ||
      !match
    ) {
      return fail(res, 401, 'Email or password is incorrect');
    }

    const payload =
      String(Date.now() + 8 * 3600000) +
      '.' +
      crypto.randomBytes(16).toString('hex');

    res.cookie(cookie, payload + '.' + sign(payload), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || String(env.PUBLIC_ORIGIN || '').startsWith('https://'),
      path: '/',
      maxAge: 8 * 3600000
    });

    res.json({ ok: true });
  }));

  app.get('/api/company-admin/session', requireAdmin, (req, res) =>
    res.json({ ok: true, email: adminEmail() })
  );

  app.post('/api/company-admin/logout', requireAdmin, (req, res) => {
    res.clearCookie(cookie, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || String(env.PUBLIC_ORIGIN || '').startsWith('https://')
    });

    res.json({ ok: true });
  });

  // New read-only admin overview.
  app.get(
    '/api/company-admin/overview',
    requireAdmin,
    wrap(async (req, res) => {
      const [users, recordings, requests, media] = await Promise.all([
        readAll(
          'sentra_dashboard_users',
          'id,disabled,created_at'
        ),
        readAll(
          'video_sources',
          'id,status,created_at'
        ),
        readAll(
          'sentra_invitation_requests',
          'id,status'
        ),
        allMedia()
      ]);

      const sourceIds = new Set(recordings.map(recording => recording.id));

      const readyMedia = media.rows.filter(row =>
        sourceIds.has(row.source_id) &&
        String(row.status || '').toLowerCase() === 'ready'
      ).length;

      const charts = chartData(users, recordings);

      res.json({
        ok: true,
        company: env.SENTRA_COMPANY_NAME || 'Nexora Solvex',
        timezone: charts.timezone,
        completionStatuses: COMPLETION_STATUSES,
        mediaAvailable: media.available,
        metrics: {
          users: users.length,
          activeUsers: users.filter(user => !user.disabled).length,
          disabledUsers: users.filter(user => user.disabled).length,
          pendingRequests: requests.filter(
            request => request.status === 'pending'
          ).length,
          recordings: recordings.length,
          completedRecordings: recordings.filter(recording =>
            COMPLETION_STATUSES.includes(
              String(recording.status || '').trim().toLowerCase()
            )
          ).length,
          readyMedia: media.available ? readyMedia : null
        },
        charts: {
          users: charts.users,
          recordings: charts.recordings
        },
        recordingStatuses: breakdown(recordings, 'status'),
        invitationStatuses: breakdown(requests, 'status'),
        generatedAt: new Date().toISOString()
      });
    })
  );

  // New read-only user directory. No password hashes are selected or returned.
  app.get(
    '/api/company-admin/users',
    requireAdmin,
    wrap(async (req, res) => {
      const filter = String(req.query.status || '');

      const result = await countedPage(() => {
        let query = db
          .from('sentra_dashboard_users')
          .select(
            'id,name,email,disabled,created_at',
            { count: 'exact' }
          )
          .order('created_at', { ascending: false })
          .order('id');

        if (filter === 'active') query = query.eq('disabled', false);
        if (filter === 'disabled') query = query.eq('disabled', true);

        return query;
      }, pageNumber(req));

      const ids = result.rows.map(user => user.id);

      const assignments = ids.length
        ? await pages(() =>
          db
            .from('sentra_user_devices')
            .select('user_id,device_id')
            .in('user_id', ids)
            .order('user_id')
            .order('device_id')
        )
        : [];

      const devices = new Map();

      for (const assignment of assignments) {
        if (!devices.has(assignment.user_id)) {
          devices.set(assignment.user_id, []);
        }

        devices.get(assignment.user_id).push(assignment.device_id);
      }

      res.json({
        ok: true,
        users: result.rows.map(user => ({
          ...user,
          devices: devices.get(user.id) || []
        })),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize
      });
    })
  );

  // New read-only recordings list; Drive file IDs remain server-only.
  app.get(
    '/api/company-admin/recordings',
    requireAdmin,
    wrap(async (req, res) => {
      const result = await countedPage(() =>
        db
          .from('video_sources')
          .select(
            'id,camera_name,device_id,source_type,status,created_at,duration_sec',
            { count: 'exact' }
          )
          .order('created_at', { ascending: false })
          .order('id'),
      pageNumber(req));

      const media = await mediaForSources(
        result.rows.map(recording => recording.id)
      );

      const bySource = new Map(
        media.rows.map(row => [
          row.source_id,
          {
            status: row.status,
            detections_status: row.detections_status
          }
        ])
      );

      res.json({
        ok: true,
        recordings: result.rows.map(recording => ({
          ...recording,
          media: bySource.get(recording.id) || null
        })),
        mediaAvailable: media.available,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize
      });
    })
  );

  // Existing invitation list endpoint.
  app.get(
    '/api/company-admin/requests',
    requireAdmin,
    wrap(async (req, res) => {
      const result = await db
        .from('sentra_invitation_requests')
        .select('id,name,email,status,created_at,approved_at,last_error')
        .order('created_at', { ascending: false })
        .order('id')
        .limit(200);

      if (result.error) throw result.error;

      const sources = await pages(() =>
        db
          .from('video_sources')
          .select('device_id,camera_name')
          .order('created_at', { ascending: false })
          .order('id')
      );

      const devices = [
        ...new Map(
          sources
            .filter(source => source.device_id)
            .map(source => [source.device_id, source])
        ).values()
      ];

      res.json({
        ok: true,
        requests: result.data || [],
        devices,
        emailConfigured: Boolean(
          env.BREVO_API_KEY &&
          env.BREVO_SENDER_EMAIL &&
          env.DASHBOARD_ORIGIN
        )
      });
    })
  );

  // Existing Send/Resend flow, with the same DB claim and Brevo integration.
  app.post(
    '/api/company-admin/requests/:id/send',
    requireAdmin,
    wrap(async (req, res) => {
      const id = req.params.id;
      const devices = req.body?.devices;

      if (
        !UUID.test(id) ||
        !Array.isArray(devices) ||
        !devices.length ||
        devices.length > 50 ||
        devices.some(device =>
          typeof device !== 'string' ||
          !device ||
          device.length > 128
        )
      ) {
        return fail(res, 400, 'Select at least one real device.');
      }

      if (
        !env.BREVO_API_KEY ||
        !env.BREVO_SENDER_EMAIL ||
        !env.DASHBOARD_ORIGIN
      ) {
        return fail(
          res,
          503,
          'Configure BREVO_API_KEY, BREVO_SENDER_EMAIL and DASHBOARD_ORIGIN first.'
        );
      }

      let origin;

      try {
        origin = new URL(env.DASHBOARD_ORIGIN);
      } catch {
        return fail(res, 503, 'DASHBOARD_ORIGIN is invalid');
      }

      if (!['http:', 'https:'].includes(origin.protocol)) {
        return fail(res, 503, 'DASHBOARD_ORIGIN is invalid');
      }

      const existing = await db
        .from('video_sources')
        .select('device_id')
        .in('device_id', devices);

      if (existing.error) throw existing.error;

      const assigned = [...new Set(devices)];

      if (assigned.some(device =>
        !(existing.data || []).some(source => source.device_id === device)
      )) {
        return fail(res, 400, 'Unknown device selected. Refresh the list.');
      }

      if (!await limit(req, res, 'company-admin-send:' + id, 10, 3600)) {
        return;
      }

      const claim = crypto.randomUUID();

      const claimed = await db.rpc('sentra_claim_invitation_request', {
        p_id: id,
        p_claim: claim
      });

      if (claimed.error) throw claimed.error;

      const request = claimed.data?.[0];

      if (!request) {
        return fail(
          res,
          409,
          'This request is being handled, was rejected, or no longer exists.'
        );
      }

      let invitation = null;

      try {
        const user = await db
          .from('sentra_dashboard_users')
          .select('id')
          .eq('email', request.email)
          .maybeSingle();

        if (user.error) throw user.error;

        if (user.data) {
          throw new Error('Account already exists. The user should log in.');
        }

        const code = crypto.randomBytes(32).toString('hex');
        invitation = hash(code);

        const inserted = await db
          .from('sentra_dashboard_invites')
          .insert({
            token_hash: invitation,
            email: request.email,
            devices: assigned,
            expires_at: new Date(
              Date.now() + 48 * 3600000
            ).toISOString()
          });

        if (inserted.error) throw inserted.error;

        const text =
          `Hello ${request.name},\n\n` +
          `Your SENTRA invitation is ready.\n\n` +
          `Register: ${origin.origin}/register\n` +
          `Email: ${request.email}\n` +
          `Invitation code: ${code}\n\n` +
          `Open Register, enter this same email and invitation code, ` +
          `your name, and choose a password of at least 12 characters. ` +
          `This code expires in 48 hours and can be used once. ` +
          `You will only see devices assigned by your company.\n\n` +
          `If you did not request access, ignore this email.\n` +
          `${env.SENTRA_COMPANY_NAME || 'Nexora Solvex'}`;

        const mail = await fetcher(
          'https://api.brevo.com/v3/smtp/email',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': env.BREVO_API_KEY
            },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              sender: {
                email: env.BREVO_SENDER_EMAIL,
                name: env.BREVO_SENDER_NAME || 'SENTRA'
              },
              to: [{ email: request.email }],
              subject: 'Your SENTRA invitation code',
              textContent: text
            })
          }
        );

        if (!mail.ok) {
          throw new Error(
            'Email provider rejected the send. ' +
            'Check sender verification, API key and quota.'
          );
        }

        const saved = await db
          .from('sentra_invitation_requests')
          .update({
            status: 'approved',
            approved_at: new Date().toISOString(),
            lease_until: null,
            last_error: null
          })
          .eq('id', id)
          .eq('claim_token', claim);

        if (saved.error) throw saved.error;

        return res.json({
          ok: true,
          message:
            'Invitation submitted to the email provider. ' +
            'Ask the user to check inbox/spam; delivery is not yet confirmed.'
        });
      } catch (error) {
        if (invitation) {
          await db
            .from('sentra_dashboard_invites')
            .delete()
            .eq('token_hash', invitation);
        }

        const reason =
          error.message === 'Account already exists. The user should log in.'
            ? error.message
            : 'Email send failed or could not be confirmed. ' +
              'Check email setup, then retry.';

        await db
          .from('sentra_invitation_requests')
          .update({
            status: 'failed',
            lease_until: null,
            last_error: reason
          })
          .eq('id', id)
          .eq('claim_token', claim);

        return fail(res, 503, reason);
      }
    })
  );

  app.post('/api/company-admin/requests/:id/delete', requireAdmin, wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 400, 'Invalid invitation request');
    const result = await db.rpc('sentra_delete_invitation_request', {p_id: req.params.id});
    if (result.error) throw result.error;
    if (!result.data?.ok) return fail(res, result.data?.reason === 'sending' ? 409 : 404,
      result.data?.reason === 'sending' ? 'Invitation is being sent. Wait for it to finish, then refresh.' : 'Invitation request not found. Refresh the list.');
    res.json({ok: true, message: 'Invitation request deleted. Unused codes for this email were invalidated. Existing accounts are preserved.'});
  }));

  // Existing Reject flow.
  app.post(
    '/api/company-admin/requests/:id/reject',
    requireAdmin,
    wrap(async (req, res) => {
      if (!UUID.test(req.params.id)) {
        return fail(res, 400, 'Invalid request');
      }

      const result = await db
        .from('sentra_invitation_requests')
        .update({ status: 'rejected', last_error: null })
        .eq('id', req.params.id)
        .in('status', ['pending', 'failed'])
        .select('id');

      if (result.error) throw result.error;

      if (!result.data?.length) {
        return fail(
          res,
          409,
          'Request already handled. Refresh the list.'
        );
      }

      res.json({ ok: true });
    })
  );
  app.post(
    '/api/company-admin/users/:id/delete',
    requireAdmin,
    wrap(async (req, res) => {
      const id = req.params.id;

      if (!UUID.test(id)) {
        return fail(res, 400, 'Invalid user ID');
      }

      const result = await db
        .from('sentra_dashboard_users')
        .delete()
        .eq('id', id)
        .select('id');

      if (result.error) throw result.error;

      if (!result.data?.length) {
        return fail(res, 404, 'User already deleted or not found.');
      }

      res.json({
        ok: true,
        message: 'User account deleted successfully.'
      });
    })
  );
  return { authorized };
}

module.exports = { attachAdmin };
