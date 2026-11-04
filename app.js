/**
 * ============================================================================
 * READ FLUENT — ADVANCED SPEECH & DOCUMENT STUDIO
 * Features:
 * - Chunked 1GB file reading (TXT, PDF, Word DOCX) with memory-safe progress
 * - Web Speech API engine with sentence queueing & Chrome 15s timeout bypass
 * - Sleek zero-lag seek scrubber & real-time word/sentence karaoke sync
 * - Sleek speed slider (0.5x - 3.0x) with instant seamless rate switching
 * - Play, Stop, +15s Forward, -15s Backward, Save to Library
 * - High-capacity LocalStorage library storage with instant save & audio replay
 * ============================================================================
 */

(function () {
  'use strict';

  // Configure PDF.js worker if available
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ==========================================================================
     1. STORAGE ENGINE (USER-WISE ISOLATED CLOUD VIA SECURE API CLIENT)
     ========================================================================== */
  class LibraryStore {
    constructor() {
      this.storageKey = 'readfluent_library_items_v1';
    }

    isCloudActive() {
      return !!(window.ReadFluentAPI && window.ReadFluentAPI.isAuthenticated());
    }

    getAll() {
      if (this.isCloudActive()) {
        return window.ReadFluentAPI.cachedDocuments || [];
      }
      return [];
    }

    getById(id) {
      const items = this.getAll();
      return items.find((item) => String(item.id) === String(id)) || null;
    }

    isTitleTaken(title, excludeId = null) {
      if (!title || typeof title !== 'string') return false;
      const normalized = title.trim().toLowerCase();
      const items = this.getAll();
      return items.some((item) => {
        if (excludeId && String(item.id) === String(excludeId)) {
          return false;
        }
        return item.title && item.title.trim().toLowerCase() === normalized;
      });
    }

    getItemByTitle(title, excludeId = null) {
      if (!title || typeof title !== 'string') return null;
      const normalized = title.trim().toLowerCase();
      const items = this.getAll();
      return items.find((item) => {
        if (excludeId && String(item.id) === String(excludeId)) {
          return false;
        }
        return item.title && item.title.trim().toLowerCase() === normalized;
      }) || null;
    }

    async syncCloud() {
      if (this.isCloudActive()) {
        return await window.ReadFluentAPI.getDocuments();
      }
      return [];
    }

    async save(doc) {
      const title = (doc.title || '').trim();
      if (this.isTitleTaken(title, doc.id)) {
        const err = new Error(`DUPLICATE_TITLE: A file named "${title}" already exists in your library.`);
        err.code = 'DUPLICATE_TITLE';
        err.duplicateTitle = title;
        throw err;
      }

      if (this.isCloudActive()) {
        return await window.ReadFluentAPI.saveDocument(doc);
      }
      throw new Error('Authentication required: Please sign in to save documents.');
    }

    async delete(id) {
      if (this.isCloudActive()) {
        return await window.ReadFluentAPI.deleteDocument(id);
      }
      return false;
    }

    async clearAll() {
      if (this.isCloudActive()) {
        return await window.ReadFluentAPI.clearAllDocuments();
      }
      return false;
    }
  }

  /* ==========================================================================
     2. SPEECH SYNTHESIS ENGINE (ZERO-LAG & CHROME TIMEOUT FIX)
     ========================================================================== */
  class SpeechEngine {
    constructor(options = {}) {
      this.synth = window.speechSynthesis;
      this.sentences = [];
      this.currentIndex = 0;
      this.isPlaying = false;
      this.isPaused = false;
      this.speed = 1.0;
      this.voice = null;
      this.currentUtterance = null;
      this.wakeInterval = null;
      this.onSentenceChange = options.onSentenceChange || (() => {});
      this.onWordBoundary = options.onWordBoundary || (() => {});
      this.onStateChange = options.onStateChange || (() => {});
      this.onComplete = options.onComplete || (() => {});
    }

    setSentences(sentences) {
      this.stop();
      this.sentences = sentences;
      this.currentIndex = 0;
    }

    setSpeed(newSpeed) {
      this.speed = parseFloat(newSpeed) || 1.0;
      if (this.isPlaying && !this.isPaused && this.sentences.length > 0) {
        this.speakCurrent(true);
      }
    }

    setVoice(voice) {
      this.voice = voice;
      if (this.isPlaying && !this.isPaused && this.sentences.length > 0) {
        this.speakCurrent(true);
      }
    }

    play() {
      if (!this.sentences || this.sentences.length === 0) return;

      if (this.isPaused) {
        this.synth.resume();
        this.isPaused = false;
        this.isPlaying = true;
        this.startKeepAlive();
        this.onStateChange({ isPlaying: true, isPaused: false });
        return;
      }

      this.isPlaying = true;
      this.isPaused = false;
      this.startKeepAlive();
      this.onStateChange({ isPlaying: true, isPaused: false });
      this.speakCurrent();
    }

    pause() {
      if (!this.isPlaying) return;
      this.synth.pause();
      this.isPaused = true;
      this.stopKeepAlive();
      this.onStateChange({ isPlaying: false, isPaused: true });
    }

    stop() {
      this.stopKeepAlive();
      if (this.synth) {
        this.synth.cancel();
      }
      this.isPlaying = false;
      this.isPaused = false;
      this.currentUtterance = null;
      this.onStateChange({ isPlaying: false, isPaused: false });
    }

    seekToIndex(index) {
      if (!this.sentences || this.sentences.length === 0) return;
      const targetIndex = Math.max(0, Math.min(index, this.sentences.length - 1));
      this.currentIndex = targetIndex;
      this.onSentenceChange(this.currentIndex, this.sentences.length);

      if (this.isPlaying) {
        this.speakCurrent(true);
      }
    }

    seekRelativeSeconds(seconds) {
      if (!this.sentences || this.sentences.length === 0) return;
      const effectiveWpm = 150 * this.speed;
      const wordsToJump = Math.round((effectiveWpm / 60) * seconds);
      
      let targetSentence = this.currentIndex;
      let accumulatedWords = 0;

      if (seconds > 0) {
        while (targetSentence < this.sentences.length - 1) {
          const sentWords = (this.sentences[targetSentence].match(/\S+/g) || []).length;
          accumulatedWords += sentWords;
          targetSentence++;
          if (accumulatedWords >= wordsToJump) break;
        }
      } else {
        const targetWordCount = Math.abs(wordsToJump);
        while (targetSentence > 0) {
          targetSentence--;
          const sentWords = (this.sentences[targetSentence].match(/\S+/g) || []).length;
          accumulatedWords += sentWords;
          if (accumulatedWords >= targetWordCount) break;
        }
      }

      this.seekToIndex(targetSentence);
    }

    speakCurrent(seamless = false) {
      if (!this.synth) return;
      if (this.currentIndex >= this.sentences.length) {
        this.stop();
        this.currentIndex = 0;
        this.onComplete();
        return;
      }

      const text = this.sentences[this.currentIndex];
      if (!text || !text.trim()) {
        this.currentIndex++;
        this.speakCurrent(seamless);
        return;
      }

      this.synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      if (this.voice) utterance.voice = this.voice;
      utterance.rate = this.speed;
      utterance.pitch = 1.0;

      utterance.onstart = () => {
        this.onSentenceChange(this.currentIndex, this.sentences.length);
      };

      utterance.onboundary = (e) => {
        if (e.name === 'word') {
          this.onWordBoundary(this.currentIndex, e.charIndex, e.charLength || 1);
        }
      };

      utterance.onend = () => {
        if (!this.isPlaying || this.isPaused) return;
        this.currentIndex++;
        if (this.currentIndex < this.sentences.length) {
          this.speakCurrent();
        } else {
          this.stop();
          this.currentIndex = 0;
          this.onComplete();
        }
      };

      utterance.onerror = (e) => {
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          console.warn('Speech synthesis notice:', e.error);
        }
      };

      this.currentUtterance = utterance;
      this.synth.speak(utterance);
    }

    // Chrome 15s freeze workaround
    startKeepAlive() {
      this.stopKeepAlive();
      this.wakeInterval = setInterval(() => {
        if (this.isPlaying && !this.isPaused && this.synth && this.synth.speaking) {
          this.synth.pause();
          this.synth.resume();
        }
      }, 10000);
    }

    stopKeepAlive() {
      if (this.wakeInterval) {
        clearInterval(this.wakeInterval);
        this.wakeInterval = null;
      }
    }
  }

  /* ==========================================================================
     3. FILE PROCESSOR (CHUNKED 1GB TXT, PDF, DOCX STREAMING)
     ========================================================================== */
  class FileProcessor {
    static async processFile(file, onProgress, onMemoryAlert) {
      const ext = file.name.split('.').pop().toLowerCase();
      const fileSizeMB = file.size / (1024 * 1024);

      if (fileSizeMB > 100) {
        onMemoryAlert({
          type: 'warning',
          title: 'Large File Detected (' + fileSizeMB.toFixed(1) + ' MB)',
          message: 'Processing file with chunked streaming to maintain zero lag. Up to 1GB files supported.'
        });
      }

      if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'log' || ext === 'rtf' || ext === 'json') {
        return this.readTextFileChunked(file, onProgress);
      } else if (ext === 'pdf') {
        return this.readPdfFile(file, onProgress, onMemoryAlert);
      } else if (ext === 'docx' || ext === 'doc') {
        return this.readWordFile(file, onProgress);
      } else {
        return this.readTextFileChunked(file, onProgress);
      }
    }

    static async readTextFileChunked(file, onProgress) {
      const chunkSize = 2 * 1024 * 1024; // 2MB chunks
      const totalBytes = file.size;
      let offset = 0;
      let fullText = '';
      const decoder = new TextDecoder('utf-8');

      while (offset < totalBytes) {
        const slice = file.slice(offset, offset + chunkSize);
        const arrayBuf = await slice.arrayBuffer();
        const chunkText = decoder.decode(arrayBuf, { stream: offset + chunkSize < totalBytes });
        fullText += chunkText;
        offset += chunkSize;

        const percent = Math.min(100, Math.round((offset / totalBytes) * 100));
        onProgress({
          percent,
          processedMB: (Math.min(offset, totalBytes) / (1024 * 1024)).toFixed(1),
          totalMB: (totalBytes / (1024 * 1024)).toFixed(1),
          stage: `Reading chunk (${percent}%)...`
        });

        await new Promise((r) => setTimeout(r, 0));
      }

      return fullText;
    }

    static async readPdfFile(file, onProgress, onMemoryAlert) {
      if (!window.pdfjsLib) {
        throw new Error('PDF reader engine is still initializing. Please try again.');
      }

      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const numPages = pdf.numPages;
      let extractedText = '';

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageString = textContent.items.map((item) => item.str).join(' ');
        extractedText += pageString + '\n\n';

        const percent = Math.round((pageNum / numPages) * 100);
        onProgress({
          percent,
          processedMB: pageNum,
          totalMB: numPages,
          stage: `Extracting page ${pageNum} of ${numPages}...`
        });

        if (pageNum % 5 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      return extractedText.trim();
    }

    static async readWordFile(file, onProgress) {
      if (!window.mammoth) {
        throw new Error('Word document reader is initializing. Please try again.');
      }

      onProgress({
        percent: 30,
        processedMB: (file.size / (1024 * 1024)).toFixed(1),
        totalMB: (file.size / (1024 * 1024)).toFixed(1),
        stage: 'Unpacking Word structure...'
      });

      const arrayBuffer = await file.arrayBuffer();
      const result = await window.mammoth.extractRawText({ arrayBuffer });

      onProgress({
        percent: 100,
        processedMB: (file.size / (1024 * 1024)).toFixed(1),
        totalMB: (file.size / (1024 * 1024)).toFixed(1),
        stage: 'Done!'
      });

      return result.value.trim();
    }
  }

  /* ==========================================================================
     4. MAIN UI CONTROLLER & APP INTEGRATION
     ========================================================================== */
  class ReadFluentApp {
    constructor() {
      // DOM Elements
      this.dom = {
        // Theme & Logo
        btnThemeToggle: document.getElementById('btnThemeToggle'),
        brandLogo: document.getElementById('brandLogo'),

        // Stats
        wordCount: document.getElementById('wordCount'),
        readTime: document.getElementById('readTime'),
        charCount: document.getElementById('charCount'),

        // Header Actions
        fileInput: document.getElementById('fileInput'),
        btnUpload: document.getElementById('btnUpload'),
        btnDownload: document.getElementById('btnDownload'),
        btnLibraryToggle: document.getElementById('btnLibraryToggle'),
        libraryCountBadge: document.getElementById('libraryCountBadge'),

        // Workspace
        tabEditor: document.getElementById('tabEditor'),
        tabFluent: document.getElementById('tabFluent'),
        editorPane: document.getElementById('editorPane'),
        fluentPane: document.getElementById('fluentPane'),
        textContent: document.getElementById('textContent'),
        fluentContent: document.getElementById('fluentContent'),
        currentDocTitle: document.getElementById('currentDocTitle'),

        // Toolbar
        btnPasteClipboard: document.getElementById('btnPasteClipboard'),
        btnCopyText: document.getElementById('btnCopyText'),
        btnClearText: document.getElementById('btnClearText'),
        btnSaveLibraryTop: document.getElementById('btnSaveLibraryTop'),
        btnSampleText: document.getElementById('btnSampleText'),

        // Drag & Drop & Overlays
        dropZone: document.getElementById('dropZone'),
        dragOverlay: document.getElementById('dragOverlay'),
        parsingOverlay: document.getElementById('parsingOverlay'),
        parsingTitle: document.getElementById('parsingTitle'),
        parsingDetails: document.getElementById('parsingDetails'),
        progressBarFill: document.getElementById('progressBarFill'),
        parsingPercent: document.getElementById('parsingPercent'),
        parsingBytes: document.getElementById('parsingBytes'),
        btnCancelParsing: document.getElementById('btnCancelParsing'),
        memoryAlert: document.getElementById('memoryAlert'),
        alertHeading: document.getElementById('alertHeading'),
        alertMessage: document.getElementById('alertMessage'),
        btnCloseAlert: document.getElementById('btnCloseAlert'),

        // Player Dock
        playerDock: document.getElementById('playerDock'),
        timeCurrent: document.getElementById('timeCurrent'),
        timeTotal: document.getElementById('timeTotal'),
        seekSlider: document.getElementById('seekSlider'),
        scrubberFill: document.getElementById('scrubberFill'),
        scrubberPreview: document.getElementById('scrubberPreview'),
        scrubberContainer: document.getElementById('scrubberContainer'),
        sentenceBadge: document.getElementById('sentenceBadge'),

        // Player Controls
        voiceSelect: document.getElementById('voiceSelect'),
        btnBack15: document.getElementById('btnBack15'),
        btnStop: document.getElementById('btnStop'),
        btnPlayMaster: document.getElementById('btnPlayMaster'),
        btnFwd15: document.getElementById('btnFwd15'),
        speedSlider: document.getElementById('speedSlider'),
        speedDisplay: document.getElementById('speedDisplay'),
        speedChips: document.querySelectorAll('.chip-btn'),
        btnSaveLibrary: document.getElementById('btnSaveLibrary'),

        // Library Drawer
        libraryDrawer: document.getElementById('libraryDrawer'),
        libraryBackdrop: document.getElementById('libraryBackdrop'),
        btnCloseLibrary: document.getElementById('btnCloseLibrary'),
        librarySearch: document.getElementById('librarySearch'),
        btnClearAllLibrary: document.getElementById('btnClearAllLibrary'),
        libraryList: document.getElementById('libraryList'),
        libDrawerCount: document.getElementById('libDrawerCount'),
        libraryEmptyState: document.getElementById('libraryEmptyState'),

        // Toasts
        toastContainer: document.getElementById('toastContainer'),

        // Duplicate Title Modal Elements
        duplicateModal: document.getElementById('duplicateModal'),
        dupExistingName: document.getElementById('dupExistingName'),
        dupNewTitleInput: document.getElementById('dupNewTitleInput'),
        dupInputHint: document.getElementById('dupInputHint'),
        btnDupRenameAndSave: document.getElementById('btnDupRenameAndSave'),
        btnDupOpenLibrary: document.getElementById('btnDupOpenLibrary'),
        btnDupCancel: document.getElementById('btnDupCancel'),

        // Library Sync Banner
        librarySyncBanner: document.getElementById('librarySyncBanner'),
        librarySyncDot: document.getElementById('librarySyncDot'),
        librarySyncText: document.getElementById('librarySyncText'),
        btnLibrarySyncAction: document.getElementById('btnLibrarySyncAction'),

        // User Profile Header Elements
        userMenuContainer: document.getElementById('userMenuContainer'),
        btnUserMenuTrigger: document.getElementById('btnUserMenuTrigger'),
        userDropdownPopover: document.getElementById('userDropdownPopover'),
        headerUserAvatar: document.getElementById('headerUserAvatar'),
        headerUserEmail: document.getElementById('headerUserEmail'),
        headerUserRole: document.getElementById('headerUserRole'),
        dropdownUserAvatar: document.getElementById('dropdownUserAvatar'),
        dropdownUserFullName: document.getElementById('dropdownUserFullName'),
        dropdownUserEmailText: document.getElementById('dropdownUserEmailText'),
        dropdownUserRolePill: document.getElementById('dropdownUserRolePill'),
        btnMenuOpenLibrary: document.getElementById('btnMenuOpenLibrary'),
        btnMenuOpenAdmin: document.getElementById('btnMenuOpenAdmin'),
        btnMenuSignOut: document.getElementById('btnMenuSignOut'),

        // Admin Dashboard Elements
        adminModal: document.getElementById('adminModal'),
        btnCloseAdminModal: document.getElementById('btnCloseAdminModal'),
        adminStatTotalUsers: document.getElementById('adminStatTotalUsers'),
        adminStatTotalDocs: document.getElementById('adminStatTotalDocs'),
        adminStatAdmins: document.getElementById('adminStatAdmins'),
        adminStatCurrentEmail: document.getElementById('adminStatCurrentEmail'),
        btnAdminTabUsers: document.getElementById('btnAdminTabUsers'),
        btnAdminTabAddUser: document.getElementById('btnAdminTabAddUser'),
        btnAdminRefreshUsers: document.getElementById('btnAdminRefreshUsers'),
        adminSectionUsers: document.getElementById('adminSectionUsers'),
        adminSectionAddUser: document.getElementById('adminSectionAddUser'),
        adminUserSearchInput: document.getElementById('adminUserSearchInput'),
        adminUserFilterCount: document.getElementById('adminUserFilterCount'),
        adminUsersTbody: document.getElementById('adminUsersTbody'),
        adminTableLoading: document.getElementById('adminTableLoading'),
        formAdminAddUser: document.getElementById('formAdminAddUser'),
        adminNewUserEmail: document.getElementById('adminNewUserEmail'),
        adminNewUserFullName: document.getElementById('adminNewUserFullName'),
        adminNewUserPassword: document.getElementById('adminNewUserPassword'),
        adminNewUserRole: document.getElementById('adminNewUserRole'),
        adminAddUserError: document.getElementById('adminAddUserError'),
        adminAddUserSuccess: document.getElementById('adminAddUserSuccess'),
        btnAdminSubmitAddUser: document.getElementById('btnAdminSubmitAddUser'),
        btnAdminCancelAddUser: document.getElementById('btnAdminCancelAddUser'),
        adminUserDocsModal: document.getElementById('adminUserDocsModal'),
        btnCloseInspectModal: document.getElementById('btnCloseInspectModal'),
        inspectUserEmail: document.getElementById('inspectUserEmail'),
        inspectDocsList: document.getElementById('inspectDocsList'),
        adminConfirmDeleteModal: document.getElementById('adminConfirmDeleteModal'),
        deleteTargetEmail: document.getElementById('deleteTargetEmail'),
        btnConfirmDeleteUser: document.getElementById('btnConfirmDeleteUser'),
        btnCancelDeleteUser: document.getElementById('btnCancelDeleteUser')
      };

      // State
      this.currentDocId = null;
      this.currentTitle = 'Untitled Document';
      this.currentFile = null;
      this.sentences = [];
      this.sentenceElements = [];
      this.activeSentenceIndex = 0;
      this.currentSpeed = 1.0;
      this.availableVoices = [];
      this.adminUsersCache = [];
      this.userToDeleteId = null;

      // Storage & Speech Engine
      this.library = new LibraryStore();
      this.speech = new SpeechEngine({
        onSentenceChange: (idx, total) => this.handleSentenceChange(idx, total),
        onWordBoundary: (sentIdx, charIdx, length) => this.handleWordBoundary(sentIdx, charIdx, length),
        onStateChange: (state) => this.handlePlaybackStateChange(state),
        onComplete: () => this.handlePlaybackComplete()
      });

      this.init();
    }

    init() {
      this.initTheme();
      this.initVoices();
      this.bindEvents();
      this.initUserSession();
      this.initAdminDashboard();
      this.updateStats();
      this.updateLibraryCount();

      // Load sample text initially if empty
      if (!this.dom.textContent.value.trim()) {
        this.loadSampleText();
      }
    }

    /* ========================================================================
       THEME MANAGEMENT
       ======================================================================== */
    initTheme() {
      const savedTheme = localStorage.getItem('readfluent_theme') || 'dark';
      document.documentElement.setAttribute('data-theme', savedTheme);
      this.dom.btnThemeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('readfluent_theme', next);
        this.showToast(`Switched to ${next} theme`, 'info');
      });
    }

    /* ========================================================================
       VOICES SETUP
       ======================================================================== */
    initVoices() {
      const populate = () => {
        if (!window.speechSynthesis) {
          this.dom.voiceSelect.innerHTML = '<option>Speech not supported in browser</option>';
          return;
        }

        const voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) return;

        this.availableVoices = voices;
        this.dom.voiceSelect.innerHTML = '';

        const sorted = [...voices].sort((a, b) => {
          const aPri = (a.lang.startsWith('en') ? 1 : 0) + (a.name.includes('Natural') || a.name.includes('Google') ? 2 : 0);
          const bPri = (b.lang.startsWith('en') ? 1 : 0) + (b.name.includes('Natural') || b.name.includes('Google') ? 2 : 0);
          return bPri - aPri;
        });

        sorted.forEach((voice) => {
          const opt = document.createElement('option');
          opt.value = voice.name;
          opt.textContent = `${voice.name} (${voice.lang})`;
          this.dom.voiceSelect.appendChild(opt);
        });

        const preferred = sorted.find((v) => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.default)) || sorted[0];
        if (preferred) {
          this.dom.voiceSelect.value = preferred.name;
          this.speech.setVoice(preferred);
        }
      };

      populate();
      if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = populate;
      }

      this.dom.voiceSelect.addEventListener('change', (e) => {
        const selected = this.availableVoices.find((v) => v.name === e.target.value);
        if (selected) {
          this.speech.setVoice(selected);
          this.showToast(`Voice set to ${selected.name}`, 'info');
        }
      });
    }

    /* ========================================================================
       EVENT BINDINGS
       ======================================================================== */
    bindEvents() {
      // Input text change & stats
      this.dom.textContent.addEventListener('input', () => {
        this.updateStats();
        this.parseSentencesFromText();
      });

      // Tabs: Edit Mode vs Fluent Reader Mode
      this.dom.tabEditor.addEventListener('click', () => this.switchViewMode('editor'));
      this.dom.tabFluent.addEventListener('click', () => this.switchViewMode('fluent'));

      // Quick Toolbar
      this.dom.btnPasteClipboard.addEventListener('click', () => this.pasteFromClipboard());
      this.dom.btnCopyText.addEventListener('click', () => this.copyToClipboard());
      this.dom.btnClearText.addEventListener('click', () => this.clearEditor());
      this.dom.btnSampleText.addEventListener('click', () => this.loadSampleText());

      // Save to Library (Both in Top Toolbar and Bottom Player Dock)
      if (this.dom.btnSaveLibraryTop) {
        this.dom.btnSaveLibraryTop.addEventListener('click', () => this.saveCurrentToLibrary());
      }
      if (this.dom.btnSaveLibrary) {
        this.dom.btnSaveLibrary.addEventListener('click', () => this.saveCurrentToLibrary());
      }

      // File Upload & Drag & Drop
      this.dom.btnUpload.addEventListener('click', () => this.dom.fileInput.click());
      this.dom.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
      this.setupDragAndDrop();

      // Download content
      this.dom.btnDownload.addEventListener('click', () => this.downloadContent());

      // Player Controls
      this.dom.btnPlayMaster.addEventListener('click', () => this.togglePlayPause());
      this.dom.btnStop.addEventListener('click', () => this.stopPlayback());
      this.dom.btnFwd15.addEventListener('click', () => this.speech.seekRelativeSeconds(15));
      this.dom.btnBack15.addEventListener('click', () => this.speech.seekRelativeSeconds(-15));

      // Sleek Scrubber (Seek Slider)
      this.setupSleekScrubber();

      // Sleek Speed Slider & Chips
      this.setupSpeedControls();

      // Library Drawer Toggle
      this.dom.btnLibraryToggle.addEventListener('click', () => this.openLibraryDrawer());
      this.dom.btnCloseLibrary.addEventListener('click', () => this.closeLibraryDrawer());
      this.dom.libraryBackdrop.addEventListener('click', () => this.closeLibraryDrawer());
      this.dom.librarySearch.addEventListener('input', (e) => this.filterLibraryList(e.target.value));
      this.dom.btnClearAllLibrary.addEventListener('click', () => this.clearAllLibrary());

      // Memory alert close
      this.dom.btnCloseAlert.addEventListener('click', () => {
        this.dom.memoryAlert.style.display = 'none';
      });

      // Click to rename title in editor header with duplicate prevention
      this.dom.currentDocTitle.style.cursor = 'pointer';
      this.dom.currentDocTitle.title = 'Click to rename document title';
      this.dom.currentDocTitle.addEventListener('click', () => {
        const newTitle = prompt('Enter new audio / document title:', this.currentTitle || 'Untitled Document');
        if (newTitle && newTitle.trim()) {
          const trimmed = newTitle.trim();
          if (trimmed.toLowerCase() === (this.currentTitle || '').trim().toLowerCase()) return;

          // Check for duplicate title in library
          if (this.library.isTitleTaken(trimmed, this.currentDocId)) {
            alert(`A file named "${trimmed}" already exists in your library.\n\nThere cannot be two files with the same name. Please choose a different name or remove the existing file from your library.`);
            this.showToast(`Duplicate name: "${trimmed}" already exists in library. Please choose a unique name.`, 'warning');
            return; // DO NOT RENAME!
          }

          this.currentTitle = trimmed;
          this.dom.currentDocTitle.textContent = this.currentTitle;
          if (this.currentDocId) {
            const doc = this.library.getById(this.currentDocId);
            if (doc) {
              doc.title = this.currentTitle;
              this.library.save(doc);
              this.renderLibraryList(this.dom.librarySearch.value);
            }
          }
          this.showToast(`Renamed title to "${this.currentTitle}"`, 'success');
        }
      });

      // Keyboard space shortcut
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && document.activeElement !== this.dom.textContent && document.activeElement !== this.dom.librarySearch) {
          e.preventDefault();
          this.togglePlayPause();
        }
      });
    }

    /* ========================================================================
       TEXT STATS & SENTENCE PARSER
       ======================================================================== */
    updateStats() {
      const text = this.dom.textContent.value;
      const charCount = text.length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      
      const effectiveWpm = 150 * this.currentSpeed;
      const totalMinutes = words > 0 ? words / effectiveWpm : 0;
      const mins = Math.floor(totalMinutes);
      const secs = Math.round((totalMinutes - mins) * 60);

      this.dom.wordCount.textContent = words.toLocaleString();
      this.dom.charCount.textContent = charCount.toLocaleString();
      this.dom.readTime.textContent = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      this.dom.timeTotal.textContent = this.formatTime(totalMinutes * 60);
    }

    splitSentences(text) {
      if (!text || typeof text !== 'string') return [];
      const trimmed = text.trim();
      if (!trimmed) return [];

      // 1. Modern Standard: Intl.Segmenter (handles quotes, dialogue, punctuation per Unicode TR29)
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        try {
          const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
          const segments = Array.from(segmenter.segment(trimmed));
          const sentences = segments
            .map((s) => s.segment.trim())
            .filter((s) => s.length > 0);
          if (sentences.length > 0) {
            return sentences;
          }
        } catch (e) {
          console.warn('Intl.Segmenter fallback to regex:', e);
        }
      }

      // 2. High-precision regex fallback supporting dialogue quotes (" ' ” ’ » ), brackets, and ellipses
      const closingQuotes = `['"”’»\\)\\]\\}]*`;
      const pattern = new RegExp(
        `[^.!?\\n]+[.!?]+${closingQuotes}(?:\\s+|\\n+|$)|[^.!?\\n]+(?:\\n+|$)`,
        'g'
      );
      const matches = trimmed.match(pattern) || [trimmed];
      return matches.map((s) => s.trim()).filter((s) => s.length > 0);
    }

    parseSentencesFromText() {
      const text = this.dom.textContent.value.trim();
      if (!text) {
        this.sentences = [];
        this.speech.setSentences([]);
        this.renderFluentSentences();
        this.updateScrubberBounds(0);
        return;
      }

      this.sentences = this.splitSentences(text);

      this.speech.setSentences(this.sentences);
      this.renderFluentSentences();
      this.updateScrubberBounds(this.sentences.length);
    }

    renderFluentSentences() {
      this.dom.fluentContent.innerHTML = '';
      this.sentenceElements = [];

      if (this.sentences.length === 0) {
        this.dom.fluentContent.innerHTML = `
          <div class="fluent-empty-placeholder">
            <p>No content loaded yet. Paste text or upload a document to begin fluent reading.</p>
          </div>
        `;
        return;
      }

      const fragment = document.createDocumentFragment();

      this.sentences.forEach((sentence, sIdx) => {
        const p = document.createElement('p');
        p.className = 'fluent-sentence';
        p.dataset.sentenceIndex = sIdx;

        const tokens = sentence.split(/(\s+)/);
        tokens.forEach((token) => {
          if (token.trim().length === 0) {
            p.appendChild(document.createTextNode(token));
          } else {
            const span = document.createElement('span');
            span.className = 'fluent-word';
            span.textContent = token;
            p.appendChild(span);
          }
        });

        p.addEventListener('click', () => {
          this.speech.seekToIndex(sIdx);
          if (!this.speech.isPlaying) {
            this.speech.play();
          }
        });

        this.sentenceElements.push(p);
        fragment.appendChild(p);
      });

      this.dom.fluentContent.appendChild(fragment);
      this.highlightSentence(this.activeSentenceIndex, false);
    }

    switchViewMode(mode) {
      if (mode === 'fluent') {
        this.dom.tabEditor.classList.remove('active');
        this.dom.tabFluent.classList.add('active');
        this.dom.tabEditor.setAttribute('aria-selected', 'false');
        this.dom.tabFluent.setAttribute('aria-selected', 'true');
        this.dom.editorPane.style.display = 'none';
        this.dom.fluentPane.style.display = 'block';
        this.renderFluentSentences();
        this.scrollToActiveSentence();
      } else {
        this.dom.tabFluent.classList.remove('active');
        this.dom.tabEditor.classList.add('active');
        this.dom.tabFluent.setAttribute('aria-selected', 'false');
        this.dom.tabEditor.setAttribute('aria-selected', 'true');
        this.dom.fluentPane.style.display = 'none';
        this.dom.editorPane.style.display = 'flex';
        this.dom.textContent.focus();
      }
    }

    /* ========================================================================
       SLEEK SEEK SCRUBBER (SMOOTH & ZERO LAG)
       ======================================================================== */
    setupSleekScrubber() {
      const slider = this.dom.seekSlider;
      const fill = this.dom.scrubberFill;
      const preview = this.dom.scrubberPreview;

      const updateFill = (val, max) => {
        const percent = max > 0 ? (val / max) * 100 : 0;
        fill.style.width = `${percent}%`;
      };

      slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const max = parseInt(e.target.max, 10) || 1;
        updateFill(val, max);

        const totalSentences = this.sentences.length;
        if (totalSentences > 0) {
          const ratio = val / max;
          const effectiveWpm = 150 * this.currentSpeed;
          const words = this.dom.textContent.value.trim().split(/\s+/).length;
          const totalSeconds = (words / effectiveWpm) * 60;
          this.dom.timeCurrent.textContent = this.formatTime(totalSeconds * ratio);
        }
      });

      slider.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        this.speech.seekToIndex(val);
      });

      slider.addEventListener('mousemove', (e) => {
        const rect = slider.getBoundingClientRect();
        const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const ratio = offsetX / rect.width;
        const percent = Math.round(ratio * 100);

        preview.style.left = `${offsetX}px`;
        preview.textContent = `${percent}%`;
      });
    }

    updateScrubberBounds(totalSentences) {
      const max = Math.max(0, totalSentences - 1);
      this.dom.seekSlider.max = max;
      if (this.activeSentenceIndex > max) {
        this.activeSentenceIndex = 0;
      }
      this.dom.seekSlider.value = this.activeSentenceIndex;
      const percent = max > 0 ? (this.activeSentenceIndex / max) * 100 : 0;
      this.dom.scrubberFill.style.width = `${percent}%`;
      this.dom.sentenceBadge.textContent = `${totalSentences > 0 ? this.activeSentenceIndex + 1 : 0} / ${totalSentences} sent.`;
    }

    /* ========================================================================
       SLEEK SPEED SLIDER & QUICK CHIPS (0.5x to 3.0x)
       ======================================================================== */
    setupSpeedControls() {
      const slider = this.dom.speedSlider;
      const display = this.dom.speedDisplay;

      const setSpeed = (val) => {
        const num = parseFloat(val);
        this.currentSpeed = num;
        slider.value = num;
        display.textContent = `${num.toFixed(1)}x`;

        this.dom.speedChips.forEach((chip) => {
          if (parseFloat(chip.dataset.speed) === num) {
            chip.classList.add('active');
          } else {
            chip.classList.remove('active');
          }
        });

        this.speech.setSpeed(num);
        this.updateStats();
      };

      slider.addEventListener('input', (e) => {
        setSpeed(e.target.value);
      });

      this.dom.speedChips.forEach((chip) => {
        chip.addEventListener('click', () => {
          setSpeed(chip.dataset.speed);
        });
      });
    }

    /* ========================================================================
       PLAYBACK CONTROLS
       ======================================================================== */
    togglePlayPause() {
      if (this.sentences.length === 0) {
        this.parseSentencesFromText();
      }

      if (this.sentences.length === 0) {
        this.showToast('Please paste or upload some text to play speech.', 'warning');
        return;
      }

      if (this.speech.isPlaying && !this.speech.isPaused) {
        this.speech.pause();
      } else {
        this.speech.play();
      }
    }

    stopPlayback() {
      this.speech.stop();
      this.activeSentenceIndex = 0;
      this.updateScrubberBounds(this.sentences.length);
      this.highlightSentence(0, false);
      this.dom.timeCurrent.textContent = '0:00';
    }

    handlePlaybackStateChange(state) {
      const playBtn = this.dom.btnPlayMaster;
      const iconPlay = playBtn.querySelector('.icon-play');
      const iconPause = playBtn.querySelector('.icon-pause');

      if (state.isPlaying && !state.isPaused) {
        playBtn.classList.add('playing');
        iconPlay.style.display = 'none';
        iconPause.style.display = 'block';
        playBtn.title = 'Pause speech';
      } else {
        playBtn.classList.remove('playing');
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        playBtn.title = 'Play speech';
      }
    }

    handleSentenceChange(idx, total) {
      this.activeSentenceIndex = idx;
      this.dom.seekSlider.value = idx;
      const max = Math.max(1, total - 1);
      const percent = (idx / max) * 100;
      this.dom.scrubberFill.style.width = `${percent}%`;

      this.dom.sentenceBadge.textContent = `${idx + 1} / ${total} sent.`;

      const effectiveWpm = 150 * this.currentSpeed;
      const words = this.dom.textContent.value.trim().split(/\s+/).length;
      const totalSeconds = (words / effectiveWpm) * 60;
      this.dom.timeCurrent.textContent = this.formatTime(totalSeconds * (idx / total));

      this.highlightSentence(idx, true);
    }

    handleWordBoundary(sentIdx, charIdx, length) {
      const sentElem = this.sentenceElements[sentIdx];
      if (!sentElem) return;

      const words = sentElem.querySelectorAll('.fluent-word');
      if (!words || words.length === 0) return;

      let currentPos = 0;
      words.forEach((w) => {
        const text = w.textContent;
        const start = currentPos;
        const end = currentPos + text.length;
        if (charIdx >= start && charIdx <= end) {
          w.classList.add('current-word');
        } else {
          w.classList.remove('current-word');
        }
        currentPos += text.length + 1;
      });
    }

    highlightSentence(idx, autoScroll = true) {
      this.sentenceElements.forEach((el, i) => {
        if (i === idx) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
          el.querySelectorAll('.current-word').forEach((w) => w.classList.remove('current-word'));
        }
      });

      if (autoScroll) {
        this.scrollToActiveSentence();
      }
    }

    scrollToActiveSentence() {
      const activeEl = this.sentenceElements[this.activeSentenceIndex];
      if (activeEl && this.dom.fluentPane.style.display !== 'none') {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    handlePlaybackComplete() {
      this.showToast('Speech playback finished.', 'info');
      this.stopPlayback();
    }

    /* ========================================================================
       FILE IMPORT & DRAG AND DROP (UP TO 1GB)
       ======================================================================== */
    setupDragAndDrop() {
      const zone = this.dom.dropZone;
      const overlay = this.dom.dragOverlay;

      ['dragenter', 'dragover'].forEach((eventName) => {
        zone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          overlay.classList.add('active');
        });
      });

      ['dragleave', 'drop'].forEach((eventName) => {
        zone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          overlay.classList.remove('active');
        });
      });

      zone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          this.loadFile(files[0]);
        }
      });
    }

    handleFileSelect(e) {
      const file = e.target.files[0];
      if (file) {
        this.loadFile(file);
      }
      e.target.value = '';
    }

    async loadFile(file) {
      const sizeMB = file.size / (1024 * 1024);
      const isGigabytePlus = file.size > 1024 * 1024 * 1024;

      if (isGigabytePlus) {
        this.showToast('Warning: File exceeds 1GB. Loading in chunked safety mode.', 'warning');
      }

      this.dom.parsingOverlay.style.display = 'flex';
      this.dom.parsingTitle.textContent = `Processing "${file.name}"`;
      this.dom.parsingDetails.textContent = `Reading ${sizeMB.toFixed(1)} MB...`;
      this.dom.progressBarFill.style.width = '0%';
      this.dom.parsingPercent.textContent = '0%';
      this.dom.parsingBytes.textContent = `0 MB / ${sizeMB.toFixed(1)} MB`;

      let isCancelled = false;
      this.dom.btnCancelParsing.onclick = () => {
        isCancelled = true;
        this.dom.parsingOverlay.style.display = 'none';
        this.showToast('File processing was cancelled.', 'info');
      };

      try {
        const content = await FileProcessor.processFile(
          file,
          (progress) => {
            if (isCancelled) return;
            this.dom.progressBarFill.style.width = `${progress.percent}%`;
            this.dom.parsingPercent.textContent = `${progress.percent}%`;
            this.dom.parsingBytes.textContent = `${progress.processedMB} MB / ${progress.totalMB} MB`;
            this.dom.parsingDetails.textContent = progress.stage;
          },
          (alertData) => {
            this.showMemoryAlert(alertData.title, alertData.message);
          }
        );

        if (isCancelled) return;

        this.dom.parsingOverlay.style.display = 'none';

        if (!content || !content.trim()) {
          this.showToast(`Warning: No readable text found in "${file.name}".`, 'warning');
          return;
        }

        this.currentDocId = null;
        this.currentFile = file;
        this.currentTitle = file.name.replace(/\.[^/.]+$/, '');
        this.dom.currentDocTitle.textContent = this.currentTitle;
        this.dom.textContent.value = content;

        this.updateStats();
        this.parseSentencesFromText();

        this.showToast(`Successfully loaded "${file.name}" (${sizeMB.toFixed(1)} MB)`, 'success');
      } catch (err) {
        this.dom.parsingOverlay.style.display = 'none';
        console.error('File load error:', err);
        this.showToast(`Failed to open file: ${err.message || 'Corrupted or unsupported format'}`, 'error');
        this.showMemoryAlert(
          'Error opening file',
          `Could not process "${file.name}". Ensure it is a valid TXT, PDF, or Word document under 1GB.`
        );
      }
    }

    showMemoryAlert(heading, msg) {
      this.dom.alertHeading.textContent = heading;
      this.dom.alertMessage.textContent = msg;
      this.dom.memoryAlert.style.display = 'flex';
    }

    /* ========================================================================
       DOWNLOAD, COPY, PASTE, SAMPLES
       ======================================================================== */
    downloadContent() {
      const text = this.dom.textContent.value;
      if (!text.trim()) {
        this.showToast('No content to download!', 'warning');
        return;
      }

      const filename = `${this.currentTitle || 'ReadFluent-Doc'}.txt`;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showToast(`Downloaded "${filename}"`, 'success');
    }

    async pasteFromClipboard() {
      try {
        if (!navigator.clipboard) {
          throw new Error('Clipboard access not supported');
        }
        const text = await navigator.clipboard.readText();
        if (text) {
          this.dom.textContent.value = text;
          this.updateStats();
          this.parseSentencesFromText();
          this.showToast('Pasted content from clipboard!', 'success');
        } else {
          this.showToast('Clipboard is empty.', 'info');
        }
      } catch (e) {
        this.dom.textContent.focus();
        this.showToast('Please press Ctrl+V to paste.', 'info');
      }
    }

    async copyToClipboard() {
      const text = this.dom.textContent.value;
      if (!text.trim()) {
        this.showToast('Nothing to copy!', 'warning');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        this.showToast('Copied all text to clipboard!', 'success');
      } catch (e) {
        this.showToast('Failed to copy to clipboard.', 'error');
      }
    }

    clearEditor() {
      if (!this.dom.textContent.value.trim()) return;
      if (confirm('Are you sure you want to clear the editor?')) {
        this.stopPlayback();
        this.dom.textContent.value = '';
        this.currentTitle = 'Untitled Document';
        this.dom.currentDocTitle.textContent = this.currentTitle;
        this.currentDocId = null;
        this.currentFile = null;
        this.updateStats();
        this.parseSentencesFromText();
        this.showToast('Editor cleared', 'info');
      }
    }

    loadSampleText() {
      this.currentFile = null;
      const sample = `Welcome to Read Fluent — the next-generation intelligent text-to-speech studio and high-capacity document reader!

Read Fluent is built to handle massive text, PDF, and Word documents effortlessly up to 1GB with chunked memory streaming and zero interface lag.

Here is how you can get the best experience:
First, you can type or paste any content directly into this text field.
Second, you can upload TXT, PDF, or Word files using the Upload button or by dragging and dropping them right into this workspace.
Third, click the Play button below to listen with natural synthetic speech.
Fourth, use the sleek scrubber slider to jump forward or backward through your text with zero stuttering.
Fifth, adjust the speed slider between 0.5x and 3.0x to customize your listening pace on the fly.
Sixth, use the -15s and +15s buttons to rewind or skip ahead by 15 seconds.
Seventh, click the Save to Library button to preserve your document, audio voice settings, and reading progress.

You can also switch to Fluent Reader Mode in the toolbar to follow along with synchronized karaoke-style sentence and word highlighting! Enjoy effortless reading.`;

      this.currentTitle = 'Welcome to Read Fluent';
      this.dom.currentDocTitle.textContent = this.currentTitle;
      this.dom.textContent.value = sample;
      this.updateStats();
      this.parseSentencesFromText();
    }

    /* ========================================================================
       LIBRARY & LOCAL STORAGE PERSISTENCE (REQUIREMENT #7)
       ======================================================================== */
    async saveCurrentToLibrary() {
      const text = this.dom.textContent.value.trim();
      if (!text) {
        this.showToast('Please paste or write some content before saving to the library!', 'warning');
        return;
      }

      const words = text.split(/\s+/).length;
      const progressPercent = this.sentences.length > 0
        ? Math.round((this.activeSentenceIndex / this.sentences.length) * 100)
        : 0;

      // Detect smart title if untitled
      let title = this.currentTitle ? this.currentTitle.trim() : '';
      if (!title || title === 'Untitled Document') {
        const firstLine = text.split('\n')[0].replace(/[#*_`]/g, '').trim();
        title = firstLine.length > 45 ? firstLine.slice(0, 42) + '...' : firstLine;
        if (!title) {
          title = 'Document ' + new Date().toLocaleDateString();
        }
        this.currentTitle = title;
        this.dom.currentDocTitle.textContent = title;
      }

      // STRICT VALIDATION: No 2 files with the same name allowed in the library
      if (this.library.isTitleTaken(title, this.currentDocId)) {
        this.showDuplicateTitleModal(title);
        return; // DO NOT SAVE!
      }

      const docRecord = {
        id: this.currentDocId || null,
        title: title,
        content: text,
        wordCount: words,
        charCount: text.length,
        progressPercent: progressPercent,
        activeSentenceIndex: this.activeSentenceIndex,
        speed: this.currentSpeed,
        voiceName: this.dom.voiceSelect ? this.dom.voiceSelect.value : ''
      };

      try {
        const savedId = await this.library.save(docRecord, this.currentFile);
        this.currentDocId = savedId;
        this.updateLibraryCount();

        // Button feedback on both Save buttons
        const saveBtns = [this.dom.btnSaveLibrary, this.dom.btnSaveLibraryTop].filter(Boolean);
        saveBtns.forEach((btn) => {
          btn.classList.add('btn-saved-success');
          const originalText = btn.innerHTML;
          btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>Saved!</span>
          `;
          setTimeout(() => {
            btn.classList.remove('btn-saved-success');
            btn.innerHTML = originalText;
          }, 2000);
        });

        const locationText = this.library.isCloudActive() ? 'Cloud Library' : 'Local Library';
        this.showToast(`Saved "${title}" to your ${locationText}!`, 'success', {
          actionText: 'View Library',
          onAction: () => this.openLibraryDrawer()
        });
      } catch (e) {
        if (e.code === 'DUPLICATE_TITLE') {
          this.showDuplicateTitleModal(title);
        } else {
          console.error('Error saving library document:', e);
          this.showToast('Failed to save document: ' + (e.message || 'Storage error'), 'error');
        }
      }
    }

    showDuplicateTitleModal(existingTitle) {
      if (!this.dom.duplicateModal) return;

      this.dom.dupExistingName.textContent = `"${existingTitle}"`;

      // Suggest next available incremented title
      let suggested = `${existingTitle} (2)`;
      let counter = 2;
      while (this.library.isTitleTaken(suggested, this.currentDocId)) {
        counter++;
        suggested = `${existingTitle} (${counter})`;
      }

      this.dom.dupNewTitleInput.value = suggested;
      this.dom.dupNewTitleInput.classList.remove('error', 'input-error-shake');
      this.dom.dupInputHint.style.display = 'none';
      this.dom.duplicateModal.style.display = 'flex';

      this.dom.dupNewTitleInput.focus();
      this.dom.dupNewTitleInput.select();

      this.showToast(
        `Duplicate File Name: "${existingTitle}" already exists. Change the name or remove the existing file.`,
        'warning'
      );

      const closeModal = () => {
        this.dom.duplicateModal.style.display = 'none';
        this.dom.btnDupRenameAndSave.onclick = null;
        this.dom.btnDupOpenLibrary.onclick = null;
        this.dom.btnDupCancel.onclick = null;
        this.dom.dupNewTitleInput.onkeydown = null;
      };

      const handleRenameAndSave = () => {
        const newTitle = this.dom.dupNewTitleInput.value.trim();
        if (!newTitle) {
          this.dom.dupInputHint.textContent = 'Please enter a valid title.';
          this.dom.dupInputHint.style.display = 'block';
          this.dom.dupNewTitleInput.classList.add('error', 'input-error-shake');
          setTimeout(() => this.dom.dupNewTitleInput.classList.remove('input-error-shake'), 400);
          return;
        }

        if (this.library.isTitleTaken(newTitle, this.currentDocId)) {
          this.dom.dupInputHint.textContent = `"${newTitle}" also exists! Please enter a unique name or remove the old file.`;
          this.dom.dupInputHint.style.display = 'block';
          this.dom.dupNewTitleInput.classList.add('error', 'input-error-shake');
          setTimeout(() => this.dom.dupNewTitleInput.classList.remove('input-error-shake'), 400);
          this.dom.dupNewTitleInput.focus();
          return; // DO NOT SAVE!
        }

        // Title is unique!
        this.currentTitle = newTitle;
        this.dom.currentDocTitle.textContent = newTitle;
        closeModal();

        // Save now with unique title
        this.saveCurrentToLibrary();
      };

      this.dom.btnDupRenameAndSave.onclick = handleRenameAndSave;

      this.dom.btnDupOpenLibrary.onclick = () => {
        closeModal();
        this.openLibraryDrawer();
        setTimeout(() => {
          const conflictingCard = Array.from(this.dom.libraryList.querySelectorAll('.library-card')).find((c) => {
            const t = c.querySelector('.lib-card-title');
            return t && t.textContent.trim().toLowerCase() === existingTitle.toLowerCase();
          });

          if (conflictingCard) {
            conflictingCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            conflictingCard.classList.add('card-conflict-highlight');
            this.showToast(`Found "${existingTitle}". Delete it to use this name, or rename your file.`, 'warning');
            setTimeout(() => conflictingCard.classList.remove('card-conflict-highlight'), 6000);
          }
        }, 300);
      };

      this.dom.btnDupCancel.onclick = () => {
        closeModal();
        this.showToast('Save cancelled. Please choose a unique name or remove the previous file.', 'info');
      };

      this.dom.dupNewTitleInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleRenameAndSave();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeModal();
        } else {
          this.dom.dupInputHint.style.display = 'none';
          this.dom.dupNewTitleInput.classList.remove('error');
        }
      };
    }

    updateLibraryCount() {
      try {
        const all = this.library.getAll();
        const count = all.length;
        if (this.dom.libraryCountBadge) {
          this.dom.libraryCountBadge.textContent = count;
        }
        if (this.dom.libDrawerCount) {
          this.dom.libDrawerCount.textContent = `${count} item${count === 1 ? '' : 's'}`;
        }
      } catch (e) {
        console.warn('Error reading library count:', e);
      }
    }

    openLibraryDrawer() {
      this.dom.libraryDrawer.classList.add('open');
      this.dom.libraryDrawer.setAttribute('aria-hidden', 'false');
      this.renderLibraryList();
    }

    closeLibraryDrawer() {
      this.dom.libraryDrawer.classList.remove('open');
      this.dom.libraryDrawer.setAttribute('aria-hidden', 'true');
    }

    renderLibraryList(filterQuery = '') {
      try {
        let docs = this.library.getAll();
        if (filterQuery.trim()) {
          const q = filterQuery.toLowerCase();
          docs = docs.filter(
            (d) => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)
          );
        }

        this.dom.libraryList.innerHTML = '';

        if (docs.length === 0) {
          this.dom.libraryEmptyState.style.display = 'block';
          this.dom.libraryList.appendChild(this.dom.libraryEmptyState);
          return;
        }

        this.dom.libraryEmptyState.style.display = 'none';

        docs.forEach((doc) => {
          const card = document.createElement('div');
          card.className = 'library-card';
          card.dataset.docId = doc.id;

          const formattedDate = new Date(doc.updatedAt || doc.createdAt || Date.now()).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });

          const snippet = doc.content.slice(0, 140) + (doc.content.length > 140 ? '...' : '');

          card.innerHTML = `
            <div class="lib-card-header">
              <div class="lib-title-container">
                <h4 class="lib-card-title" title="Click to rename audio title">${this.escapeHtml(doc.title)}</h4>
                <button class="btn-rename-icon" title="Rename audio title" aria-label="Rename audio title">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                  </svg>
                </button>
              </div>
              <span class="lib-card-date">${formattedDate}</span>
            </div>
            <div style="margin-bottom: 2px;">
              <span class="lib-audio-badge">
                <span>🔊</span>
                <span>${this.escapeHtml(doc.voiceName ? doc.voiceName.split(' ')[0] : 'Voice')}</span>
                <span>• ${doc.speed || 1.0}x</span>
              </span>
            </div>
            <p class="lib-card-snippet">${this.escapeHtml(snippet)}</p>
            <div class="lib-card-meta">
              <span>${(doc.wordCount || 0).toLocaleString()} words</span>
              <span>${doc.progressPercent || 0}% read</span>
            </div>
            <div class="lib-progress-wrap">
              <div class="lib-progress-fill" style="width: ${doc.progressPercent || 0}%;"></div>
            </div>
            <div class="lib-card-actions">
              <button class="btn btn-play-card btn-sm btn-play-doc" title="Play audio directly">
                <span class="play-icon">▶</span>
                <span class="play-text">Play Audio</span>
                <span class="soundwave-anim" style="display:none;">
                  <span class="soundwave-bar"></span>
                  <span class="soundwave-bar"></span>
                  <span class="soundwave-bar"></span>
                </span>
              </button>
              <button class="btn btn-primary btn-sm btn-load-doc" title="Load into Reader">Open in Reader</button>
              ${doc.fileUrl ? `<a href="${this.escapeHtml(doc.fileUrl)}" target="_blank" download="${this.escapeHtml(doc.fileName || 'file')}" class="btn btn-secondary btn-sm" title="Download original cloud file" style="text-decoration:none;">📄 Cloud File</a>` : ''}
              <button class="btn btn-secondary btn-sm btn-dl-doc" title="Download Text">Download</button>
              <button class="btn btn-secondary btn-sm btn-del-doc" title="Delete from Library">Delete</button>
            </div>
          `;

          // Rename Audio Title Logic
          const titleContainer = card.querySelector('.lib-title-container');
          const titleElement = card.querySelector('.lib-card-title');
          const btnRename = card.querySelector('.btn-rename-icon');

          const startEditingTitle = () => {
            const currentTitleText = doc.title || 'Untitled Document';
            titleContainer.innerHTML = `
              <div class="lib-title-input-wrap">
                <input type="text" class="lib-title-input" value="${this.escapeHtml(currentTitleText)}" maxlength="80" aria-label="New audio title" />
                <button class="btn-rename-save" title="Save new title">✓</button>
                <button class="btn-rename-cancel" title="Cancel">✕</button>
              </div>
            `;

            const input = titleContainer.querySelector('.lib-title-input');
            const saveBtn = titleContainer.querySelector('.btn-rename-save');
            const cancelBtn = titleContainer.querySelector('.btn-rename-cancel');

            input.focus();
            input.select();

            let isFinished = false;

            const commitRename = async () => {
              if (isFinished) return;
              const newTitle = input.value.trim();
              if (!newTitle) {
                this.showToast('Audio title cannot be empty!', 'warning');
                input.focus();
                return;
              }

              if (newTitle.toLowerCase() === (doc.title || '').trim().toLowerCase()) {
                cancelRename();
                return;
              }

              // Check if another file has this exact title
              if (this.library.isTitleTaken(newTitle, doc.id)) {
                input.classList.add('input-error-shake');
                this.showToast(`Cannot rename: A file named "${newTitle}" already exists in your library. Please choose a different name or remove the existing file.`, 'error');
                input.focus();
                input.select();
                setTimeout(() => input.classList.remove('input-error-shake'), 500);
                return; // DO NOT SAVE!
              }

              isFinished = true;
              doc.title = newTitle;
              await this.library.save(doc);

              if (String(this.currentDocId) === String(doc.id)) {
                this.currentTitle = newTitle;
                this.dom.currentDocTitle.textContent = newTitle;
              }

              this.showToast(`Renamed audio title to "${newTitle}"`, 'success');
              this.renderLibraryList(this.dom.librarySearch.value);
            };

            const cancelRename = () => {
              if (isFinished) return;
              isFinished = true;
              this.renderLibraryList(this.dom.librarySearch.value);
            };

            saveBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              commitRename();
            });

            cancelBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              cancelRename();
            });

            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            });

            input.addEventListener('click', (e) => e.stopPropagation());
          };

          titleElement.addEventListener('click', (e) => {
            e.stopPropagation();
            startEditingTitle();
          });

          btnRename.addEventListener('click', (e) => {
            e.stopPropagation();
            startEditingTitle();
          });

          // Direct Play / Pause Audio right from the card!
          const btnPlayCard = card.querySelector('.btn-play-doc');
          const playText = btnPlayCard.querySelector('.play-text');
          const playIcon = btnPlayCard.querySelector('.play-icon');
          const soundwave = btnPlayCard.querySelector('.soundwave-anim');

          btnPlayCard.addEventListener('click', () => {
            const isThisDocLoaded = String(this.currentDocId) === String(doc.id);
            if (isThisDocLoaded && this.speech.isPlaying && !this.speech.isPaused) {
              // Pause
              this.speech.pause();
              btnPlayCard.classList.remove('playing');
              playIcon.textContent = '▶';
              playText.textContent = 'Play Audio';
              soundwave.style.display = 'none';
            } else {
              // Load if not loaded
              if (!isThisDocLoaded) {
                this.loadDocFromLibrary(doc, false);
              }
              this.speech.play();
              btnPlayCard.classList.add('playing');
              playIcon.textContent = '⏸';
              playText.textContent = 'Pause';
              soundwave.style.display = 'inline-flex';
            }
          });

          // Open in Reader
          card.querySelector('.btn-load-doc').addEventListener('click', () => {
            this.loadDocFromLibrary(doc, true);
            this.closeLibraryDrawer();
          });

          // Download Text
          card.querySelector('.btn-dl-doc').addEventListener('click', () => {
            const blob = new Blob([doc.content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${doc.title || 'ReadFluent-Doc'}.txt`;
            a.click();
            URL.revokeObjectURL(url);
            this.showToast(`Downloaded "${doc.title}.txt"`, 'success');
          });

          // Delete
          card.querySelector('.btn-del-doc').addEventListener('click', async () => {
            if (confirm(`Remove "${doc.title}" from library?`)) {
              await this.library.delete(doc.id);
              if (String(this.currentDocId) === String(doc.id)) {
                this.currentDocId = null;
              }
              this.updateLibraryCount();
              this.renderLibraryList(this.dom.librarySearch.value);
              this.showToast(`Removed "${doc.title}" from library`, 'info');
            }
          });

          this.dom.libraryList.appendChild(card);
        });
      } catch (e) {
        console.error('Failed to render library list:', e);
      }
    }

    loadDocFromLibrary(doc, showToastNotification = true) {
      this.stopPlayback();
      this.currentDocId = doc.id;
      this.currentTitle = doc.title || 'Untitled Document';
      this.dom.currentDocTitle.textContent = this.currentTitle;
      this.dom.textContent.value = doc.content;

      this.updateStats();
      this.parseSentencesFromText();

      // Restore voice & speed if saved
      if (doc.speed) {
        this.dom.speedSlider.value = doc.speed;
        this.speech.setSpeed(doc.speed);
        this.currentSpeed = doc.speed;
        this.dom.speedDisplay.textContent = `${doc.speed.toFixed(1)}x`;
      }

      if (doc.voiceName && this.availableVoices.some((v) => v.name === doc.voiceName)) {
        this.dom.voiceSelect.value = doc.voiceName;
        const voiceObj = this.availableVoices.find((v) => v.name === doc.voiceName);
        this.speech.setVoice(voiceObj);
      }

      // Restore active sentence index
      if (typeof doc.activeSentenceIndex === 'number' && doc.activeSentenceIndex < this.sentences.length) {
        this.speech.seekToIndex(doc.activeSentenceIndex);
      }

      if (showToastNotification) {
        this.showToast(`Loaded "${doc.title}" into Reader`, 'success');
      }
    }

    filterLibraryList(query) {
      this.renderLibraryList(query);
    }

    async clearAllLibrary() {
      const all = this.library.getAll();
      if (all.length === 0) {
        this.showToast('Your library is already empty.', 'info');
        return;
      }
      if (confirm(`Are you sure you want to clear your entire library (${all.length} items)? This cannot be undone.`)) {
        await this.library.clearAll();
        this.currentDocId = null;
        this.updateLibraryCount();
        this.renderLibraryList();
        this.showToast('Library cleared', 'info');
      }
    }

    /* ========================================================================
       UTILITIES & TOAST NOTIFICATIONS
       ======================================================================== */
    showToast(message, type = 'info', action = null) {
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;

      const iconMap = {
        success: '✓',
        error: '✕',
        warning: '⚠️',
        info: 'ℹ️'
      };

      toast.innerHTML = `
        <span class="toast-icon">${iconMap[type] || 'ℹ️'}</span>
        <span class="toast-text">${this.escapeHtml(message)}</span>
      `;

      if (action && action.actionText && typeof action.onAction === 'function') {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'toast-action-btn';
        actionBtn.textContent = action.actionText;
        actionBtn.addEventListener('click', () => {
          action.onAction();
          toast.remove();
        });
        toast.appendChild(actionBtn);
      }

      this.dom.toastContainer.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 260);
      }, 4000);
    }

    /* ========================================================================
       USER SESSION & CLOUD SYNC CONTROLLERS
       ======================================================================== */
    updateProfileUI() {
      if (!window.ReadFluentAPI) return;
      const user = window.ReadFluentAPI.getUser();
      const profile = window.ReadFluentAPI.getProfile();
      const userEmail = (user && user.email) || 'user@readfluent.com';
      const displayName = (profile && profile.full_name) || userEmail.split('@')[0];
      const initial = (displayName[0] || 'U').toUpperCase();
      const isAdmin = window.ReadFluentAPI.isAdmin();

      // Update Header Profile Elements
      if (this.dom.headerUserAvatar) this.dom.headerUserAvatar.textContent = initial;
      if (this.dom.dropdownUserAvatar) this.dom.dropdownUserAvatar.textContent = initial;
      if (this.dom.headerUserEmail) this.dom.headerUserEmail.textContent = userEmail;
      if (this.dom.dropdownUserEmailText) this.dom.dropdownUserEmailText.textContent = userEmail;
      if (this.dom.dropdownUserFullName) this.dom.dropdownUserFullName.textContent = displayName;

      if (this.dom.headerUserRole) {
        this.dom.headerUserRole.textContent = isAdmin ? 'Admin' : 'User';
        if (isAdmin) {
          this.dom.headerUserRole.classList.add('admin-role-tag');
        } else {
          this.dom.headerUserRole.classList.remove('admin-role-tag');
        }
      }

      if (this.dom.dropdownUserRolePill) {
        this.dom.dropdownUserRolePill.textContent = isAdmin ? 'Administrator' : 'Standard User';
        if (isAdmin) {
          this.dom.dropdownUserRolePill.classList.add('role-admin');
        } else {
          this.dom.dropdownUserRolePill.classList.remove('role-admin');
        }
      }

      // Show Admin Dashboard button if admin
      if (this.dom.btnMenuOpenAdmin) {
        this.dom.btnMenuOpenAdmin.style.display = isAdmin ? 'flex' : 'none';
      }

      // Update Library Sync Banner
      if (this.dom.librarySyncDot) {
        this.dom.librarySyncDot.className = 'sync-dot sync-dot-online';
      }
      if (this.dom.librarySyncText) {
        this.dom.librarySyncText.textContent = `Cloud Synced (${userEmail})`;
      }
    }

    async initUserSession() {
      // Strict Session Check: if not authenticated, redirect to login.html
      if (!window.ReadFluentAPI || !window.ReadFluentAPI.isAuthenticated()) {
        window.location.replace('login.html');
        return;
      }

      // Immediate render from local cache
      this.updateProfileUI();

      // Asynchronously fetch latest user profile & role from server
      window.ReadFluentAPI.checkSession().then((user) => {
        if (user) {
          this.updateProfileUI();
        }
      }).catch((err) => {
        console.warn('Profile refresh:', err);
      });

      const user = window.ReadFluentAPI.getUser();
      const userEmail = (user && user.email) || 'user@readfluent.com';
      if (this.dom.btnLibrarySyncAction) {
        this.dom.btnLibrarySyncAction.textContent = 'Sign Out';
        this.dom.btnLibrarySyncAction.onclick = () => window.ReadFluentAPI.logout();
      }

      // User Dropdown Trigger Handlers
      if (this.dom.btnUserMenuTrigger) {
        this.dom.btnUserMenuTrigger.addEventListener('click', (e) => {
          e.stopPropagation();
          const popover = this.dom.userDropdownPopover;
          const isShown = popover.style.display === 'block';
          popover.style.display = isShown ? 'none' : 'block';
          this.dom.btnUserMenuTrigger.setAttribute('aria-expanded', isShown ? 'false' : 'true');
        });
      }

      document.addEventListener('click', (e) => {
        if (this.dom.userDropdownPopover && this.dom.userMenuContainer) {
          if (!this.dom.userMenuContainer.contains(e.target)) {
            this.dom.userDropdownPopover.style.display = 'none';
            if (this.dom.btnUserMenuTrigger) {
              this.dom.btnUserMenuTrigger.setAttribute('aria-expanded', 'false');
            }
          }
        }
      });

      if (this.dom.btnMenuOpenLibrary) {
        this.dom.btnMenuOpenLibrary.addEventListener('click', () => {
          this.dom.userDropdownPopover.style.display = 'none';
          this.openLibraryDrawer();
        });
      }

      if (this.dom.btnMenuOpenAdmin) {
        this.dom.btnMenuOpenAdmin.addEventListener('click', () => {
          this.dom.userDropdownPopover.style.display = 'none';
          this.openAdminModal();
        });
      }

      if (this.dom.btnMenuSignOut) {
        this.dom.btnMenuSignOut.addEventListener('click', async () => {
          await window.ReadFluentAPI.logout();
        });
      }

      // Load user's private cloud documents
      try {
        await this.library.syncCloud();
        this.updateLibraryCount();
        this.renderLibraryList();
      } catch (err) {
        console.warn('Could not sync user cloud library:', err.message);
      }
    }

    /* ========================================================================
       ADMIN DASHBOARD CONTROLLER (USER MANAGEMENT: ADD/DELETE/REMOVE)
       ======================================================================== */
    initAdminDashboard() {
      // Subnav tabs
      if (this.dom.btnAdminTabUsers) {
        this.dom.btnAdminTabUsers.addEventListener('click', () => {
          this.dom.btnAdminTabUsers.classList.add('active');
          if (this.dom.btnAdminTabAddUser) this.dom.btnAdminTabAddUser.classList.remove('active');
          if (this.dom.adminSectionUsers) this.dom.adminSectionUsers.style.display = 'flex';
          if (this.dom.adminSectionAddUser) this.dom.adminSectionAddUser.style.display = 'none';
        });
      }
      if (this.dom.btnAdminTabAddUser) {
        this.dom.btnAdminTabAddUser.addEventListener('click', () => {
          this.dom.btnAdminTabAddUser.classList.add('active');
          if (this.dom.btnAdminTabUsers) this.dom.btnAdminTabUsers.classList.remove('active');
          if (this.dom.adminSectionUsers) this.dom.adminSectionUsers.style.display = 'none';
          if (this.dom.adminSectionAddUser) this.dom.adminSectionAddUser.style.display = 'flex';
        });
      }

      if (this.dom.btnCloseAdminModal) {
        this.dom.btnCloseAdminModal.addEventListener('click', () => this.closeAdminModal());
      }
      if (this.dom.btnAdminRefreshUsers) {
        this.dom.btnAdminRefreshUsers.addEventListener('click', () => this.loadAdminUsers());
      }

      // Filter search
      if (this.dom.adminUserSearchInput) {
        this.dom.adminUserSearchInput.addEventListener('input', () => {
          this.renderAdminUsers(this.adminUsersCache);
        });
      }

      // Add user form submission
      if (this.dom.formAdminAddUser) {
        this.dom.formAdminAddUser.addEventListener('submit', async (e) => {
          e.preventDefault();
          const email = (this.dom.adminNewUserEmail.value || '').trim();
          const password = this.dom.adminNewUserPassword.value;
          const fullName = (this.dom.adminNewUserFullName.value || '').trim();
          const role = this.dom.adminNewUserRole.value;
          const submitBtn = this.dom.btnAdminSubmitAddUser;

          try {
            this.dom.adminAddUserError.style.display = 'none';
            this.dom.adminAddUserSuccess.style.display = 'none';
            submitBtn.disabled = true;

            await window.ReadFluentAPI.adminCreateUser(email, password, fullName, role);

            this.dom.adminAddUserSuccess.textContent = `User "${email}" successfully created with role: ${role}!`;
            this.dom.adminAddUserSuccess.style.display = 'block';
            this.dom.formAdminAddUser.reset();
            this.showToast(`User ${email} created!`, 'success');

            await this.loadAdminUsers();
            setTimeout(() => {
              this.dom.adminAddUserSuccess.style.display = 'none';
              if (this.dom.btnAdminTabUsers) this.dom.btnAdminTabUsers.click();
            }, 1400);
          } catch (err) {
            this.dom.adminAddUserError.textContent = err.message || 'Failed to create user.';
            this.dom.adminAddUserError.style.display = 'block';
          } finally {
            submitBtn.disabled = false;
          }
        });
      }

      if (this.dom.btnAdminCancelAddUser) {
        this.dom.btnAdminCancelAddUser.addEventListener('click', () => {
          if (this.dom.btnAdminTabUsers) this.dom.btnAdminTabUsers.click();
        });
      }

      // User inspector close
      if (this.dom.btnCloseInspectModal) {
        this.dom.btnCloseInspectModal.addEventListener('click', () => {
          if (this.dom.adminUserDocsModal) this.dom.adminUserDocsModal.style.display = 'none';
        });
      }

      // Delete confirmation modal
      if (this.dom.btnCancelDeleteUser) {
        this.dom.btnCancelDeleteUser.addEventListener('click', () => {
          if (this.dom.adminConfirmDeleteModal) this.dom.adminConfirmDeleteModal.style.display = 'none';
          this.userToDeleteId = null;
        });
      }

      if (this.dom.btnConfirmDeleteUser) {
        this.dom.btnConfirmDeleteUser.addEventListener('click', async () => {
          if (!this.userToDeleteId) return;
          try {
            this.dom.btnConfirmDeleteUser.disabled = true;
            await window.ReadFluentAPI.adminDeleteUser(this.userToDeleteId);
            if (this.dom.adminConfirmDeleteModal) this.dom.adminConfirmDeleteModal.style.display = 'none';
            this.showToast('User account and all associated documents deleted.', 'success');
            this.userToDeleteId = null;
            await this.loadAdminUsers();
          } catch (err) {
            alert('Failed to delete user: ' + (err.message || 'Database error'));
          } finally {
            this.dom.btnConfirmDeleteUser.disabled = false;
          }
        });
      }
    }

    openAdminModal() {
      if (!window.ReadFluentAPI || !window.ReadFluentAPI.isAdmin()) {
        this.showToast('Administrator privileges required to access console.', 'error');
        return;
      }
      if (this.dom.adminModal) {
        this.dom.adminModal.style.display = 'flex';
        this.loadAdminUsers();
      }
    }

    closeAdminModal() {
      if (this.dom.adminModal) {
        this.dom.adminModal.style.display = 'none';
      }
    }

    async loadAdminUsers() {
      if (!this.dom.adminTableLoading) return;
      this.dom.adminTableLoading.style.display = 'flex';

      try {
        const users = await window.ReadFluentAPI.adminListUsers();
        this.adminUsersCache = users || [];

        // Update statistics ribbon
        const totalUsers = this.adminUsersCache.length;
        const totalAdmins = this.adminUsersCache.filter((u) => u.role === 'admin').length;
        const totalDocs = this.adminUsersCache.reduce((acc, u) => acc + (Number(u.document_count) || 0), 0);
        const currentEmail = window.ReadFluentAPI.getUser()?.email || 'admin';

        if (this.dom.adminStatTotalUsers) this.dom.adminStatTotalUsers.textContent = totalUsers;
        if (this.dom.adminStatTotalDocs) this.dom.adminStatTotalDocs.textContent = totalDocs;
        if (this.dom.adminStatAdmins) this.dom.adminStatAdmins.textContent = totalAdmins;
        if (this.dom.adminStatCurrentEmail) this.dom.adminStatCurrentEmail.textContent = currentEmail;

        this.renderAdminUsers(this.adminUsersCache);
      } catch (err) {
        console.error('Failed to load admin user list:', err);
        this.showToast('Could not load user list: ' + (err.message || 'Access error'), 'error');
      } finally {
        this.dom.adminTableLoading.style.display = 'none';
      }
    }

    renderAdminUsers(users) {
      if (!this.dom.adminUsersTbody) return;

      const query = (this.dom.adminUserSearchInput?.value || '').trim().toLowerCase();
      const filtered = query
        ? users.filter(
            (u) =>
              (u.email && u.email.toLowerCase().includes(query)) ||
              (u.full_name && u.full_name.toLowerCase().includes(query))
          )
        : users;

      if (this.dom.adminUserFilterCount) {
        this.dom.adminUserFilterCount.textContent = `${filtered.length} user${filtered.length === 1 ? '' : 's'}`;
      }

      this.dom.adminUsersTbody.innerHTML = '';

      if (filtered.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted);">No users match your filter criteria.</td>`;
        this.dom.adminUsersTbody.appendChild(tr);
        return;
      }

      const currentUid = window.ReadFluentAPI.getUser()?.id;

      filtered.forEach((user) => {
        const tr = document.createElement('tr');
        const isSelf = String(user.id) === String(currentUid);
        const displayName = user.full_name || user.email.split('@')[0];
        const initial = displayName[0].toUpperCase();
        const roleClass = user.role === 'admin' ? 'role-tag-admin' : 'role-tag-user';
        const roleLabel = user.role === 'admin' ? 'Admin' : 'User';

        const joinedDate = user.created_at
          ? new Date(user.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          : '—';

        const lastSignIn = user.last_sign_in_at
          ? new Date(user.last_sign_in_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : 'Never';

        tr.innerHTML = `
          <td>
            <div class="user-cell">
              <span class="table-user-avatar">${initial}</span>
              <div class="table-user-meta">
                <span class="table-user-email">${this.escapeHtml(user.email)} ${isSelf ? '<small style="color:var(--accent-primary);font-weight:600;">(You)</small>' : ''}</span>
                <span class="table-user-name">${this.escapeHtml(user.full_name || 'No full name')}</span>
              </div>
            </div>
          </td>
          <td><span class="role-tag ${roleClass}">${roleLabel}</span></td>
          <td><strong>${user.document_count || 0}</strong> docs</td>
          <td><span style="color:var(--text-secondary);font-size:0.78rem;">${joinedDate}</span></td>
          <td><span style="color:var(--text-secondary);font-size:0.78rem;">${lastSignIn}</span></td>
          <td>
            <div class="table-actions">
              <button class="btn-action btn-action-inspect" title="Inspect user documents" data-id="${user.id}" data-email="${this.escapeHtml(user.email)}">
                <span>Docs (${user.document_count || 0})</span>
              </button>
              ${
                !isSelf
                  ? `
                <button class="btn-action btn-action-role" title="${user.role === 'admin' ? 'Demote to regular User' : 'Promote to Admin'}" data-id="${user.id}" data-role="${user.role}">
                  <span>${user.role === 'admin' ? 'Demote' : 'Make Admin'}</span>
                </button>
                <button class="btn-action btn-action-delete" title="Delete User and their data" data-id="${user.id}" data-email="${this.escapeHtml(user.email)}">
                  <span>Delete</span>
                </button>
              `
                  : ''
              }
            </div>
          </td>
        `;

        // Action Handlers
        const btnInspect = tr.querySelector('.btn-action-inspect');
        if (btnInspect) {
          btnInspect.addEventListener('click', () => {
            this.openAdminInspectModal(user.id, user.email);
          });
        }

        const btnRole = tr.querySelector('.btn-action-role');
        if (btnRole) {
          btnRole.addEventListener('click', async () => {
            const newRole = user.role === 'admin' ? 'user' : 'admin';
            if (confirm(`Change role for ${user.email} to "${newRole}"?`)) {
              try {
                await window.ReadFluentAPI.adminUpdateUserRole(user.id, newRole);
                this.showToast(`Updated role for ${user.email} to ${newRole}`, 'success');
                await this.loadAdminUsers();
              } catch (err) {
                alert('Failed to update role: ' + (err.message || 'Permission error'));
              }
            }
          });
        }

        const btnDelete = tr.querySelector('.btn-action-delete');
        if (btnDelete) {
          btnDelete.addEventListener('click', () => {
            this.openAdminDeleteModal(user.id, user.email);
          });
        }

        this.dom.adminUsersTbody.appendChild(tr);
      });
    }

    async openAdminInspectModal(userId, userEmail) {
      if (!this.dom.adminUserDocsModal) return;
      if (this.dom.inspectUserEmail) this.dom.inspectUserEmail.textContent = userEmail;
      if (this.dom.inspectDocsList) {
        this.dom.inspectDocsList.innerHTML = `<div style="text-align:center;padding:18px;color:var(--text-secondary);">Loading user documents...</div>`;
      }
      this.dom.adminUserDocsModal.style.display = 'flex';

      try {
        const docs = await window.ReadFluentAPI.adminGetUserDocuments(userId);
        if (!docs || docs.length === 0) {
          this.dom.inspectDocsList.innerHTML = `<div style="text-align:center;padding:18px;color:var(--text-muted);">No cloud documents saved by this user yet.</div>`;
          return;
        }

        this.dom.inspectDocsList.innerHTML = '';
        docs.forEach((doc) => {
          const item = document.createElement('div');
          item.className = 'inspect-doc-item';
          const updatedDate = new Date(doc.updated_at).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          });

          item.innerHTML = `
            <div class="inspect-doc-left">
              <strong>${this.escapeHtml(doc.title)}</strong>
              <span>${(doc.word_count || 0).toLocaleString()} words • ${doc.progress_percent || 0}% read • Updated: ${updatedDate}</span>
              ${doc.file_url ? `<div style="margin-top:4px;"><a href="${this.escapeHtml(doc.file_url)}" target="_blank" download="${this.escapeHtml(doc.file_name || 'file')}" style="color:var(--accent-pink);font-size:0.76rem;">📄 Attached File: ${this.escapeHtml(doc.file_name || 'Download')}</a></div>` : ''}
            </div>
            <div>
              <span class="role-tag role-tag-user">${doc.word_count || 0} w</span>
            </div>
          `;
          this.dom.inspectDocsList.appendChild(item);
        });
      } catch (err) {
        this.dom.inspectDocsList.innerHTML = `<div style="color:var(--accent-rose);padding:14px;">Error fetching user documents: ${this.escapeHtml(err.message)}</div>`;
      }
    }

    openAdminDeleteModal(userId, userEmail) {
      this.userToDeleteId = userId;
      if (this.dom.deleteTargetEmail) this.dom.deleteTargetEmail.textContent = userEmail;
      if (this.dom.adminConfirmDeleteModal) this.dom.adminConfirmDeleteModal.style.display = 'flex';
    }

    formatTime(totalSeconds) {
      const s = Math.max(0, Math.round(totalSeconds));
      const mins = Math.floor(s / 60);
      const secs = s % 60;
      return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    escapeHtml(str) {
      if (!str) return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  }

  // Initialize Read Fluent on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new ReadFluentApp());
  } else {
    new ReadFluentApp();
  }
})();
