const rateLimitCache = new Map();

const MAX_REQUESTS = 2;
const LIMIT_MS = 10000;

export const rateLimiter = () => {
    return async (c, next) => {
        if (c.req.method === 'OPTIONS') {
            return await next();
        }

        let ip = c.req.header('cf-connecting-ip') || 
                 c.req.header('x-vercel-forwarded-for') ||
                 c.req.header('x-real-ip');

        if (!ip) {
            const forwardedFor = c.req.header('x-forwarded-for');
            if (forwardedFor) {
                ip = forwardedFor.split(',')[0].trim();
            }
        }

        ip = ip || 'unknown';

        if (c.env && c.env.MY_RATE_LIMITER) {
            const { success } = await c.env.MY_RATE_LIMITER.limit({ key: ip });
            if (!success) {
                return c.json({ 
                    error: 'Too Many Requests', 
                    message: `Rate limit exceeded. Please wait 10 seconds before trying again (${MAX_REQUESTS} requests per 10 seconds allowed).` 
                }, 429);
            }
        } else {
            const now = Date.now();
            if (ip !== 'unknown') {
                const timestamps = rateLimitCache.get(ip) ?? [];

                // Drop timestamps outside the current window
                const windowStart = now - LIMIT_MS;
                const recent = timestamps.filter(t => t > windowStart);

                if (recent.length >= MAX_REQUESTS) {
                    const remainingSecs = Math.ceil((recent[0] + LIMIT_MS - now) / 1000);
                    return c.json({ 
                        error: 'Too Many Requests', 
                        message: `Rate limit exceeded. Please wait ${remainingSecs} seconds before trying again (${MAX_REQUESTS} requests per 10 seconds allowed).`
                    }, 429);
                }

                recent.push(now);
                rateLimitCache.set(ip, recent);
            }

            // Purge stale entries when cache grows too large
            if (rateLimitCache.size > 1000) {
                const expireTime = now - LIMIT_MS;
                for (const [key, timestamps] of rateLimitCache.entries()) {
                    if (timestamps.every(t => t < expireTime)) {
                        rateLimitCache.delete(key);
                    }
                }
            }
        }

        await next();
    };
};