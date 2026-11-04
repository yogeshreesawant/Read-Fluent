/**
 * READ FLUENT — SECURE API CLIENT SERVICE
 * 
 * Supports Dual Mode:
 * 1. Direct Supabase Mode (Default for GitHub Pages — Zero external server / Render.com needed!)
 * 2. Proxy Server Mode (When running locally with node server.js or an optional proxy)
 */

(function () {
  'use strict';

  class ApiClient {
    constructor() {
      this.tokenKey = 'readfluent_session_token';
      this.userKey = 'readfluent_user_data';
      this.token = null;
      this.user = null;
      this.profile = null;
      this.cachedDocuments = [];

      this.loadConfig();
      this.loadSession();
    }

    loadConfig() {
      const cfg = window.READFLUENT_CONFIG || {};
      this.supabaseUrl = (cfg.SUPABASE_URL || '').trim().replace(/\/$/, '');
      this.supabaseKey = (cfg.SUPABASE_ANON_KEY || '').trim();
      this.backendBase = (window.READFLUENT_API_BASE || cfg.BACKEND_API_BASE || '').trim().replace(/\/$/, '');
    }

    loadSession() {
      try {
        this.token = localStorage.getItem(this.tokenKey) || null;
        const storedUser = localStorage.getItem(this.userKey);
        if (storedUser) {
          const parsed = JSON.parse(storedUser);
          this.user = parsed.user || null;
          this.profile = parsed.profile || (this.user ? this.user.profile : null) || null;
        }
      } catch (e) {
        console.warn('Could not read session from localStorage:', e);
      }
    }

    saveSession(token, user, profile = null) {
      this.token = token;
      this.user = user;
      this.profile = profile || (user ? user.profile : null);

      if (token) {
        localStorage.setItem(this.tokenKey, token);
      } else {
        localStorage.removeItem(this.tokenKey);
      }

      if (user) {
        localStorage.setItem(this.userKey, JSON.stringify({ user, profile: this.profile }));
      } else {
        localStorage.removeItem(this.userKey);
      }
    }

    clearSession() {
      this.token = null;
      this.user = null;
      this.profile = null;
      this.cachedDocuments = [];
      localStorage.removeItem(this.tokenKey);
      localStorage.removeItem(this.userKey);
    }

    isAuthenticated() {
      return !!this.token;
    }

    getUser() {
      return this.user;
    }

    getProfile() {
      return this.profile;
    }

    isAdmin() {
      return !!(this.profile && this.profile.role === 'admin');
    }

    isDirectSupabase() {
      // If a backend proxy URL is explicitly specified, use the proxy
      if (this.backendBase) return false;
      // On localhost, default to local server.js proxy if available
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return false;
      }
      // On GitHub Pages or static hosts: use direct Supabase!
      return !!(this.supabaseUrl && this.supabaseKey);
    }

    /* ========================================================================
       HTTP PROXY REQUEST HANDLER (used when proxy server is running)
       ======================================================================== */
    async request(endpoint, options = {}) {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      const url = `${this.backendBase}${endpoint}`;

      let response;
      try {
        response = await fetch(url, {
          method: options.method || 'GET',
          headers: headers,
          body: options.body ? JSON.stringify(options.body) : undefined
        });
      } catch (networkErr) {
        throw new Error('Network error: Could not reach the server.');
      }

      let data;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        if (response.status === 401 && !endpoint.includes('/api/auth/login')) {
          this.clearSession();
          if (!window.location.pathname.endsWith('login.html')) {
            window.location.replace('login.html');
          }
        }
        const errorMsg = (data && (data.error || data.message)) || `Server error (${response.status})`;
        const err = new Error(errorMsg);
        err.status = response.status;
        err.data = data;
        throw err;
      }

      return data;
    }

    /* ========================================================================
       AUTH ENDPOINTS
       ======================================================================== */
    async signup(email, password, fullName = '') {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/auth/v1/signup`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            password: password,
            data: { full_name: (fullName || '').trim(), role: 'user' }
          })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.msg || data.message || data.error_description || 'Signup failed');
        }
        return {
          user: data.user,
          session: data.session,
          message: data.session ? 'Sign up successful.' : 'Confirmation email sent.'
        };
      }

      return await this.request('/api/auth/signup', {
        method: 'POST',
        body: { email, password, fullName }
      });
    }

    async login(email, password) {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            password: password
          })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error_description || data.msg || data.message || 'Invalid email or password.');
        }

        // Fetch user profile safely with role
        let profile = null;
        try {
          const profRes = await fetch(`${this.supabaseUrl}/rest/v1/rpc/get_my_profile`, {
            method: 'POST',
            headers: {
              'apikey': this.supabaseKey,
              'Authorization': `Bearer ${data.access_token}`,
              'Content-Type': 'application/json'
            },
            body: '{}'
          });
          profile = await profRes.json();
        } catch (e) {
          profile = { id: data.user.id, email: data.user.email, role: 'user' };
        }

        this.saveSession(data.access_token, data.user, profile);
        return { ...data, user: { ...data.user, profile } };
      }

      const data = await this.request('/api/auth/login', {
        method: 'POST',
        body: { email, password }
      });

      if (data.access_token) {
        this.saveSession(data.access_token, data.user, data.user?.profile);
      }

      return data;
    }

    async checkSession() {
      if (!this.token) return null;

      if (this.isDirectSupabase()) {
        try {
          const userRes = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
            headers: {
              'apikey': this.supabaseKey,
              'Authorization': `Bearer ${this.token}`
            }
          });
          if (!userRes.ok) {
            this.clearSession();
            return null;
          }
          const user = await userRes.json();

          let profile = null;
          try {
            const profRes = await fetch(`${this.supabaseUrl}/rest/v1/rpc/get_my_profile`, {
              method: 'POST',
              headers: {
                'apikey': this.supabaseKey,
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
              },
              body: '{}'
            });
            profile = await profRes.json();
          } catch (e) {
            profile = { id: user.id, email: user.email, role: 'user' };
          }

          this.user = user;
          this.profile = profile;
          this.saveSession(this.token, this.user, this.profile);
          return this.user;
        } catch (e) {
          this.clearSession();
          return null;
        }
      }

      try {
        const data = await this.request('/api/auth/me');
        if (data.user) {
          this.user = data.user;
          this.profile = data.profile || data.user.profile;
          this.saveSession(this.token, this.user, this.profile);
          return this.user;
        }
      } catch (e) {
        this.clearSession();
        return null;
      }
    }

    async logout() {
      if (this.isDirectSupabase()) {
        try {
          await fetch(`${this.supabaseUrl}/auth/v1/logout`, {
            method: 'POST',
            headers: {
              'apikey': this.supabaseKey,
              'Authorization': `Bearer ${this.token}`
            }
          });
        } catch (e) {}
        this.clearSession();
        window.location.replace('login.html');
        return;
      }

      try {
        await this.request('/api/auth/logout', { method: 'POST' });
      } catch (e) {}
      this.clearSession();
      window.location.replace('login.html');
    }

    async forgotPassword(email) {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/auth/v1/recover`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email: email.trim().toLowerCase() })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.msg || data.message || 'Could not send recovery link');
        }
        return data;
      }

      return await this.request('/api/auth/forgot-password', {
        method: 'POST',
        body: { email }
      });
    }

    async updatePassword(password) {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
          method: 'PUT',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.msg || data.message || 'Could not update password');
        }
        return data;
      }

      return await this.request('/api/auth/update-password', {
        method: 'POST',
        body: { password }
      });
    }

    /* ========================================================================
       USER-WISE DOCUMENTS ENDPOINTS
       ======================================================================== */
    async getDocuments() {
      let rows = [];

      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/documents?order=updated_at.desc`, {
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`
          }
        });
        if (!res.ok) {
          if (res.status === 401) {
            this.clearSession();
            window.location.replace('login.html');
          }
          throw new Error(`Failed to load documents (${res.status})`);
        }
        rows = await res.json();
      } else {
        const data = await this.request('/api/documents');
        rows = data.documents || [];
      }

      this.cachedDocuments = (rows || []).map((row) => ({
        id: row.id,
        title: row.title,
        content: row.content,
        fileUrl: row.file_url,
        fileName: row.file_name,
        fileSize: row.file_size || 0,
        wordCount: row.word_count || 0,
        charCount: row.char_count || 0,
        progressPercent: Number(row.progress_percent) || 0,
        activeSentenceIndex: row.active_sentence_index || 0,
        speed: Number(row.speed) || 1.0,
        voiceName: row.voice_name || '',
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime()
      }));

      return this.cachedDocuments;
    }

    isTitleTaken(title, excludeId = null) {
      if (!title || typeof title !== 'string') return false;
      const normalized = title.trim().toLowerCase();
      return this.cachedDocuments.some((item) => {
        if (excludeId && String(item.id) === String(excludeId)) {
          return false;
        }
        return item.title && item.title.trim().toLowerCase() === normalized;
      });
    }

    async saveDocument(docRecord) {
      const title = (docRecord.title || '').trim();
      if (this.isTitleTaken(title, docRecord.id)) {
        const err = new Error(`DUPLICATE_TITLE: A file named "${title}" already exists in your library.`);
        err.code = 'DUPLICATE_TITLE';
        err.duplicateTitle = title;
        throw err;
      }

      const payload = {
        id: docRecord.id || `doc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        title: title,
        content: docRecord.content || '',
        word_count: docRecord.wordCount || 0,
        char_count: docRecord.charCount || 0,
        progress_percent: docRecord.progressPercent || 0,
        active_sentence_index: docRecord.activeSentenceIndex || 0,
        speed: docRecord.speed || 1.0,
        voice_name: docRecord.voiceName || '',
        file_url: docRecord.fileUrl || null,
        file_name: docRecord.fileName || null,
        file_size: docRecord.fileSize || 0,
        updated_at: new Date().toISOString()
      };

      if (this.isDirectSupabase()) {
        payload.user_id = this.user.id;
        const res = await fetch(`${this.supabaseUrl}/rest/v1/documents`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=representation'
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || `Failed to save document (${res.status})`);
        }
      } else {
        await this.request('/api/documents', {
          method: 'POST',
          body: payload
        });
      }

      const updatedItem = {
        id: payload.id,
        title: payload.title,
        content: payload.content,
        fileUrl: payload.file_url,
        fileName: payload.file_name,
        fileSize: payload.file_size || 0,
        wordCount: payload.word_count || 0,
        charCount: payload.char_count || 0,
        progressPercent: Number(payload.progress_percent) || 0,
        activeSentenceIndex: payload.active_sentence_index || 0,
        speed: Number(payload.speed) || 1.0,
        voiceName: payload.voice_name || '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const idx = this.cachedDocuments.findIndex((d) => String(d.id) === String(updatedItem.id));
      if (idx >= 0) {
        this.cachedDocuments[idx] = updatedItem;
      } else {
        this.cachedDocuments.unshift(updatedItem);
      }

      return updatedItem.id;
    }

    async deleteDocument(docId) {
      if (this.isDirectSupabase()) {
        await fetch(`${this.supabaseUrl}/rest/v1/documents?id=eq.${encodeURIComponent(docId)}`, {
          method: 'DELETE',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`
          }
        });
      } else {
        await this.request(`/api/documents/${encodeURIComponent(docId)}`, {
          method: 'DELETE'
        });
      }

      this.cachedDocuments = this.cachedDocuments.filter((d) => String(d.id) !== String(docId));
      return true;
    }

    async clearAllDocuments() {
      if (this.isDirectSupabase()) {
        await fetch(`${this.supabaseUrl}/rest/v1/documents?user_id=eq.${encodeURIComponent(this.user.id)}`, {
          method: 'DELETE',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`
          }
        });
      } else {
        await this.request('/api/documents', {
          method: 'DELETE'
        });
      }
      this.cachedDocuments = [];
      return true;
    }

    /* ========================================================================
       ADMIN ENDPOINTS
       ======================================================================== */
    async adminListUsers() {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/rpc/admin_list_users`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: '{}'
        });
        if (!res.ok) throw new Error(`Admin list failed (${res.status})`);
        return await res.json();
      }
      const data = await this.request('/api/admin/users');
      return data.users || [];
    }

    async adminCreateUser(email, password, fullName = '', role = 'user') {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/rpc/admin_create_user`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            p_email: email.trim().toLowerCase(),
            p_password: password,
            p_full_name: fullName.trim(),
            p_role: role
          })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || 'Failed to create user');
        }
        return await res.json();
      }

      const data = await this.request('/api/admin/users', {
        method: 'POST',
        body: { email, password, fullName, role }
      });
      return data.user;
    }

    async adminDeleteUser(targetUserId) {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/rpc/admin_delete_user`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ target_user_id: targetUserId })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || 'Failed to delete user');
        }
        return true;
      }

      return await this.request(`/api/admin/users/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE'
      });
    }

    async adminUpdateUserRole(targetUserId, newRole) {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/rpc/admin_update_user_role`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ target_user_id: targetUserId, new_role: newRole })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || 'Failed to update user role');
        }
        return true;
      }

      return await this.request(`/api/admin/users/${encodeURIComponent(targetUserId)}/role`, {
        method: 'PATCH',
        body: { role: newRole }
      });
    }

    async adminGetUserDocuments(targetUserId) {
      if (this.isDirectSupabase()) {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/rpc/admin_get_user_documents`, {
          method: 'POST',
          headers: {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ target_user_id: targetUserId })
        });
        if (!res.ok) throw new Error('Could not fetch user documents');
        return await res.json();
      }

      const data = await this.request(`/api/admin/users/${encodeURIComponent(targetUserId)}/documents`);
      return data.documents || [];
    }
  }

  window.ReadFluentAPI = new ApiClient();
})();
