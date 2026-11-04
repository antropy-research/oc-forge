// The VS Code Server as the service reaches it: its page (workbench
// configuration and commit), its static files and its remote resources. Every
// call ends within the host's request budget.
import { commitOfBase, readServerPage, type ServerWorkbenchConfig } from '../src/workbench.ts';

const PAGE_TIMEOUT_MS = 8_000;
const FILE_TIMEOUT_MS = 15_000;
/** A remote resource or gallery answer, raw; base64 in the 8 MB host answer leaves room for this. */
export const RESOURCE_MAX = 5_500_000;

export class ServerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ServerPage {
  config: ServerWorkbenchConfig;
  /** Base URL path of its static files, `/stable-<commit>/static`. */
  base: string;
  commit: string;
}

export class VscodeServer {
  readonly origin: string;

  constructor(readonly url: string, private readonly token: string | null) {
    this.origin = new URL(url).origin;
  }

  private headers(): Record<string, string> {
    return this.token ? { cookie: `vscode-tkn=${this.token}` } : {};
  }

  /** The workbench page: its configuration and the commit it serves. */
  async page(): Promise<ServerPage> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/`, { headers: this.headers(), redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    } catch (error) {
      throw new ServerError(`The VS Code Server at ${this.url} did not answer (${error instanceof Error ? error.message : String(error)}).`, 502);
    }
    if (response.status === 403 || response.status === 401) throw new ServerError('The VS Code Server refused the connection token.', 403);
    if (response.status >= 300 && response.status < 400) throw new ServerError('The VS Code Server redirected; set the token, or the address it serves the workbench on.', 403);
    if (!response.ok) throw new ServerError(`The VS Code Server answered ${response.status}.`, 502);
    const page = readServerPage(await response.text());
    if (!page) throw new ServerError(`${this.url} does not look like a VS Code Server for the web.`, 502);
    const commit = commitOfBase(page.base);
    if (!commit) throw new ServerError(`The VS Code Server's base URL (${page.base}) names no commit.`, 502);
    return { ...page, commit };
  }

  /** A file of the server's install (`out/...`, `node_modules/...`) through its static route, or null when it has none. */
  async staticFile(base: string, path: string): Promise<Buffer | null> {
    const response = await fetch(`${this.origin}${base}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: this.headers(), signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (response.status === 404) return null;
    if (!response.ok) throw new ServerError(`${path}: the VS Code Server answered ${response.status}.`, 502);
    return Buffer.from(await response.arrayBuffer());
  }

  /** `package.json` of the install, for its version. */
  async version(base: string): Promise<string | null> {
    try {
      const body = await this.staticFile(base, 'package.json');
      const version = body ? (JSON.parse(body.toString('utf8')) as { version?: unknown }).version : null;
      return typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  }

  /**
   * A GET the workbench makes to the server (a remote resource, a static or
   * web extension file), by its path and query on the server.
   */
  async get(pathAndQuery: string): Promise<{ status: number; contentType: string; body: Buffer }> {
    const target = new URL(pathAndQuery, this.origin);
    if (target.origin !== this.origin || !target.pathname.startsWith(new URL(this.url).pathname.replace(/\/?$/, '/'))) {
      throw new ServerError('That path is not on the VS Code Server.', 400);
    }
    if (this.token && target.pathname.endsWith('/vscode-remote-resource') && !target.searchParams.has('tkn')) target.searchParams.set('tkn', this.token);
    const response = await fetch(target, { headers: this.headers(), redirect: 'manual', signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > RESOURCE_MAX) throw new ServerError(`${target.pathname}: larger than ${RESOURCE_MAX} bytes.`, 413);
    return { status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', body };
  }

  /** The web socket address for a path the workbench connects to, with the token the server checks on upgrade. */
  socketUrl(pathAndQuery: string): string {
    const target = new URL(pathAndQuery, this.origin);
    if (target.origin !== this.origin) throw new ServerError('That socket is not on the VS Code Server.', 400);
    if (this.token && !target.searchParams.has('tkn')) target.searchParams.set('tkn', this.token);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    return target.toString();
  }

  socketHeaders(): Record<string, string> {
    return this.headers();
  }
}
