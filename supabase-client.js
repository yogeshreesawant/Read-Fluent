/**
 * READ FLUENT — SUPABASE CLIENT & BACKEND INTEGRATION SERVICE
 * 
 * Manages Supabase initialization, user authentication (login/signup/logout/password reset),
 * user-wise cloud documents and file storage, and administrative user management.
 */

(function () {
  'use strict';

  class SupabaseService {
    constructor() {
      this.client = null;
      this.currentUser = null;
      this.currentProfile = null;
      this.authListeners = [];
      this.storageKey = 'readfluent_supabase_config';
      this.cachedDocuments = [];

      this.init();
    }

    /**
     * Get active Supabase configuration (URL & Anon Key)
     */
    getConfig() {
      let url = '';
      let anonKey = '';

      // 1. Check window.READFLUENT_CONFIG
      if (window.READFLUENT_CONFIG && typeof window.READFLUENT_CONFIG === 'object') {
        url = (window.READFLUENT_CONFIG.SUPABASE_URL || '').trim();
        anonKey = (window.READFLUENT_CONFIG.SUPABASE_ANON_KEY || '').trim();
      }

      // 2. Check localStorage override
      try {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed.url && parsed.anonKey) {
            url = parsed.url.trim();
            anonKey = parsed.anonKey.trim();
          }
        }
      } catch (e) {
        console.warn('Could not read stored Supabase config:', e);
      }

      return { url, anonKey };
    }

    /**
     * Check if valid Supabase credentials have been configured
     */
    isConfigured() {
      const { url, anonKey } = this.getConfig();
      if (!url || !anonKey) return false;
      if (url.includes('your-project-id') || anonKey.includes('your-anon-public-key')) return false;
      return /^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(url);
    }

    /**
     * Save new credentials from in-app settings
     */
    saveCredentials(url, anonKey) {
      const trimmedUrl = (url || '').trim();
      const trimmedKey = (anonKey || '').trim();

      if (!trimmedUrl.startsWith('https://')) {
        throw new Error('Supabase Project URL must start with https://');
      }
      if (trimmedKey.length < 20) {
        throw new Error('Invalid Anon Key. Please check the key in your Supabase dashboard.');
      }

      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ url: trimmedUrl, anonKey: trimmedKey })
      );

      this.init();
      return true;
    }

    /**
     * Clear stored credentials
     */
    clearCredentials() {
      localStorage.removeItem(this.storageKey);
      this.client = null;
      this.currentUser = null;
      this.currentProfile = null;
      this.notifyAuthChange(null, null);
    }

    /**
     * Initialize the Supabase JS Client
     */
    init() {
      const { url, anonKey } = this.getConfig();

      if (!url || !anonKey || url.includes('your-project-id')) {
        this.client = null;
        return;
      }

      if (window.supabase && typeof window.supabase.createClient === 'function') {
        try {
          this.client = window.supabase.createClient(url, anonKey, {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true
            }
          });

          // Set up auth state change listener
          this.client.auth.onAuthStateChange(async (event, session) => {
            if (session && session.user) {
              this.currentUser = session.user;
              await this.fetchProfile();
            } else {
              this.currentUser = null;
              this.currentProfile = null;
            }
            this.notifyAuthChange(event, this.currentUser);
          });

          // Initial session check
          this.checkSession();
        } catch (e) {
          console.error('Failed to initialize Supabase client:', e);
          this.client = null;
        }
      } else {
        console.warn('Supabase JS SDK library not loaded on page.');
      }
    }

    async checkSession() {
      if (!this.client) return;
      try {
        const { data: { session }, error } = await this.client.auth.getSession();
        if (error) throw error;
        if (session && session.user) {
          this.currentUser = session.user;
          await this.fetchProfile();
          this.notifyAuthChange('SIGNED_IN', this.currentUser);
        }
      } catch (e) {
        console.error('Error checking active session:', e);
      }
    }

    /**
     * Fetch the user's profile and role ('user' or 'admin')
     */
    async fetchProfile() {
      if (!this.client || !this.currentUser) {
        this.currentProfile = null;
        return null;
      }

      try {
        const { data, error } = await this.client
          .from('profiles')
          .select('*')
          .eq('id', this.currentUser.id)
          .single();

        if (error) {
          console.warn('Profile fetch note:', error.message);
          // Fallback minimal profile
          this.currentProfile = {
            id: this.currentUser.id,
            email: this.currentUser.email,
            full_name: this.currentUser.user_metadata?.full_name || '',
            role: this.currentUser.user_metadata?.role || 'user'
          };
        } else {
          this.currentProfile = data;
        }

        return this.currentProfile;
      } catch (e) {
        console.error('Error fetching profile:', e);
        return null;
      }
    }

    onAuthStateChange(listener) {
      if (typeof listener === 'function') {
        this.authListeners.push(listener);
        // Immediately invoke with current state
        listener(this.currentUser ? 'SIGNED_IN' : 'SIGNED_OUT', this.currentUser, this.currentProfile);
      }
    }

    notifyAuthChange(event, user) {
      this.authListeners.forEach((fn) => {
        try {
          fn(event, user, this.currentProfile);
        } catch (err) {
          console.error('Auth listener error:', err);
        }
      });
    }

    isAuthenticated() {
      return !!this.currentUser;
    }

    isAdmin() {
      return !!(this.currentProfile && this.currentProfile.role === 'admin');
    }

    getUser() {
      return this.currentUser;
    }

    getProfile() {
      return this.currentProfile;
    }

    /* ========================================================================
       AUTH OPERATIONS (SIGNUP, LOGIN, LOGOUT, FORGOT PASSWORD, RESET PASSWORD)
       ======================================================================== */

    /**
     * Register a new user account
     */
    async signUp(email, password, fullName = '') {
      if (!this.client) throw new Error('Supabase is not configured.');

      const { data, error } = await this.client.auth.signUp({
        email: email.trim().toLowerCase(),
        password: password,
        options: {
          data: {
            full_name: fullName.trim(),
            role: 'user'
          }
        }
      });

      if (error) throw error;
      return data;
    }

    /**
     * Sign in existing user with email and password
     */
    async signIn(email, password) {
      if (!this.client) throw new Error('Supabase is not configured.');

      const { data, error } = await this.client.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password: password
      });

      if (error) throw error;

      this.currentUser = data.user;
      await this.fetchProfile();
      return data;
    }

    /**
     * Sign out current user
     */
    async signOut() {
      if (!this.client) return;
      const { error } = await this.client.auth.signOut();
      this.currentUser = null;
      this.currentProfile = null;
      this.cachedDocuments = [];
      if (error) throw error;
    }

    /**
     * Request password reset email
     */
    async resetPasswordForEmail(email) {
      if (!this.client) throw new Error('Supabase is not configured.');

      const redirectUrl = window.location.origin + window.location.pathname;
      const { data, error } = await this.client.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo: redirectUrl }
      );

      if (error) throw error;
      return data;
    }

    /**
     * Update user password (from recovery link or settings)
     */
    async updatePassword(newPassword) {
      if (!this.client) throw new Error('Supabase is not configured.');

      const { data, error } = await this.client.auth.updateUser({
        password: newPassword
      });

      if (error) throw error;
      return data;
    }

    /* ========================================================================
       USER-WISE DOCUMENTS & STORAGE OPERATIONS
       ======================================================================== */

    /**
     * Fetch user's documents from Supabase (Row Level Security ensures only user's docs)
     */
    async fetchUserDocuments() {
      if (!this.client || !this.currentUser) return [];

      try {
        const { data, error } = await this.client
          .from('documents')
          .select('*')
          .order('updated_at', { ascending: false });

        if (error) throw error;

        // Map database columns to application model
        this.cachedDocuments = (data || []).map((row) => ({
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
      } catch (e) {
        console.error('Error fetching user documents:', e);
        throw e;
      }
    }

    /**
     * Check if document title is taken by current user
     */
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

    /**
     * Upload an attached raw file to user-wise Supabase Storage
     */
    async uploadUserFile(fileBlob, docId) {
      if (!this.client || !this.currentUser || !fileBlob) return null;

      try {
        const fileExt = fileBlob.name.split('.').pop();
        const safeName = fileBlob.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = `${this.currentUser.id}/${docId}_${safeName}`;

        const { data, error } = await this.client.storage
          .from('user_documents')
          .upload(filePath, fileBlob, {
            cacheControl: '3600',
            upsert: true
          });

        if (error) {
          console.warn('Storage upload error (continuing with text body):', error);
          return null;
        }

        // Get public URL
        const { data: publicUrlData } = this.client.storage
          .from('user_documents')
          .getPublicUrl(filePath);

        return {
          fileUrl: publicUrlData ? publicUrlData.publicUrl : '',
          fileName: fileBlob.name,
          fileSize: fileBlob.size
        };
      } catch (err) {
        console.warn('File upload exception:', err);
        return null;
      }
    }

    /**
     * Save/upsert document to Supabase user documents
     */
    async saveDocument(docRecord, fileBlob = null) {
      if (!this.client || !this.currentUser) {
        throw new Error('You must be signed in to save documents to the cloud.');
      }

      const now = new Date();
      const docId = docRecord.id || `doc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      let fileInfo = null;
      if (fileBlob) {
        fileInfo = await this.uploadUserFile(fileBlob, docId);
      }

      const payload = {
        id: docId,
        user_id: this.currentUser.id,
        title: (docRecord.title || 'Untitled Document').trim(),
        content: docRecord.content || '',
        word_count: docRecord.wordCount || 0,
        char_count: docRecord.charCount || 0,
        progress_percent: docRecord.progressPercent || 0,
        active_sentence_index: docRecord.activeSentenceIndex || 0,
        speed: docRecord.speed || 1.0,
        voice_name: docRecord.voiceName || '',
        updated_at: now.toISOString()
      };

      if (fileInfo) {
        payload.file_url = fileInfo.fileUrl;
        payload.file_name = fileInfo.fileName;
        payload.file_size = fileInfo.fileSize;
      } else if (docRecord.fileUrl) {
        payload.file_url = docRecord.fileUrl;
        payload.file_name = docRecord.fileName;
        payload.file_size = docRecord.fileSize || 0;
      }

      const { data, error } = await this.client
        .from('documents')
        .upsert(payload)
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          // Unique constraint violation (duplicate title)
          const err = new Error(`DUPLICATE_TITLE: A file named "${payload.title}" already exists in your library.`);
          err.code = 'DUPLICATE_TITLE';
          throw err;
        }
        throw error;
      }

      // Update local cache
      const updatedItem = {
        id: docId,
        title: payload.title,
        content: payload.content,
        fileUrl: payload.file_url,
        fileName: payload.file_name,
        fileSize: payload.file_size,
        wordCount: payload.word_count,
        charCount: payload.char_count,
        progressPercent: payload.progress_percent,
        activeSentenceIndex: payload.active_sentence_index,
        speed: payload.speed,
        voiceName: payload.voice_name,
        createdAt: docRecord.createdAt || now.getTime(),
        updatedAt: now.getTime()
      };

      const idx = this.cachedDocuments.findIndex((d) => String(d.id) === String(docId));
      if (idx >= 0) {
        this.cachedDocuments[idx] = updatedItem;
      } else {
        this.cachedDocuments.unshift(updatedItem);
      }

      return docId;
    }

    /**
     * Delete document and optional storage file
     */
    async deleteDocument(docId) {
      if (!this.client || !this.currentUser) return false;

      try {
        const item = this.cachedDocuments.find((d) => String(d.id) === String(docId));

        // Delete from table
        const { error } = await this.client
          .from('documents')
          .delete()
          .eq('id', docId)
          .eq('user_id', this.currentUser.id);

        if (error) throw error;

        // Clean up storage file if it exists
        if (item && item.fileName) {
          const safeName = item.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = `${this.currentUser.id}/${docId}_${safeName}`;
          this.client.storage.from('user_documents').remove([filePath]).catch(() => {});
        }

        // Update local cache
        this.cachedDocuments = this.cachedDocuments.filter((d) => String(d.id) !== String(docId));
        return true;
      } catch (e) {
        console.error('Error deleting document from Supabase:', e);
        throw e;
      }
    }

    /**
     * Clear all documents for current user
     */
    async clearAllUserDocuments() {
      if (!this.client || !this.currentUser) return false;

      try {
        const { error } = await this.client
          .from('documents')
          .delete()
          .eq('user_id', this.currentUser.id);

        if (error) throw error;
        this.cachedDocuments = [];
        return true;
      } catch (e) {
        console.error('Error clearing documents:', e);
        throw e;
      }
    }

    /* ========================================================================
       ADMIN DASHBOARD OPERATIONS
       ======================================================================== */

    /**
     * Admin: List all registered users with system stats
     */
    async adminListUsers() {
      if (!this.client) throw new Error('Supabase client not initialized.');
      if (!this.isAdmin()) throw new Error('Administrator privileges required.');

      const { data, error } = await this.client.rpc('admin_list_users');
      if (error) throw error;
      return data || [];
    }

    /**
     * Admin: Create a new user account
     */
    async adminCreateUser(email, password, fullName = '', role = 'user') {
      if (!this.client) throw new Error('Supabase client not initialized.');
      if (!this.isAdmin()) throw new Error('Administrator privileges required.');

      const { data, error } = await this.client.rpc('admin_create_user', {
        p_email: email.trim().toLowerCase(),
        p_password: password,
        p_full_name: fullName.trim(),
        p_role: role
      });

      if (error) throw error;
      return data;
    }

    /**
     * Admin: Delete a user by ID
     */
    async adminDeleteUser(targetUserId) {
      if (!this.client) throw new Error('Supabase client not initialized.');
      if (!this.isAdmin()) throw new Error('Administrator privileges required.');

      const { data, error } = await this.client.rpc('admin_delete_user', {
        target_user_id: targetUserId
      });

      if (error) throw error;
      return data;
    }

    /**
     * Admin: Update user role (promote to admin or demote to user)
     */
    async adminUpdateUserRole(targetUserId, newRole) {
      if (!this.client) throw new Error('Supabase client not initialized.');
      if (!this.isAdmin()) throw new Error('Administrator privileges required.');

      const { data, error } = await this.client.rpc('admin_update_user_role', {
        target_user_id: targetUserId,
        new_role: newRole
      });

      if (error) throw error;
      return data;
    }

    /**
     * Admin: Inspect documents belonging to a specific user
     */
    async adminGetUserDocuments(targetUserId) {
      if (!this.client) throw new Error('Supabase client not initialized.');
      if (!this.isAdmin()) throw new Error('Administrator privileges required.');

      const { data, error } = await this.client.rpc('admin_get_user_documents', {
        target_user_id: targetUserId
      });

      if (error) throw error;
      return data || [];
    }
  }

  // Export singleton to window
  window.ReadFluentSupabase = new SupabaseService();
})();
