import { errorResponse } from './env';

export type RouteHandler<Env> = (
  request: Request,
  env: Env,
  params: Record<string, string>,
  ctx?: ExecutionContext,
) => Promise<Response>;

interface Route<Env> {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler<Env>;
}

function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a path like `/devices/:token` into a matcher and the names
 * of its `:param` segments, in order. */
function compile(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return escapeRegExp(segment);
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

/** A minimal router: no framework, no middleware. An unknown path is
 * 404; a known path with the wrong method is 405 with `Allow`. */
export class Router<Env> {
  private readonly routes: Route<Env>[] = [];

  add(method: string, path: string, handler: RouteHandler<Env>): void {
    const { regex, paramNames } = compile(path);
    this.routes.push({ method, regex, paramNames, handler });
  }

  async handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const matchingPath = this.routes.filter((route) => route.regex.test(pathname));
    if (matchingPath.length === 0) {
      return errorResponse('not_found', 404);
    }
    const route = matchingPath.find((candidate) => candidate.method === request.method);
    if (!route) {
      const allowed = [...new Set(matchingPath.map((candidate) => candidate.method))].join(', ');
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', Allow: allowed },
      });
    }
    const match = route.regex.exec(pathname);
    const params: Record<string, string> = {};
    if (match) {
      try {
        route.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(match[index + 1]);
        });
      } catch {
        // A malformed `%` escape (URIError) is the client's mistake.
        return errorResponse('invalid_path', 400);
      }
    }
    return route.handler(request, env, params, ctx);
  }
}
