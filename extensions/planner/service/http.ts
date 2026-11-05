// The service's HTTP layer, the same for every route: a request carries OpenChamber's bearer token (401 without
// it), a body is JSON of at most 1 MB, and every answer is JSON. The routes are tried in order and the first that
// answers does; none: 404; one that throws: 500, with what went wrong.
import http from 'node:http';
import { messageOf } from '../src/domain/core/values.ts';
import type { Context } from './context.ts';

const BODY_LIMIT = 1_000_000;

/** A route's answer: its status and JSON body; `after` runs once the answer is on its way. */
export type Answer = { status: number; body: unknown; after?: () => void };

/** One feature's routes: the answer, or null when the request is none of them. */
export type Route = (ctx: Context, req: http.IncomingMessage, url: URL) => Promise<Answer | null>;

export const ok = (body: unknown, after?: () => void): Answer => ({ status: 200, body, after });
export const bad = (error: string): Answer => ({ status: 400, body: { error } });

/** The request's JSON body, {} when it has none; one too large, or not JSON, throws. */
export const readJson = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** The service's server: each request with `token` goes to `routes`, in order, over `ctx`. */
export const createServer = (ctx: Context, token: string, routes: readonly Route[]): http.Server =>
  http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    // A request target no URL reads is refused, not left to throw out of the handler (and the process).
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      json(res, 400, { error: 'bad request target' });
      return;
    }
    try {
      for (const route of routes) {
        const answer = await route(ctx, req, url);
        if (!answer) continue;
        json(res, answer.status, answer.body);
        answer.after?.();
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      // Once the answer is on its way, what fails after it is only told.
      if (res.headersSent) ctx.log(`${url.pathname}: ${messageOf(error)}`);
      else json(res, 500, { error: messageOf(error) });
    }
  });
