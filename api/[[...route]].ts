/**
 * Punto de entrada de Vercel Functions (Node.js runtime).
 * Usa el estándar Web Fetch API (export default { fetch }) soportado nativamente por Vercel.
 */
import { createApp } from '../server/app.js';

const app = createApp();

export default {
  fetch: app.fetch,
};
