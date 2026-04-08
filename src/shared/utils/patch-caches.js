import { CacheStorage } from './kv.emulator.js';

// Polyfill the Web Cache API (caches) for Node.js environments
// This must be imported before any middleware that uses the Cache API (like hono/cache)
const patchCaches = () => {
    if (!globalThis.caches) {
        const storage = new CacheStorage();
        globalThis.caches = storage;
        
        // Also add to global for older Node versions or specific check logic
        if (typeof global !== 'undefined') {
            global.caches = storage;
        }
        
        console.log('[Polyfill] Web Cache API initialized');
    } else {
        
        console.log('[Polyfill] Web Cache API detected, using native implementation');
    }
};

patchCaches();

export { patchCaches };
