import NodeCache from 'node-cache';

/**
 * Emulates Cloudflare KV storage using node-cache.
 */
export class KvEmulator {
    constructor(namespace) {
        this.namespace = namespace;
        this.cache = new NodeCache({
            stdTTL: 0,
            checkperiod: 60,
            useClones: false,
            deleteOnExpire: true
        });
    }

    /**
     * Gets a value from the KV store.
     * @param {string} key 
     * @param {Object} options - Supports { type: 'json' }
     */
    async get(key, options = {}) {
        const item = this.cache.get(key);
        if (item === undefined) return null;

        const type = typeof options === 'string' ? options : options.type;
        if (type === 'json' && typeof item === 'string') {
            try {
                return JSON.parse(item);
            } catch {
                return item;
            }
        }
        return item;
    }

    /**
     * Puts a value into the KV store.
     * @param {string} key 
     * @param {any} value 
     * @param {Object} options - Supports { expirationTtl, metadata }
     */
    async put(key, value, options = {}) {
        const ttl = options.expirationTtl || 0;
        this.cache.set(key, value, ttl);
        // Metadata not natively supported in node-cache but we can store it separately if needed
    }

    async delete(key) {
        this.cache.del(key);
    }

    async list(options = {}) {
        const { prefix, limit = 1000 } = options;
        const keys = this.cache.keys();
        const filteredKeys = [];
        let count = 0;

        for (const key of keys) {
            if (prefix && !key.startsWith(prefix)) continue;
            filteredKeys.push({ name: key });
            count++;
            if (count >= limit) break;
        }

        return { 
            keys: filteredKeys,
            list_complete: true,
            cursor: null
        };
    }
}

/**
 * Emulates the Web Cache API using node-cache.
 */
export class Cache {
    constructor(namespace) {
        this.cache = new NodeCache({
            stdTTL: 3600,
            checkperiod: 120,
            useClones: false
        });
    }

    async match(request) {
        const url = typeof request === 'string' ? request : request.url;
        const cached = this.cache.get(url);
        
        if (!cached) return undefined;

        try {
            const { body, status, statusText, headers } = cached;
            return new Response(body, { 
                status: status || 200, 
                statusText: statusText || 'OK',
                headers: new Headers(headers || {})
            });
        } catch (e) {
            console.error(`[Cache] Error creating response from cache for ${url}:`, e);
            return undefined;
        }
    }

    async put(request, response) {
        const url = typeof request === 'string' ? request : request.url;
        if (response.status !== 200) return;

        try {
            const resClone = response.clone();
            const body = await resClone.text();
            const headers = Object.fromEntries(resClone.headers.entries());

            const cacheControl = resClone.headers.get('Cache-Control');
            let ttl = 3600;
            if (cacheControl) {
                const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
                if (maxAgeMatch) ttl = parseInt(maxAgeMatch[1], 10);
            }

            this.cache.set(url, {
                body,
                status: resClone.status,
                statusText: resClone.statusText,
                headers
            }, ttl);
        } catch (e) {
            console.error(`[Cache] Error storing response for ${url}:`, e);
        }
    }

    async delete(request) {
        const url = typeof request === 'string' ? request : request.url;
        this.cache.del(url);
        return true;
    }
}

/**
 * Emulates the Global caches object.
 */
export class CacheStorage {
    constructor() {
        this.cacheMap = new Map();
    }

    async open(cacheName) {
        if (!this.cacheMap.has(cacheName)) {
            this.cacheMap.set(cacheName, new Cache(cacheName));
        }
        return this.cacheMap.get(cacheName);
    }

    async delete(cacheName) {
        return this.cacheMap.delete(cacheName);
    }

    async keys() {
        return Array.from(this.cacheMap.keys());
    }

    async has(cacheName) {
        return this.cacheMap.has(cacheName);
    }
}
