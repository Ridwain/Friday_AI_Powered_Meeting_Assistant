// deepgram-transcription.js
// Real-time transcription using Deepgram WebSocket API
// Provides better accuracy, speaker diarization, and punctuation

/**
 * DeepgramTranscription - Handles real-time speech-to-text using Deepgram
 */
class DeepgramTranscription {
    constructor(options = {}) {
        this.apiKey = options.apiKey || null;
        this.language = options.language || 'en-US';
        this.model = options.model || 'nova-2'; // Best accuracy model
        this.punctuate = options.punctuate !== false;
        this.diarize = options.diarize !== false; // Speaker detection
        this.smartFormat = options.smartFormat !== false;
        this.interimResults = options.interimResults !== false;

        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.mediaRecorder = null;
        this.audioStream = null;

        // Callbacks
        this.onTranscript = options.onTranscript || (() => { });
        this.onError = options.onError || (() => { });
        this.onStatusChange = options.onStatusChange || (() => { });

        // Transcript accumulator
        this.fullTranscript = '';
        this.lastInterimText = '';
    }

    /**
     * Build WebSocket URL with query parameters
     */
    buildWebSocketUrl() {
        const params = new URLSearchParams({
            model: this.model,
            language: this.language.split('-')[0], // Convert en-US to en
            punctuate: this.punctuate,
            diarize: this.diarize,
            smart_format: this.smartFormat,
            interim_results: this.interimResults,
            encoding: 'linear16',
            sample_rate: 16000,
            channels: 1,
        });

        return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    }

    /**
     * Connect to Deepgram WebSocket
     */
    async connect() {
        if (!this.apiKey) {
            throw new Error('Deepgram API key is required');
        }

        return new Promise((resolve, reject) => {
            try {
                const url = this.buildWebSocketUrl();

                this.socket = new WebSocket(url, ['token', this.apiKey]);

                this.socket.onopen = () => {
                    console.log('[Deepgram] WebSocket connected');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.onStatusChange('connected');
                    resolve();
                };

                this.socket.onmessage = (event) => {
                    this.handleMessage(event);
                };

                this.socket.onerror = (error) => {
                    console.error('[Deepgram] WebSocket error:', error);
                    this.onError('WebSocket connection error');
                };

                this.socket.onclose = (event) => {
                    console.log('[Deepgram] WebSocket closed:', event.code, event.reason);
                    this.isConnected = false;
                    this.onStatusChange('disconnected');

                    // Auto-reconnect if not intentionally closed
                    if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
                        console.log(`[Deepgram] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
                        setTimeout(() => this.connect().catch(console.error), delay);
                    }
                };

                // Timeout for connection
                setTimeout(() => {
                    if (!this.isConnected) {
                        reject(new Error('Connection timeout'));
                    }
                }, 10000);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Handle incoming WebSocket message
     */
    handleMessage(event) {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'Results') {
                const transcript = data.channel?.alternatives?.[0]?.transcript || '';
                const isFinal = data.is_final;
                const speaker = data.channel?.alternatives?.[0]?.words?.[0]?.speaker;

                if (isFinal && transcript.trim()) {
                    // Add speaker label if available
                    const speakerPrefix = speaker !== undefined ? `[Speaker ${speaker}] ` : '';
                    const timestampedText = `${speakerPrefix}${transcript} `;

                    this.fullTranscript += timestampedText;
                    this.lastInterimText = '';

                    this.onTranscript({
                        type: 'final',
                        text: transcript,
                        fullTranscript: this.fullTranscript,
                        speaker: speaker,
                        timestamp: new Date().toISOString(),
                    });
                } else if (transcript.trim() && this.interimResults) {
                    this.lastInterimText = transcript;

                    this.onTranscript({
                        type: 'interim',
                        text: transcript,
                        fullTranscript: this.fullTranscript + transcript,
                        timestamp: new Date().toISOString(),
                    });
                }
            } else if (data.type === 'Metadata') {
                console.log('[Deepgram] Metadata received:', data);
            } else if (data.type === 'UtteranceEnd') {
                // End of a speech segment - useful for turn detection
                console.log('[Deepgram] Utterance ended');
            }
        } catch (error) {
            console.error('[Deepgram] Error parsing message:', error);
        }
    }

    /**
     * Start capturing audio from tab and streaming to Deepgram
     * @param {MediaStream} audioStream - Audio stream from chrome.tabCapture
     */
    async startFromStream(audioStream) {
        if (!this.isConnected) {
            await this.connect();
        }

        this.audioStream = audioStream;

        // Create AudioContext for processing
        const audioContext = new AudioContext({
            sampleRate: 16000, // Deepgram expects 16kHz
        });

        const source = audioContext.createMediaStreamSource(audioStream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = (event) => {
            if (!this.isConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
                return;
            }

            const inputData = event.inputBuffer.getChannelData(0);

            // Convert Float32Array to Int16Array (PCM16)
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Send to Deepgram
            this.socket.send(pcm16.buffer);
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        this._audioContext = audioContext;
        this._processor = processor;
        this._source = source;

        this.onStatusChange('recording');
        console.log('[Deepgram] Audio streaming started');
    }

    /**
     * Start transcription using microphone
     */
    async startFromMicrophone() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                }
            });

            await this.startFromStream(stream);
        } catch (error) {
            console.error('[Deepgram] Microphone access error:', error);
            this.onError('Microphone access denied');
            throw error;
        }
    }

    /**
     * Get current transcription
     */
    getTranscript() {
        return this.fullTranscript + this.lastInterimText;
    }

    /**
     * Get full transcript only (no interim)
     */
    getFinalTranscript() {
        return this.fullTranscript;
    }

    /**
     * Clear transcript buffer
     */
    clearTranscript() {
        this.fullTranscript = '';
        this.lastInterimText = '';
    }

    /**
     * Stop transcription
     */
    stop() {
        console.log('[Deepgram] Stopping transcription...');

        // Stop audio processing
        if (this._processor) {
            this._processor.disconnect();
            this._processor = null;
        }
        if (this._source) {
            this._source.disconnect();
            this._source = null;
        }
        if (this._audioContext) {
            this._audioContext.close();
            this._audioContext = null;
        }

        // Stop audio stream tracks
        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
        }

        // Close WebSocket gracefully
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            // Send close message to Deepgram
            this.socket.send(JSON.stringify({ type: 'CloseStream' }));
            this.socket.close(1000, 'Transcription stopped');
        }

        this.isConnected = false;
        this.onStatusChange('stopped');

        console.log('[Deepgram] Transcription stopped');

        return this.fullTranscript;
    }

    /**
     * Check if Deepgram is available (API key configured)
     */
    static isAvailable() {
        // Will be checked against config
        return true;
    }
}

// Export for use in extension
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeepgramTranscription };
}

// Make available globally for content scripts
if (typeof window !== 'undefined') {
    window.DeepgramTranscription = DeepgramTranscription;
}
