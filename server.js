/**
 * READ FLUENT — SECURE BACKEND PROXY SERVER
 * 
 * Features:
 * 1. Complete protection of Supabase credentials:
 *    - SUPABASE_URL and SUPABASE_KEY live exclusively in server-side .env
 *    - Zero API keys or Supabase URLs are ever sent to or exposed in the browser
 * 2. Static file server for ReadFluent (index.html, login.html, style.css, app.js, etc.)
 * 3. Secure /api endpoints for Authentication, Documents, and Admin user management
 * 4. Zero external npm dependencies: runs on native Node.js (18+)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 1. Load .env file into process.env if present
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      });
    } catch (e) {
      console.warn('Could not read .env file:', e.message);
    }
  }
}

loadEnv();

const PORT = parseInt(process.env.PORT || '8080', 10);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

// MIME Types map
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

// Helper: send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Helper: read request JSON body
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) { // 25MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper: proxy call to Supabase API (URL and KEY stay on server)
async function callSupabase(endpoint, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase is not configured on the backend server. Check your .env file.');
  }

  const url = `${SUPABASE_URL}${endpoint}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const errorMsg = (data && (data.msg || data.message || data.error_description || data.error)) || `Supabase error (${response.status})`;
    const err = new Error(errorMsg);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

// Helper: get bearer token from Authorization header
function getBearerToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

// Helper: get authenticated user info from token
async function getAuthUser(token) {
  if (!token) return null;
  return await callSupabase('/auth/v1/user', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

// Helper: fetch user profile with role safely (tries RPC get_my_profile first, then direct query)
async function fetchUserProfile(userId, email, token) {
  try {
    const rpcProfile = await callSupabase('/rest/v1/rpc/get_my_profile', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: {}
    });
    if (rpcProfile && rpcProfile.id) {
      return rpcProfile;
    }
  } catch (rpcErr) {
    // Fall back to direct table select
  }

  try {
    const profiles = await callSupabase(`/rest/v1/profiles?id=eq.${userId}&select=id,email,full_name,role`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (profiles && profiles[0]) {
      return profiles[0];
    }
  } catch (tableErr) {
    console.error(`Profile fetch warning for user ${email}:`, tableErr.message);
  }

  return { id: userId, email: email, role: 'user' };
}

// Helper: serve static files
function serveStaticFile(req, res, filePath) {
  let cleanPath = decodeURIComponent(filePath.split('?')[0]);
  if (cleanPath === '/' || cleanPath === '') {
    cleanPath = '/index.html';
  }

  let resolvedPath = path.normalize(path.join(__dirname, cleanPath));

  // Security: prevent directory traversal
  if (!resolvedPath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  const baseName = path.basename(resolvedPath).toLowerCase();

  // Strict security guard: NEVER serve sensitive files, hidden files, server scripts, or DB schemas
  if (
    baseName.startsWith('.') ||
    baseName === 'server.js' ||
    baseName.endsWith('.env') ||
    baseName.endsWith('.sql') ||
    baseName.endsWith('.log')
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden: Access denied.');
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size
    });

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  });
}

// ============================================================================
// MAIN HTTP SERVER & API ROUTER
// ============================================================================
const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // --------------------------------------------------------------------------
  // API ROUTES (/api/*)
  // --------------------------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    try {
      // 1. Health / Config Status check (NEVER exposes URL or Key!)
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, {
          configured: !!(SUPABASE_URL && SUPABASE_KEY),
          version: '1.0.0',
          authType: 'supabase_proxy'
        });
      }

      // 2. Auth: Sign Up
      if (pathname === '/api/auth/signup' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { email, password, fullName } = body;

        if (!email || !password) {
          return sendJson(res, 400, { error: 'Email and password are required.' });
        }

        const data = await callSupabase('/auth/v1/signup', {
          method: 'POST',
          body: {
            email: email.trim().toLowerCase(),
            password: password,
            data: { full_name: (fullName || '').trim(), role: 'user' }
          }
        });

        return sendJson(res, 200, {
          user: data.user,
          session: data.session,
          message: data.session ? 'Sign up successful.' : 'Confirmation email sent.'
        });
      }

      // 3. Auth: Login
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { email, password } = body;

        if (!email || !password) {
          return sendJson(res, 400, { error: 'Email and password are required.' });
        }

        const data = await callSupabase('/auth/v1/token?grant_type=password', {
          method: 'POST',
          body: {
            email: email.trim().toLowerCase(),
            password: password
          }
        });

        // Retrieve user profile to include role
        const profile = await fetchUserProfile(data.user.id, data.user.email, data.access_token);

        return sendJson(res, 200, {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_in: data.expires_in,
          user: { ...data.user, profile: profile }
        });
      }

      // 4. Auth: Get Current User Profile (Me)
      if (pathname === '/api/auth/me' && req.method === 'GET') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Authentication required' });

        const user = await getAuthUser(token);
        if (!user) return sendJson(res, 401, { error: 'Invalid or expired session' });

        // Get user profile with role
        const profile = await fetchUserProfile(user.id, user.email, token);

        return sendJson(res, 200, { user, profile });
      }

      // 5. Auth: Logout
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const token = getBearerToken(req);
        if (token) {
          try {
            await callSupabase('/auth/v1/logout', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` }
            });
          } catch (e) {
            // Ignore error on logout
          }
        }
        return sendJson(res, 200, { message: 'Logged out successfully' });
      }

      // 6. Auth: Forgot Password
      if (pathname === '/api/auth/forgot-password' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { email } = body;
        if (!email) return sendJson(res, 400, { error: 'Email is required.' });

        const redirectUrl = body.redirectTo || `${req.headers.origin || `http://${req.headers.host}`}/login.html`;
        await callSupabase('/auth/v1/recover', {
          method: 'POST',
          body: { email: email.trim().toLowerCase(), redirect_to: redirectUrl }
        });

        return sendJson(res, 200, { message: 'Password recovery email sent.' });
      }

      // 7. Auth: Update / Reset Password
      if (pathname === '/api/auth/update-password' && req.method === 'POST') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Authentication required.' });

        const body = await readJsonBody(req);
        const { password } = body;
        if (!password || password.length < 6) {
          return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
        }

        const data = await callSupabase('/auth/v1/user', {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}` },
          body: { password }
        });

        return sendJson(res, 200, { message: 'Password updated successfully.', user: data });
      }

      // 8. Documents: List User Documents
      if (pathname === '/api/documents' && req.method === 'GET') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Authentication required.' });

        const docs = await callSupabase('/rest/v1/documents?order=updated_at.desc', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        return sendJson(res, 200, { documents: docs || [] });
      }

      // 9. Documents: Save / Upsert Document
      if (pathname === '/api/documents' && req.method === 'POST') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Authentication required.' });

        const user = await getAuthUser(token);
        if (!user) return sendJson(res, 401, { error: 'Invalid user token' });

        const doc = await readJsonBody(req);
        const payload = {
          id: doc.id || `doc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          user_id: user.id,
          title: (doc.title || 'Untitled Document').trim(),
          content: doc.content || '',
          file_url: doc.fileUrl || null,
          file_name: doc.fileName || null,
          file_size: doc.fileSize || 0,
          word_count: doc.wordCount || 0,
          char_count: doc.charCount || 0,
          progress_percent: doc.progressPercent || 0,
          active_sentence_index: doc.activeSentenceIndex || 0,
          speed: doc.speed || 1.0,
          voice_name: doc.voiceName || '',
          updated_at: new Date().toISOString()
        };

        const result = await callSupabase('/rest/v1/documents', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Prefer': 'resolution=merge-duplicates,return=representation'
          },
          body: payload
        });

        return sendJson(res, 200, { document: result && result[0] ? result[0] : payload });
      }

      // 10. Documents: Delete Single Document
      if (pathname.startsWith('/api/documents/') && req.method === 'DELETE') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Authentication required.' });

        const docId = pathname.slice('/api/documents/'.length);
        await callSupabase(`/rest/v1/documents?id=eq.${encodeURIComponent(docId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        return sendJson(res, 200, { success: true });
      }

      // 11. Documents: Clear All Documents for User
      if (pathname === '/api/documents' && req.method === 'DELETE') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Authentication required.' });

        const user = await getAuthUser(token);
        if (!user) return sendJson(res, 401, { error: 'Invalid user token' });

        await callSupabase(`/rest/v1/documents?user_id=eq.${user.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        return sendJson(res, 200, { success: true });
      }

      // 12. Admin: List Users
      if (pathname === '/api/admin/users' && req.method === 'GET') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Admin privileges required' });

        const users = await callSupabase('/rest/v1/rpc/admin_list_users', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: {}
        });

        return sendJson(res, 200, { users: users || [] });
      }

      // 13. Admin: Create User
      if (pathname === '/api/admin/users' && req.method === 'POST') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Admin privileges required' });

        const body = await readJsonBody(req);
        const result = await callSupabase('/rest/v1/rpc/admin_create_user', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: {
            p_email: body.email,
            p_password: body.password,
            p_full_name: body.fullName || '',
            p_role: body.role || 'user'
          }
        });

        return sendJson(res, 200, { user: result });
      }

      // 14. Admin: Delete User
      if (pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Admin privileges required' });

        const targetUserId = pathname.slice('/api/admin/users/'.length);
        await callSupabase('/rest/v1/rpc/admin_delete_user', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: { target_user_id: targetUserId }
        });

        return sendJson(res, 200, { success: true });
      }

      // 15. Admin: Update User Role
      if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/role') && req.method === 'PATCH') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Admin privileges required' });

        const targetUserId = pathname.split('/')[4];
        const body = await readJsonBody(req);

        await callSupabase('/rest/v1/rpc/admin_update_user_role', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: { target_user_id: targetUserId, new_role: body.role }
        });

        return sendJson(res, 200, { success: true });
      }

      // 16. Admin: Get User Documents
      if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/documents') && req.method === 'GET') {
        const token = getBearerToken(req);
        if (!token) return sendJson(res, 401, { error: 'Admin privileges required' });

        const targetUserId = pathname.split('/')[4];
        const docs = await callSupabase('/rest/v1/rpc/admin_get_user_documents', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: { target_user_id: targetUserId }
        });

        return sendJson(res, 200, { documents: docs || [] });
      }

      return sendJson(res, 404, { error: 'API route not found' });
    } catch (err) {
      console.error(`API Error [${req.method} ${pathname}]:`, err.message);
      return sendJson(res, err.status || 500, { error: err.message || 'Server error' });
    }
  }

  // --------------------------------------------------------------------------
  // STATIC FILE SERVING
  // --------------------------------------------------------------------------
  serveStaticFile(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`🚀 Read Fluent Server running at: http://localhost:${PORT}`);
  console.log(`🔒 Supabase Backend: ${SUPABASE_URL ? 'Connected (Credentials Hidden)' : 'Not Configured in .env'}`);
  console.log(`🔑 Client Security: Zero Supabase API keys exposed to browser`);
  console.log(`================================================================`);
});
