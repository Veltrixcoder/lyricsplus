import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleLyricsRequest, handleRawLyricsRequest } from '../modules/lyrics/lyrics.handler.js';
import { handleSonglistSearch } from '../modules/songCatalog/songCatalog.handler.js';
import { handleMetadataGet } from '../modules/metadata/metadata.handler.js';
import { runWithRequestContext, flushLogs } from '../shared/utils/logger.util.js';
import { rateLimiter } from '../shared/middleware/rateLimit.middleware.js';

const app = new Hono();

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

export default app;
