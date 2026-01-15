// request-queue.js
// Promise-based queue for API calls with exponential backoff

/**
 * RequestQueue - Manages API requests with rate limiting and retry logic
 */
export class RequestQueue {
    constructor(options = {}) {
        this.concurrency = options.concurrency || 3; // Max concurrent requests
        this.retryAttempts = options.retryAttempts || 3;
        this.baseDelay = options.baseDelay || 1000; // Base delay for exponential backoff
        this.maxDelay = options.maxDelay || 30000; // Max delay cap

        this.queue = [];
        this.activeCount = 0;
        this.paused = false;
    }

    /**
     * Add a request to the queue
     * @param {Function} requestFn - Async function that makes the request
     * @param {Object} options - Request options
     * @returns {Promise} - Resolves with the request result
     */
    async enqueue(requestFn, options = {}) {
        return new Promise((resolve, reject) => {
            const task = {
                requestFn,
                resolve,
                reject,
                attempts: 0,
                priority: options.priority || 0,
                id: options.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            };

            // Insert based on priority (higher priority first)
            const insertIndex = this.queue.findIndex(t => t.priority < task.priority);
            if (insertIndex === -1) {
                this.queue.push(task);
            } else {
                this.queue.splice(insertIndex, 0, task);
            }

            this.processQueue();
        });
    }

    /**
     * Process the next item in the queue
     */
    async processQueue() {
        if (this.paused || this.activeCount >= this.concurrency || this.queue.length === 0) {
            return;
        }

        const task = this.queue.shift();
        if (!task) return;

        this.activeCount++;

        try {
            const result = await this.executeWithRetry(task);
            task.resolve(result);
        } catch (error) {
            task.reject(error);
        } finally {
            this.activeCount--;
            this.processQueue();
        }
    }

    /**
     * Execute a task with exponential backoff retry
     */
    async executeWithRetry(task) {
        while (task.attempts < this.retryAttempts) {
            try {
                task.attempts++;
                const result = await task.requestFn();
                return result;
            } catch (error) {
                const isRetryable = this.isRetryableError(error);

                if (!isRetryable || task.attempts >= this.retryAttempts) {
                    throw error;
                }

                // Calculate delay with exponential backoff + jitter
                const delay = Math.min(
                    this.baseDelay * Math.pow(2, task.attempts - 1) + Math.random() * 500,
                    this.maxDelay
                );

                console.log(`⏳ Request ${task.id} failed (attempt ${task.attempts}/${this.retryAttempts}), retrying in ${delay}ms...`);

                await this.sleep(delay);
            }
        }
    }

    /**
     * Check if an error is retryable
     */
    isRetryableError(error) {
        // Rate limit errors
        if (error.status === 429) return true;

        // Server errors (5xx)
        if (error.status >= 500 && error.status < 600) return true;

        // Network errors
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true;

        // Check error message for common retryable patterns
        const message = String(error.message || error).toLowerCase();
        if (message.includes('rate limit') ||
            message.includes('too many requests') ||
            message.includes('timeout') ||
            message.includes('econnreset')) {
            return true;
        }

        return false;
    }

    /**
     * Pause queue processing
     */
    pause() {
        this.paused = true;
    }

    /**
     * Resume queue processing
     */
    resume() {
        this.paused = false;
        this.processQueue();
    }

    /**
     * Get queue statistics
     */
    getStats() {
        return {
            queued: this.queue.length,
            active: this.activeCount,
            paused: this.paused,
        };
    }

    /**
     * Clear all pending requests
     */
    clear() {
        const cleared = this.queue.length;
        this.queue.forEach(task => {
            task.reject(new Error('Queue cleared'));
        });
        this.queue = [];
        return cleared;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export a singleton instance for shared use
export const sharedQueue = new RequestQueue();

export default RequestQueue;
