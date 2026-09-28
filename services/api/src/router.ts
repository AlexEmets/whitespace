import type { IncomingMessage } from 'node:http';

export type RouteResult = { code: number; body: unknown };
export type Handler = (
  req: IncomingMessage,
  params: Record<string, string>,
  searchParams: URLSearchParams,
) => Promise<RouteResult>;

type Route = { method: string; pattern: RegExp; paramNames: string[]; handler: Handler };

function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const patternSource = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${patternSource}$`), paramNames };
}

export class Router {
  private routes: Route[] = [];

  get(path: string, handler: Handler): void {
    const { pattern, paramNames } = compile(path);
    this.routes.push({ method: 'GET', pattern, paramNames, handler });
  }

  post(path: string, handler: Handler): void {
    const { pattern, paramNames } = compile(path);
    this.routes.push({ method: 'POST', pattern, paramNames, handler });
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? '');
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}
