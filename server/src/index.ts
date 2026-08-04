import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRouter } from './routes.js';
import { ApiError } from './types.js';

const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.use('/api', createRouter());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'rocimail', version: '0.1.0' });
});

// Serve the built frontend in production (web/dist), with SPA fallback.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[rocimail] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Rocimail server listening on http://localhost:${PORT}`);
});
