import { handleAssistant, handleAssistantPreflight, pruneAssistantUsage } from './assistant/handler';
import { handleTestPage, handleWidgetScript } from './assistant/widget';
import type { Env } from './env';
import { Router } from './router';

export type { Env };

/** No CORS, except `/asistente` (the web chat on the store's own sites,
 * see `assistant/handler.ts`). */
const router = new Router<Env>();
router.add('POST', '/asistente', handleAssistant);
router.add('OPTIONS', '/asistente', handleAssistantPreflight);
router.add('GET', '/asistente/widget.js', (request, env) => handleWidgetScript(env));
router.add('GET', '/asistente/prueba', handleTestPage);

export default {
  /** `ctx` is always given by the runtime; it is optional only so unit
   * tests can call `fetch(request, env)`. */
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    return router.handle(request, env, ctx);
  },

  /** Daily cron (`[triggers]` in wrangler.toml): forgets old usage
   * counters. */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await pruneAssistantUsage(env, Date.now());
  },
} satisfies ExportedHandler<Env>;
