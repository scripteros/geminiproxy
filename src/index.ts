import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config } from 'dotenv';
import { chatCompletions } from './routes/chat.ts';

config();

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

// Basic healthcheck
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);
app.get('/v1/models', (c) => c.json({
  object: "list",
  data: [
    { id: "gemini-2.5-flash", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" },
    { id: "gemini-2.5-pro", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" },
    { id: "gemini-2.0-flash", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" },
    { id: "gemini-2.0-flash-lite-preview-02-05", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" },
    { id: "gemini-2.0-pro-exp-02-05", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" },
    { id: "gemini-3.5-flash-preview", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" },
    { id: "gemini-3.5-pro-preview", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" },
    { id: "imagen-3.0-generate-002", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "google" }
  ]
}));

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`🚀 GeminiProxy started!`);
console.log(`- Local:   http://localhost:${port}`);
console.log(`\nAvailable Routes:`);
console.log(`- [GET]  /health`);
console.log(`- [POST] /v1/chat/completions`);
console.log(`- [GET]  /v1/models`);

serve({
  fetch: app.fetch,
  port
});
