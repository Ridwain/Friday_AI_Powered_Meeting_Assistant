// rate-limiter.js
// Simple in-memory rate limiting middleware

/**
 * Creates a rate limiter middleware
 * @param {Object} options - Configuration options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 * @param {number} options.maxRequests - Max requests per window (default: 100)
 * @param {string} options.message - Error message when rate limited
 * @returns {Function} Express middleware
 */
export function createRateLimiter(options = {}) {
    const {
        windowMs = 60000, // 1 minute
        maxRequests = 100,
        message = 'Too many requests, please try again later.',
    } = options;

    // Store request counts per IP
    const requestCounts = new Map();

    // Cleanup old entries periodically
    setInterval(() => {
        const now = Date.now();
        for (const [key, data] of requestCounts.entries()) {
            if (now - data.windowStart > windowMs) {
                requestCounts.delete(key);
            }
        }
    }, windowMs);

    return (req, res, next) => {
        // Get client IP (handle proxies)
        const clientIp = req.ip ||
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.connection?.remoteAddress ||
            'unknown';

        const now = Date.now();
        let clientData = requestCounts.get(clientIp);

        // Initialize or reset if window expired
        if (!clientData || now - clientData.windowStart > windowMs) {
            clientData = {
                count: 0,
                windowStart: now,
            };
            requestCounts.set(clientIp, clientData);
        }

        clientData.count++;

        // Set rate limit headers
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - clientData.count));
        res.setHeader('X-RateLimit-Reset', Math.ceil((clientData.windowStart + windowMs) / 1000));

        // Check if rate limited
        if (clientData.count > maxRequests) {
            const retryAfter = Math.ceil((clientData.windowStart + windowMs - now) / 1000);
            res.setHeader('Retry-After', retryAfter);

            console.warn(`⚠️ Rate limit exceeded for IP: ${clientIp}`);

            return res.status(429).json({
                error: 'Too Many Requests',
                message,
                retryAfter,
            });
        }

        next();
    };
}

/**
 * Creates an API key validation middleware
 * @param {Object} options - Configuration options
 * @param {string[]} options.excludePaths - Paths to exclude from validation (e.g., '/health')
 * @returns {Function} Express middleware
 */
export function createApiKeyValidator(options = {}) {
    const {
        excludePaths = ['/health'],
    } = options;

    const API_SECRET_KEY = process.env.API_SECRET_KEY;

    // If no API key is configured, skip validation (development mode)
    if (!API_SECRET_KEY) {
        console.warn('⚠️ API_SECRET_KEY not configured - API key validation disabled');
        return (req, res, next) => next();
    }

    return (req, res, next) => {
        // Skip validation for excluded paths
        if (excludePaths.some(path => req.path.startsWith(path))) {
            return next();
        }

        const providedKey = req.headers['x-api-key'] || req.query.apiKey;

        if (!providedKey) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'API key is required. Provide it via X-API-Key header.',
            });
        }

        if (providedKey !== API_SECRET_KEY) {
            console.warn(`⚠️ Invalid API key attempt from: ${req.ip}`);
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Invalid API key.',
            });
        }

        next();
    };
}

export default { createRateLimiter, createApiKeyValidator };
