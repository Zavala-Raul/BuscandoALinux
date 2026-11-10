/**
 * Punto de entrada principal de Vercel Functions (Node.js runtime).
 * Usa el estándar Web Fetch API (export default { fetch }) soportado nativamente por Vercel.
 */
import { createApp } from '../server/app.js';

const app = createApp();

export default {
  fetch(req: Request) {
    const url = new URL(req.url);
    const rewrittenPath = url.searchParams.get('__path');
    if (rewrittenPath !== null) {
      url.searchParams.delete('__path');
      if (url.pathname === '/api/index' || url.pathname === '/api') {
        const cleanSubpath = rewrittenPath.replace(/^\/+/, '');
        url.pathname = cleanSubpath ? `/api/${cleanSubpath}` : '/api';
      }
      const init: RequestInit & { duplex?: 'half' } = {
        method: req.method,
        headers: req.headers,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
        init.body = req.body;
        init.duplex = 'half';
      }
      return app.fetch(new Request(url.toString(), init));
    }
    return app.fetch(req);
  },
};
