import app from './app.js';
import { serve } from '@hono/node-server';

const port = process.env.PORT || 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: (req) => app.fetch(req, {}),
  port
});