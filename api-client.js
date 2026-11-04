/**
 * READ FLUENT — SECURE API CLIENT SERVICE
 * 
 * Interacts with the backend proxy server (/api/*) so that:
 * 1. ZERO Supabase URLs or API keys are ever stored or exposed in the frontend.
 * 2. Only authenticated users with verified JWT sessions can access index.html.
 * 3. User-isolated documents are retrieved securely by session token.
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

      this.loadSession();
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

    async request(endpoint, options = {}) {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      let response;
      try {
        response = await fetch(endpoint, {
          method: options.method || 'GET',
          headers: headers,
          body: options.body ? JSON.stringify(options.body) : undefined
        });
      } catch (networkErr) {
        throw new Error('Network error: Could not reach the server. Make sure the backend server is running (run: node server.js).');
      }

      let data;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        // If 401 Unauthorized, token might be expired
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
      const data = await this.request('/api/auth/signup', {
        method: 'POST',
        body: { email, password, fullName }
      });
      return data;
    }

    async login(email, password) {
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
      try {
        await this.request('/api/auth/logout', { method: 'POST' });
      } catch (e) {
        // Continue logout locally even if request fails
      }
      this.clearSession();
      window.location.replace('login.html');
    }

    async forgotPassword(email) {
      return await this.request('/api/auth/forgot-password', {
        method: 'POST',
        body: { email }
      });
    }

    async updatePassword(password) {
      return await this.request('/api/auth/update-password', {
        method: 'POST',
        body: { password }
      });
    }

    /* ========================================================================
       USER-WISE DOCUMENTS ENDPOINTS
       ======================================================================== */
    async getDocuments() {
      const data = await this.request('/api/documents');
      const rows = data.documents || [];

      this.cachedDocuments = rows.map((row) => ({
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
        id: docRecord.id || null,
        title: title,
        content: docRecord.content || '',
        wordCount: docRecord.wordCount || 0,
        charCount: docRecord.charCount || 0,
        progressPercent: docRecord.progressPercent || 0,
        activeSentenceIndex: docRecord.activeSentenceIndex || 0,
        speed: docRecord.speed || 1.0,
        voiceName: docRecord.voiceName || '',
        fileUrl: docRecord.fileUrl || null,
        fileName: docRecord.fileName || null,
        fileSize: docRecord.fileSize || 0
      };

      const data = await this.request('/api/documents', {
        method: 'POST',
        body: payload
      });

      const savedDoc = data.document;
      const updatedItem = {
        id: savedDoc.id,
        title: savedDoc.title,
        content: savedDoc.content,
        fileUrl: savedDoc.file_url,
        fileName: savedDoc.file_name,
        fileSize: savedDoc.file_size || 0,
        wordCount: savedDoc.word_count || 0,
        charCount: savedDoc.char_count || 0,
        progressPercent: Number(savedDoc.progress_percent) || 0,
        activeSentenceIndex: savedDoc.active_sentence_index || 0,
        speed: Number(savedDoc.speed) || 1.0,
        voiceName: savedDoc.voice_name || '',
        createdAt: new Date(savedDoc.created_at || Date.now()).getTime(),
        updatedAt: new Date(savedDoc.updated_at || Date.now()).getTime()
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
      await this.request(`/api/documents/${encodeURIComponent(docId)}`, {
        method: 'DELETE'
      });
      this.cachedDocuments = this.cachedDocuments.filter((d) => String(d.id) !== String(docId));
      return true;
    }

    async clearAllDocuments() {
      await this.request('/api/documents', {
        method: 'DELETE'
      });
      this.cachedDocuments = [];
      return true;
    }

    /* ========================================================================
       ADMIN ENDPOINTS
       ======================================================================== */
    async adminListUsers() {
      const data = await this.request('/api/admin/users');
      return data.users || [];
    }

    async adminCreateUser(email, password, fullName = '', role = 'user') {
      const data = await this.request('/api/admin/users', {
        method: 'POST',
        body: { email, password, fullName, role }
      });
      return data.user;
    }

    async adminDeleteUser(targetUserId) {
      return await this.request(`/api/admin/users/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE'
      });
    }

    async adminUpdateUserRole(targetUserId, newRole) {
      return await this.request(`/api/admin/users/${encodeURIComponent(targetUserId)}/role`, {
        method: 'PATCH',
        body: { role: newRole }
      });
    }

    async adminGetUserDocuments(targetUserId) {
      const data = await this.request(`/api/admin/users/${encodeURIComponent(targetUserId)}/documents`);
      return data.documents || [];
    }
  }

  window.ReadFluentAPI = new ApiClient();
})();
