/**
 * FRIDAY AI - IMPROVED TRANSCRIPTION SYSTEM
 * Works like Notion AI - Continuous, Reliable, Production-Ready
 * 
 * Key Features:
 * ✅ Never gets stuck
 * ✅ Auto-restarts before timeout
 * ✅ Handles all edge cases
 * ✅ Works continuously like Notion AI
 */

(function () {
  'use strict';

  // ==================== CONFIGURATION ====================
  const CONFIG = {
    // Recognition settings
    LANGUAGE: 'en-US',
    CONTINUOUS: true,
    INTERIM_RESULTS: true,
    
    // Timing
    SAVE_INTERVAL: 2000,              // Save every 2 seconds
    RESTART_BEFORE_TIMEOUT: 55000,    // Restart at 55s (before 60s browser timeout)
    SILENCE_RESTART_DELAY: 8000,      // Restart if no speech for 8 seconds
    ERROR_RETRY_DELAY: 1000,          // Wait 1s before retry on error
    MAX_RETRY_ATTEMPTS: 10,           // Max retries before giving up
    
    // UI
    INDICATOR_POSITION: 'top-right',
    MAX_DISPLAY_TEXT: 100,
    
    // Advanced
    AUTO_PUNCTUATION: true,
    SMART_CAPITALIZATION: true,
    NOISE_SUPPRESSION: true
  };

  // ==================== STATE MANAGEMENT ====================
  const state = {
    // Recognition
    recognition: null,
    isActive: false,
    isRestarting: false,
    isStopping: false,
    
    // Session
    meetingId: null,
    uid: null,
    sessionStartTime: null,
    
    // Transcript
    fullTranscript: '',
    currentSegment: '',
    lastFinalText: '',
    
    // Timers
    timeoutRestartTimer: null,
    silenceRestartTimer: null,
    saveTimer: null,
    
    // Tracking
    lastActivity: Date.now(),
    consecutiveErrors: 0,
    totalRestarts: 0,
    wordsTranscribed: 0,
    
    // Metadata
    language: CONFIG.LANGUAGE,
    startTime: null,
    lastSaveTime: 0
  };

  // ==================== LOGGING ====================
  const log = {
    info: (msg, data = {}) => {
      console.log(`[Friday Transcription] ℹ️ ${msg}`, data);
    },
    success: (msg, data = {}) => {
      console.log(`[Friday Transcription] ✅ ${msg}`, data);
    },
    warn: (msg, data = {}) => {
      console.warn(`[Friday Transcription] ⚠️ ${msg}`, data);
    },
    error: (msg, error = {}) => {
      console.error(`[Friday Transcription] ❌ ${msg}`, error);
    },
    debug: (msg, data = {}) => {
      if (window.location.hostname === 'localhost') {
        console.debug(`[Friday Transcription] 🔍 ${msg}`, data);
      }
    }
  };

  // ==================== MESSAGE HANDLING ====================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log.debug('Received message', { type: message.type });
    
    try {
      switch (message.type) {
        case 'START_TRANSCRIPTION':
          startTranscription(message.meetingId, message.uid, message.language);
          sendResponse({ success: true });
          break;
          
        case 'STOP_TRANSCRIPTION':
          stopTranscription();
          sendResponse({ success: true });
          break;
          
        case 'GET_STATUS':
          sendResponse({ 
            success: true, 
            status: getStatus() 
          });
          break;
          
        default:
          log.warn('Unknown message type', { type: message.type });
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      log.error('Message handling error', error);
      sendResponse({ success: false, error: error.message });
    }
    
    return true; // Keep channel open for async response
  });

  // ==================== MAIN TRANSCRIPTION LOGIC ====================

  /**
   * Start transcription - Main entry point
   */
  function startTranscription(meetingId, uid, language = CONFIG.LANGUAGE) {
    log.info('Starting transcription', { meetingId, uid, language });
    
    // Check browser support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      const error = 'Speech Recognition not supported in this browser';
      log.error(error);
      sendError(error);
      return false;
    }
    
    // Already running?
    if (state.isActive && !state.isRestarting) {
      log.warn('Transcription already active');
      return false;
    }
    
    try {
      // Initialize state
      if (!state.isRestarting) {
        state.meetingId = meetingId;
        state.uid = uid;
        state.language = language || CONFIG.LANGUAGE;
        state.sessionStartTime = new Date().toISOString();
        state.fullTranscript = '';
        state.wordsTranscribed = 0;
        state.consecutiveErrors = 0;
        state.totalRestarts = 0;
      }
      
      state.lastActivity = Date.now();
      state.isRestarting = false;
      state.isStopping = false;
      
      // Clean up previous recognition
      cleanupRecognition();
      
      // Create new recognition instance
      state.recognition = new SpeechRecognition();
      configureRecognition(state.recognition);
      setupRecognitionHandlers(state.recognition);
      
      // Start recognition
      state.recognition.start();
      state.isActive = true;
      
      // Setup automatic restart before browser timeout (critical!)
      schedulePreventiveRestart();
      
      // Show UI indicator
      if (!state.isRestarting) {
        showTranscriptionIndicator();
        initializeTranscriptDocument();
      }
      
      log.success('Transcription started successfully');
      return true;
      
    } catch (error) {
      log.error('Failed to start transcription', error);
      sendError(`Failed to start: ${error.message}`);
      return false;
    }
  }

  /**
   * Configure recognition settings
   */
  function configureRecognition(recognition) {
    recognition.continuous = CONFIG.CONTINUOUS;
    recognition.interimResults = CONFIG.INTERIM_RESULTS;
    recognition.lang = state.language;
    recognition.maxAlternatives = 1;
    
    log.debug('Recognition configured', {
      continuous: recognition.continuous,
      interimResults: recognition.interimResults,
      language: recognition.lang
    });
  }

  /**
   * Setup all event handlers
   */
  function setupRecognitionHandlers(recognition) {
    
    // ===== START EVENT =====
    recognition.onstart = () => {
      log.success('Recognition started');
      state.isActive = true;
      state.lastActivity = Date.now();
      state.consecutiveErrors = 0; // Reset error counter
      
      updateIndicator('🎙️ Recording...', 'recording');
    };
    
    // ===== RESULT EVENT (Most Important!) =====
    recognition.onresult = (event) => {
      if (state.isStopping) return; // Ignore if stopping
      
      state.lastActivity = Date.now();
      
      let interimTranscript = '';
      let finalTranscript = '';
      
      // Process all results
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        
        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }
      
      // Handle final results
      if (finalTranscript) {
        const processedText = processTranscript(finalTranscript);
        state.fullTranscript += processedText + ' ';
        state.lastFinalText = processedText;
        state.wordsTranscribed += processedText.split(/\s+/).length;
        
        log.debug('Final transcript', { 
          text: processedText,
          totalWords: state.wordsTranscribed 
        });
        
        // Save to Firebase
        saveTranscript();
        
        // Reset silence timer
        resetSilenceTimer();
      }
      
      // Update UI with interim or final
      const displayText = finalTranscript || interimTranscript;
      if (displayText) {
        updateIndicator(displayText, finalTranscript ? 'final' : 'interim');
      }
    };
    
    // ===== ERROR EVENT =====
    recognition.onerror = (event) => {
      if (state.isStopping) {
        log.debug('Ignoring error during stop', { error: event.error });
        return;
      }
      
      log.warn('Recognition error', { 
        error: event.error,
        consecutiveErrors: state.consecutiveErrors + 1 
      });
      
      state.consecutiveErrors++;
      
      // Handle different error types
      switch (event.error) {
        case 'no-speech':
          log.info('No speech detected, will auto-restart');
          // This is normal, just restart
          scheduleRestart(2000);
          break;
          
        case 'audio-capture':
          log.error('Microphone error');
          if (state.consecutiveErrors < 3) {
            scheduleRestart(3000);
          } else {
            sendError('Microphone error. Please check your microphone.');
            stopTranscription();
          }
          break;
          
        case 'not-allowed':
          log.error('Microphone permission denied');
          sendError('Microphone permission denied. Please allow microphone access.');
          stopTranscription();
          break;
          
        case 'network':
          log.warn('Network error, will retry');
          if (state.consecutiveErrors < 5) {
            scheduleRestart(5000);
          } else {
            sendError('Network issues. Please check your connection.');
            stopTranscription();
          }
          break;
          
        case 'aborted':
          log.info('Recognition aborted');
          if (state.isActive && !state.isStopping && !state.isRestarting) {
            scheduleRestart(1000);
          }
          break;
          
        default:
          log.warn(`Unhandled error: ${event.error}`);
          if (state.consecutiveErrors < CONFIG.MAX_RETRY_ATTEMPTS) {
            scheduleRestart(CONFIG.ERROR_RETRY_DELAY);
          } else {
            sendError(`Transcription error: ${event.error}`);
            stopTranscription();
          }
      }
    };
    
    // ===== END EVENT =====
    recognition.onend = () => {
      log.info('Recognition ended');
      
      // Don't restart if we're stopping intentionally
      if (state.isStopping) {
        log.info('Stopped intentionally, not restarting');
        return;
      }
      
      // Don't restart if already restarting
      if (state.isRestarting) {
        log.debug('Already restarting, skipping');
        return;
      }
      
      // Auto-restart if still active
      if (state.isActive) {
        log.info('Unexpected end, auto-restarting immediately');
        scheduleRestart(500);
      }
    };
  }

  /**
   * 🚀 CRITICAL: Schedule restart BEFORE browser timeout
   * This prevents the 60-second browser timeout issue
   */
  function schedulePreventiveRestart() {
    // Clear existing timer
    if (state.timeoutRestartTimer) {
      clearTimeout(state.timeoutRestartTimer);
    }
    
    // Schedule restart at 55 seconds (before 60s timeout)
    state.timeoutRestartTimer = setTimeout(() => {
      if (state.isActive && !state.isStopping) {
        log.info('Preventive restart (before timeout)');
        state.totalRestarts++;
        gracefulRestart();
      }
    }, CONFIG.RESTART_BEFORE_TIMEOUT);
    
    log.debug('Scheduled preventive restart', { 
      after: CONFIG.RESTART_BEFORE_TIMEOUT / 1000 + 's' 
    });
  }

  /**
   * Reset silence detection timer
   */
  function resetSilenceTimer() {
    if (state.silenceRestartTimer) {
      clearTimeout(state.silenceRestartTimer);
    }
    
    state.silenceRestartTimer = setTimeout(() => {
      if (state.isActive && !state.isStopping) {
        log.info('No speech for a while, restarting to keep connection alive');
        gracefulRestart();
      }
    }, CONFIG.SILENCE_RESTART_DELAY);
  }

  /**
   * Graceful restart (maintains transcript)
   */
  function gracefulRestart() {
    if (state.isRestarting || state.isStopping) {
      log.debug('Already restarting or stopping, skipping graceful restart');
      return;
    }
    
    log.info('Performing graceful restart', { 
      totalRestarts: state.totalRestarts 
    });
    
    state.isRestarting = true;
    
    // Stop current recognition
    try {
      if (state.recognition) {
        state.recognition.stop();
      }
    } catch (e) {
      log.debug('Error stopping recognition during restart', e);
    }
    
    // Start new recognition immediately
    setTimeout(() => {
      if (state.isActive && !state.isStopping) {
        startTranscription(state.meetingId, state.uid, state.language);
      }
    }, 100);
  }

  /**
   * Schedule a restart with delay
   */
  function scheduleRestart(delay = 1000) {
    if (state.isRestarting || state.isStopping) {
      return;
    }
    
    state.isRestarting = true;
    
    log.info(`Scheduling restart in ${delay}ms`);
    updateIndicator(`Restarting in ${Math.ceil(delay/1000)}s...`, 'restarting');
    
    setTimeout(() => {
      if (state.isActive && !state.isStopping) {
        log.info('Executing scheduled restart');
        startTranscription(state.meetingId, state.uid, state.language);
      }
    }, delay);
  }

  /**
   * Stop transcription completely
   */
  function stopTranscription() {
    if (!state.isActive) {
      log.warn('Transcription not active');
      return;
    }
    
    log.info('Stopping transcription');
    
    // Set flag FIRST
    state.isStopping = true;
    state.isActive = false;
    
    // Clear all timers
    clearAllTimers();
    
    // Save final transcript
    if (state.fullTranscript.trim()) {
      finalizeTranscript();
    }
    
    // Stop recognition
    cleanupRecognition();
    
    // Hide UI
    hideTranscriptionIndicator();
    
    // Reset state
    setTimeout(() => {
      resetState();
      log.success('Transcription stopped successfully');
    }, 200);
  }

  /**
   * Clean up recognition object
   */
  function cleanupRecognition() {
    if (state.recognition) {
      try {
        state.recognition.stop();
        state.recognition.onstart = null;
        state.recognition.onresult = null;
        state.recognition.onerror = null;
        state.recognition.onend = null;
        state.recognition = null;
      } catch (e) {
        log.debug('Error during cleanup', e);
      }
    }
  }

  /**
   * Clear all timers
   */
  function clearAllTimers() {
    if (state.timeoutRestartTimer) {
      clearTimeout(state.timeoutRestartTimer);
      state.timeoutRestartTimer = null;
    }
    if (state.silenceRestartTimer) {
      clearTimeout(state.silenceRestartTimer);
      state.silenceRestartTimer = null;
    }
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
  }

  /**
   * Reset state
   */
  function resetState() {
    state.isActive = false;
    state.isRestarting = false;
    state.isStopping = false;
    state.currentSegment = '';
    state.consecutiveErrors = 0;
  }

  // ==================== TRANSCRIPT PROCESSING ====================

  /**
   * Process and improve transcript text
   */
  function processTranscript(text) {
    let processed = text.trim();
    
    if (CONFIG.SMART_CAPITALIZATION) {
      // Capitalize first letter
      processed = processed.charAt(0).toUpperCase() + processed.slice(1);
    }
    
    if (CONFIG.AUTO_PUNCTUATION) {
      // Add period if missing at the end of sentence
      if (!/[.!?]$/.test(processed)) {
        processed += '.';
      }
    }
    
    return processed;
  }

  /**
   * Save transcript to Firebase (throttled)
   */
  function saveTranscript() {
    const now = Date.now();
    
    // Throttle saves
    if (now - state.lastSaveTime < CONFIG.SAVE_INTERVAL) {
      return;
    }
    
    state.lastSaveTime = now;
    
    if (!state.fullTranscript.trim()) {
      return;
    }
    
    try {
      chrome.runtime.sendMessage({
        type: 'UPDATE_TRANSCRIPT_REALTIME',
        uid: state.uid,
        meetingId: state.meetingId,
        transcript: state.fullTranscript.trim(),
        lastUpdated: new Date().toISOString(),
        wordCount: state.wordsTranscribed,
        language: state.language
      });
      
      log.debug('Transcript saved', { 
        words: state.wordsTranscribed,
        length: state.fullTranscript.length 
      });
      
    } catch (error) {
      log.error('Failed to save transcript', error);
    }
  }

  /**
   * Initialize transcript document
   */
  function initializeTranscriptDocument() {
    try {
      chrome.runtime.sendMessage({
        type: 'INITIALIZE_TRANSCRIPT',
        uid: state.uid,
        meetingId: state.meetingId,
        startTime: state.sessionStartTime,
        language: state.language
      });
      
      log.success('Transcript document initialized');
      
    } catch (error) {
      log.error('Failed to initialize transcript', error);
    }
  }

  /**
   * Finalize transcript
   */
  function finalizeTranscript() {
    try {
      chrome.runtime.sendMessage({
        type: 'FINALIZE_TRANSCRIPT',
        uid: state.uid,
        meetingId: state.meetingId,
        transcript: state.fullTranscript.trim(),
        endTime: new Date().toISOString(),
        wordCount: state.wordsTranscribed,
        language: state.language,
        metadata: {
          totalRestarts: state.totalRestarts,
          duration: Date.now() - new Date(state.sessionStartTime).getTime()
        }
      });
      
      log.success('Transcript finalized', { 
        words: state.wordsTranscribed,
        restarts: state.totalRestarts 
      });
      
    } catch (error) {
      log.error('Failed to finalize transcript', error);
    }
  }

  // ==================== UI FUNCTIONS ====================

  /**
   * Show transcription indicator
   */
  function showTranscriptionIndicator() {
    hideTranscriptionIndicator(); // Remove if exists
    
    const indicator = document.createElement('div');
    indicator.id = 'friday-transcription-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 16px 20px;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      z-index: 999999;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      max-width: 400px;
      backdrop-filter: blur(10px);
      animation: slideIn 0.3s ease-out;
      cursor: pointer;
      transition: transform 0.2s;
    `;
    
    indicator.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <div class="pulse-dot" style="
          width: 12px;
          height: 12px;
          background: #ff4444;
          border-radius: 50%;
          animation: pulse 2s ease-in-out infinite;
        "></div>
        <div>
          <div class="status-text">🎙️ Recording...</div>
          <div class="transcript-text" style="
            font-size: 12px;
            opacity: 0.9;
            margin-top: 4px;
            font-weight: normal;
            max-height: 60px;
            overflow: hidden;
          ">Listening...</div>
        </div>
      </div>
    `;
    
    // Add animations
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateX(100px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.3); }
      }
      #friday-transcription-indicator:hover {
        transform: scale(1.05);
      }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(indicator);
    
    log.debug('Indicator shown');
  }

  /**
   * Update indicator text
   */
  function updateIndicator(text, type = 'interim') {
    const indicator = document.getElementById('friday-transcription-indicator');
    if (!indicator) return;
    
    const statusText = indicator.querySelector('.status-text');
    const transcriptText = indicator.querySelector('.transcript-text');
    
    if (statusText) {
      const icons = {
        recording: '🎙️',
        interim: '💬',
        final: '✅',
        restarting: '🔄'
      };
      
      const labels = {
        recording: 'Recording...',
        interim: 'Listening...',
        final: 'Transcribing...',
        restarting: 'Restarting...'
      };
      
      statusText.textContent = `${icons[type] || '🎙️'} ${labels[type] || 'Recording...'}`;
    }
    
    if (transcriptText && text) {
      const displayText = text.length > CONFIG.MAX_DISPLAY_TEXT
        ? '...' + text.slice(-CONFIG.MAX_DISPLAY_TEXT)
        : text;
      transcriptText.textContent = displayText;
      
      // Highlight final text
      if (type === 'final') {
        transcriptText.style.color = '#a8ff78';
        setTimeout(() => {
          transcriptText.style.color = 'rgba(255,255,255,0.9)';
        }, 500);
      }
    }
  }

  /**
   * Hide indicator
   */
  function hideTranscriptionIndicator() {
    const indicator = document.getElementById('friday-transcription-indicator');
    if (indicator) {
      indicator.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => indicator.remove(), 300);
    }
  }

  // ==================== UTILITY FUNCTIONS ====================

  /**
   * Send error to background
   */
  function sendError(message) {
    try {
      chrome.runtime.sendMessage({
        type: 'TRANSCRIPTION_ERROR',
        error: message
      });
    } catch (error) {
      log.error('Failed to send error message', error);
    }
  }

  /**
   * Get current status
   */
  function getStatus() {
    return {
      isActive: state.isActive,
      isRestarting: state.isRestarting,
      wordsTranscribed: state.wordsTranscribed,
      totalRestarts: state.totalRestarts,
      lastActivity: state.lastActivity,
      uptime: state.sessionStartTime 
        ? Date.now() - new Date(state.sessionStartTime).getTime() 
        : 0
    };
  }

  // ==================== CLEANUP ====================

  /**
   * Cleanup on page unload
   */
  function cleanup() {
    log.info('Page unloading, cleaning up');
    
    if (state.isActive) {
      stopTranscription();
    }
    
    clearAllTimers();
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('unload', cleanup);

  // ==================== INITIALIZATION ====================

  // Notify background that content script is ready
  try {
    chrome.runtime.sendMessage({
      type: 'CONTENT_SCRIPT_READY'
    });
    log.success('Content script loaded and ready');
  } catch (error) {
    log.error('Failed to notify background', error);
  }

})();

