import '../shared/utils/patch-caches.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleLyricsRequest, handleRawLyricsRequest } from '../modules/lyrics/lyrics.handler.js';
import { handleSonglistSearch } from '../modules/songCatalog/songCatalog.handler.js';
import { handleMetadataGet } from '../modules/metadata/metadata.handler.js';
import { handleChallenge, handleSubmit } from '../modules/submit/submit.handler.js';
import { handleMusixmatchTest } from '../modules/test/test.handler.js';
import { runWithRequestContext, flushLogs } from '../shared/utils/logger.util.js';
import { rateLimiter } from '../shared/middleware/rateLimit.middleware.js';
import { cache } from 'hono/cache';

const app = new Hono();

// Apply server-side cache to lyrics and metadata routes
const cacheOptions = { cacheName: 'lyricsplus', cacheControl: 'max-age=3600', wait: true };
app.use('/v1/lyrics/*', cache(cacheOptions));
app.use('/v2/lyrics/*', cache(cacheOptions));
app.use('/v1/ttml/*', cache(cacheOptions));
app.use('/v1/raw/*', cache(cacheOptions));
app.use('/v1/metadata/*', cache(cacheOptions));

//proper logging
app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    c.set('requestId', requestId);
    return runWithRequestContext({ requestId, buffer: [] }, async () => {
        await next();
        flushLogs();
    });
});

//add cors
app.use('*', cors());

// Apply rate limiter globally
app.use('*', rateLimiter());

app.get('/', (c) => c.text('Seems, you trying to find out about our api huh?'));

// Lyrics routes
app.get('/v1/lyrics/get', (c) => {
    c.set('format', 'v1');
    return handleLyricsRequest(c);
});
app.get('/v2/lyrics/get', handleLyricsRequest);
app.get('/v1/ttml/get', (c) => {
    c.set('format', 'ttml');
    return handleLyricsRequest(c);
});
app.get('/v1/raw/get', handleRawLyricsRequest);

// Song Catalog routes
app.get('/v1/songlist/search', handleSonglistSearch);

// Metadata routes
app.get('/v1/metadata/get', handleMetadataGet);

// Submit routes
app.get('/v1/lyricsplus/challenge', handleChallenge);
app.post('/v1/lyricsplus/submit', handleSubmit);

// Test routes
app.get('/v1/test/musixmatch', handleMusixmatchTest);

export default app;
