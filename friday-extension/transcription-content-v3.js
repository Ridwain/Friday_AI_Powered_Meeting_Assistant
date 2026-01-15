// transcription-content-v3.js
// Enhanced transcription with Deepgram support and Web Speech API fallback
// This version captures system audio from the tab for accurate meeting transcription

(function () {
    'use strict';

    const CONFIG = {
        SAVE_INTERVAL: 2000,
        MAX_TEXT_LENGTH: 50,
        MAX_RESTART_ATTEMPTS: 5,
        RESTART_DELAY: 1000,
        NO_SPEECH_TIMEOUT: 15000,
        DEEPGRAM_API_KEY: null, // Will be fetched from background
        USE_DEEPGRAM: true, // Try Deepgram first, fallback to Web Speech
        INDICATOR_STYLES: `
      position: fixed;
      top: 10px;
      right: 10px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 10px 14px;
      border-radius: 8px;
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 12px;
      font-weight: 500;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      max-width: 320px;
      word-wrap: break-word;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.2);
    `,
    };

    // State management
    let state = {
        isActive: false,
        isStopping: false,
        isRestarting: false,
        accumulatedTranscript: '',
        meetingId: null,
        uid: null,
        lastSaveTime: 0,
        language: 'en-US',
        restartAttempts: 0,
        lastActivity: Date.now(),

        // Transcription engine
        engine: null, // 'deepgram' or 'webspeech'
        deepgramInstance: null,
        recognition: null,
        audioStream: null,
    };

    const logger = {
        info: (msg) => console.log(`[Transcription v3] ${msg}`),
        error: (msg, err) => console.error(`[Transcription v3] ${msg}`, err),
        warn: (msg) => console.warn(`[Transcription v3] ${msg}`),
    };

    // Message listener
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        try {
            switch (message.type) {
                case 'START_TRANSCRIPTION':
                    startTranscription(message.meetingId, message.uid, message.language, message.deepgramApiKey);
                    sendResponse({ success: true });
                    break;
                case 'STOP_TRANSCRIPTION':
                    stopTranscription();
                    sendResponse({ success: true });
                    break;
                case 'GET_TRANSCRIPT':
                    sendResponse({
                        success: true,
                        transcript: state.accumulatedTranscript,
                        engine: state.engine,
                    });
                    break;
                default:
                    logger.warn(`Unknown message type: ${message.type}`);
                    sendResponse({ success: false, error: 'Unknown message type' });
            }
        } catch (error) {
            logger.error('Message handling failed:', error);
            sendResponse({ success: false, error: error.message });
        }
        return true;
    });

    /**
     * Start transcription with best available engine
     */
    async function startTranscription(meetingId, uid, language = 'en-US', deepgramApiKey = null) {
        if (state.isActive && !state.isRestarting) {
            logger.info('Transcription already active');
            return;
        }

        // Initialize state
        Object.assign(state, {
            meetingId,
            uid,
            language,
            accumulatedTranscript: state.isRestarting ? state.accumulatedTranscript : '',
            lastSaveTime: 0,
            lastActivity: Date.now(),
            isRestarting: false,
            isStopping: false,
        });

        CONFIG.DEEPGRAM_API_KEY = deepgramApiKey;

        try {
            // Try Deepgram first if API key is available
            if (CONFIG.USE_DEEPGRAM && CONFIG.DEEPGRAM_API_KEY) {
                await startDeepgramTranscription();
            } else {
                // Fallback to Web Speech API
                await startWebSpeechTranscription();
            }
        } catch (error) {
            logger.error('Failed to start transcription:', error);

            // If Deepgram fails, try Web Speech as fallback
            if (state.engine === 'deepgram') {
                logger.info('Deepgram failed, falling back to Web Speech API');
                try {
                    await startWebSpeechTranscription();
                } catch (fallbackError) {
                    sendErrorMessage(`Transcription failed: ${fallbackError.message}`);
                }
            } else {
                sendErrorMessage(`Transcription failed: ${error.message}`);
            }
        }
    }

    /**
     * Start Deepgram transcription
     */
    async function startDeepgramTranscription() {
        logger.info('Starting Deepgram transcription...');
        state.engine = 'deepgram';

        // Load Deepgram module if not already loaded
        if (!window.DeepgramTranscription) {
            await loadScript(chrome.runtime.getURL('deepgram-transcription.js'));
        }

        state.deepgramInstance = new window.DeepgramTranscription({
            apiKey: CONFIG.DEEPGRAM_API_KEY,
            language: state.language,
            model: 'nova-2',
            diarize: true,
            punctuate: true,
            smartFormat: true,
            interimResults: true,

            onTranscript: handleTranscriptResult,
            onError: handleTranscriptError,
            onStatusChange: handleStatusChange,
        });

        // Try to get tab audio first, fall back to microphone
        try {
            const audioStream = await getTabAudioStream();
            await state.deepgramInstance.startFromStream(audioStream);
            state.audioStream = audioStream;
        } catch (tabError) {
            logger.warn('Tab audio capture failed, using microphone:', tabError);
            await state.deepgramInstance.startFromMicrophone();
        }

        state.isActive = true;
        initializeTranscriptDocument();
        addTranscriptionIndicator('Deepgram');

        logger.info('Deepgram transcription started');
    }

    /**
     * Start Web Speech API transcription (fallback)
     */
    async function startWebSpeechTranscription() {
        logger.info('Starting Web Speech API transcription...');
        state.engine = 'webspeech';

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            throw new Error('Web Speech API not supported');
        }

        state.recognition = new SpeechRecognition();
        state.recognition.continuous = true;
        state.recognition.interimResults = true;
        state.recognition.lang = state.language;

        state.recognition.onstart = () => {
            state.isActive = true;
            state.restartAttempts = 0;
            state.lastActivity = Date.now();
            initializeTranscriptDocument();
            addTranscriptionIndicator('Web Speech');
            logger.info('Web Speech recognition started');
        };

        state.recognition.onresult = (event) => {
            if (state.isStopping) return;

            state.lastActivity = Date.now();
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript + ' ';
                } else {
                    interimTranscript += transcript;
                }
            }

            if (finalTranscript) {
                handleTranscriptResult({
                    type: 'final',
                    text: finalTranscript,
                    fullTranscript: state.accumulatedTranscript + finalTranscript,
                });
            }

            updateTranscriptionIndicator(finalTranscript || interimTranscript);
        };

        state.recognition.onerror = (event) => {
            if (state.isStopping) return;
            logger.error('Web Speech error:', event.error);

            if (event.error === 'no-speech' && state.restartAttempts < CONFIG.MAX_RESTART_ATTEMPTS) {
                restartTranscription();
            } else if (event.error !== 'aborted') {
                sendErrorMessage(`Speech recognition error: ${event.error}`);
            }
        };

        state.recognition.onend = () => {
            if (state.isActive && !state.isRestarting && !state.isStopping) {
                restartTranscription();
            }
        };

        state.recognition.start();
    }

    /**
     * Handle transcript results from either engine
     */
    function handleTranscriptResult(result) {
        if (state.isStopping) return;

        state.lastActivity = Date.now();

        if (result.type === 'final' && result.text.trim()) {
            state.accumulatedTranscript += result.text;
            saveTranscriptRealtime();
            state.restartAttempts = 0;
        }

        updateTranscriptionIndicator(result.text);
    }

    /**
     * Handle transcript errors
     */
    function handleTranscriptError(error) {
        if (state.isStopping) return;

        logger.error('Transcription error:', error);

        if (state.restartAttempts < CONFIG.MAX_RESTART_ATTEMPTS) {
            restartTranscription();
        } else {
            sendErrorMessage(error);
            stopTranscription();
        }
    }

    /**
     * Handle status changes
     */
    function handleStatusChange(status) {
        logger.info(`Transcription status: ${status}`);

        if (status === 'disconnected' && state.isActive && !state.isStopping) {
            restartTranscription();
        }
    }

    /**
     * Get audio stream from current tab
     */
    async function getTabAudioStream() {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_TAB_AUDIO' }, (response) => {
                if (response?.success && response.stream) {
                    resolve(response.stream);
                } else {
                    reject(new Error(response?.error || 'Failed to get tab audio'));
                }
            });
        });
    }

    /**
     * Load external script
     */
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
     * Restart transcription with backoff
     */
    function restartTranscription() {
        if (!state.isActive || state.isRestarting || state.isStopping) return;

        state.isRestarting = true;
        state.restartAttempts++;

        if (state.restartAttempts > CONFIG.MAX_RESTART_ATTEMPTS) {
            logger.error('Max restart attempts reached');
            sendErrorMessage('Transcription failed after multiple attempts');
            stopTranscription();
            return;
        }

        const delay = Math.min(CONFIG.RESTART_DELAY * Math.pow(2, state.restartAttempts - 1), 16000);
        logger.info(`Restarting in ${delay}ms (attempt ${state.restartAttempts})`);

        updateTranscriptionIndicator(`Restarting in ${Math.ceil(delay / 1000)}s...`);

        // Cleanup current engine
        cleanupCurrentEngine();

        setTimeout(() => {
            if (state.isActive && !state.isStopping) {
                startTranscription(state.meetingId, state.uid, state.language, CONFIG.DEEPGRAM_API_KEY);
            }
        }, delay);
    }

    /**
     * Cleanup current transcription engine
     */
    function cleanupCurrentEngine() {
        if (state.engine === 'deepgram' && state.deepgramInstance) {
            try {
                state.deepgramInstance.stop();
            } catch (e) { }
            state.deepgramInstance = null;
        }

        if (state.engine === 'webspeech' && state.recognition) {
            try {
                state.recognition.stop();
            } catch (e) { }
            state.recognition = null;
        }

        if (state.audioStream) {
            state.audioStream.getTracks().forEach(track => track.stop());
            state.audioStream = null;
        }
    }

    /**
     * Stop transcription
     */
    function stopTranscription() {
        if (!state.isActive) return;

        state.isStopping = true;
        logger.info('Stopping transcription...');

        // Finalize transcript before stopping
        if (state.accumulatedTranscript.trim()) {
            finalizeTranscriptDocument();
        }

        // Small delay to ensure finalization message is sent
        setTimeout(() => {
            cleanupCurrentEngine();

            state.isActive = false;
            state.isRestarting = false;
            state.isStopping = false;
            state.engine = null;

            removeTranscriptionIndicator();
            logger.info('Transcription stopped');
        }, 100);
    }

    /**
     * Initialize transcript document in Firebase
     */
    function initializeTranscriptDocument() {
        try {
            chrome.runtime.sendMessage({
                type: 'INITIALIZE_TRANSCRIPT',
                uid: state.uid,
                meetingId: state.meetingId,
                startTime: new Date().toISOString(),
                engine: state.engine,
            });
        } catch (error) {
            logger.error('Failed to initialize transcript:', error);
        }
    }

    /**
     * Save transcript in real-time (throttled)
     */
    function saveTranscriptRealtime() {
        const now = Date.now();
        if (now - state.lastSaveTime < CONFIG.SAVE_INTERVAL) return;

        state.lastSaveTime = now;

        if (state.accumulatedTranscript.trim()) {
            try {
                chrome.runtime.sendMessage({
                    type: 'UPDATE_TRANSCRIPT_REALTIME',
                    uid: state.uid,
                    meetingId: state.meetingId,
                    transcript: state.accumulatedTranscript,
                    lastUpdated: new Date().toISOString(),
                    engine: state.engine,
                });
            } catch (error) {
                logger.error('Failed to save transcript:', error);
            }
        }
    }

    /**
     * Finalize transcript document
     */
    function finalizeTranscriptDocument() {
        try {
            chrome.runtime.sendMessage({
                type: 'FINALIZE_TRANSCRIPT',
                uid: state.uid,
                meetingId: state.meetingId,
                transcript: state.accumulatedTranscript,
                endTime: new Date().toISOString(),
                wordCount: state.accumulatedTranscript.trim().split(/\s+/).length,
                engine: state.engine,
            });
            logger.info('Transcript finalized');
        } catch (error) {
            logger.error('Failed to finalize transcript:', error);
        }
    }

    /**
     * Add visual indicator
     */
    function addTranscriptionIndicator(engineName) {
        removeTranscriptionIndicator();

        const indicator = document.createElement('div');
        indicator.id = 'friday-transcription-indicator-v3';
        indicator.style.cssText = CONFIG.INDICATOR_STYLES;
        indicator.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="animation: pulse 1.5s ease-in-out infinite;">🎙️</span>
        <span>Recording (${engineName})</span>
      </div>
    `;

        // Add pulse animation
        const style = document.createElement('style');
        style.id = 'friday-transcription-styles';
        style.textContent = `
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    `;
        document.head.appendChild(style);
        document.body.appendChild(indicator);
    }

    /**
     * Update indicator with current text
     */
    function updateTranscriptionIndicator(text) {
        const indicator = document.getElementById('friday-transcription-indicator-v3');
        if (!indicator || !text.trim()) return;

        const truncatedText = text.length > CONFIG.MAX_TEXT_LENGTH
            ? text.substring(0, CONFIG.MAX_TEXT_LENGTH) + '...'
            : text;

        const statusIcon = state.isRestarting ? '🔄' : state.isStopping ? '🛑' : '🎙️';
        const statusText = state.isRestarting ? 'Restarting...'
            : state.isStopping ? 'Stopping...'
                : `Recording (${state.engine === 'deepgram' ? 'Deepgram' : 'Web Speech'})`;

        indicator.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 4px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="animation: pulse 1.5s ease-in-out infinite;">${statusIcon}</span>
          <span>${statusText}</span>
        </div>
        <small style="opacity: 0.8; font-size: 11px;">${truncatedText}</small>
      </div>
    `;
    }

    /**
     * Remove indicator
     */
    function removeTranscriptionIndicator() {
        const indicator = document.getElementById('friday-transcription-indicator-v3');
        const styles = document.getElementById('friday-transcription-styles');
        if (indicator) indicator.remove();
        if (styles) styles.remove();
    }

    /**
     * Send error message to background
     */
    function sendErrorMessage(error) {
        try {
            chrome.runtime.sendMessage({
                type: 'TRANSCRIPTION_ERROR',
                error: typeof error === 'string' ? error : error.message,
            });
        } catch (e) {
            logger.error('Failed to send error:', e);
        }
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', stopTranscription);
    window.addEventListener('unload', stopTranscription);

    // Notify background that content script is ready
    chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', version: 3 });
    logger.info('Content script v3 ready');
})();
