/**
 * Vite demo adapter: /wrg-demo/route → persistent wrg_route.py --stdio-json.
 * Not a production backend. Does not mutate wg_edges or production routing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

function parseQuery(url: string): URLSearchParams {
  const q = url.indexOf('?');
  return new URLSearchParams(q >= 0 ? url.slice(q + 1) : '');
}

function json(res: Connect.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

class WrgStdioBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private ready = false;
  private starting: Promise<void> | null = null;
  private handshakeDone: (() => void) | null = null;
  private queue: Pending[] = [];
  private script: string;

  constructor(script: string) {
    this.script = script;
  }

  private failAll(err: Error): void {
    const q = this.queue.splice(0);
    for (const p of q) p.reject(err);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!this.ready) {
      if (msg.ready === true) {
        this.ready = true;
        this.handshakeDone?.();
        this.handshakeDone = null;
        return;
      }
      this.failAll(new Error('wrg_route stdio handshake failed'));
      return;
    }
    const next = this.queue.shift();
    if (next) next.resolve(msg);
  }

  async ensure(): Promise<void> {
    if (this.ready && this.proc && !this.proc.killed) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      if (!fs.existsSync(this.script)) {
        this.starting = null;
        reject(new Error(`wrg_route.py not found at ${this.script}`));
        return;
      }
      const proc = spawn('python3', ['-u', this.script, '--stdio-json'], {
        cwd: path.dirname(this.script),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      this.buf = '';
      this.ready = false;
      this.handshakeDone = () => {
        this.starting = null;
        resolve();
      };
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        const text = String(chunk).trim();
        if (text) console.info('[wrg-demo]', text);
      });
      proc.stdout.on('data', (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.onLine(line);
        }
      });
      proc.on('error', (err) => {
        this.ready = false;
        this.proc = null;
        this.starting = null;
        this.failAll(err);
        reject(err);
      });
      proc.on('exit', (code) => {
        this.ready = false;
        this.proc = null;
        this.starting = null;
        this.failAll(new Error(`wrg_route.py exited ${code}`));
      });
      setTimeout(() => {
        if (!this.ready) {
          this.starting = null;
          proc.kill();
          reject(new Error('wrg_route.py graph load timed out (60s)'));
        }
      }, 60_000);
    });
    return this.starting;
  }

  async route(req: {
    a_lon: number;
    a_lat: number;
    b_lon: number;
    b_lat: number;
  }): Promise<Record<string, unknown>> {
    await this.ensure();
    const proc = this.proc;
    if (!proc) throw new Error('wrg_route.py not running');
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      proc.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = false;
  }
}

function attach(server: {
  middlewares: Connect.Server;
  httpServer?: { on: (event: string, listener: () => void) => void } | null;
}, bridge: WrgStdioBridge): void {
  server.middlewares.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = req.url ?? '';
    if (!url.startsWith('/wrg-demo/')) {
      next();
      return;
    }
    if (url.startsWith('/wrg-demo/health')) {
      void bridge
        .ensure()
        .then(() => json(res, 200, { ok: true, ready: true }))
        .catch((err: Error) =>
          json(res, 503, {
            ok: false,
            status: 'RUNTIME_UNAVAILABLE',
            detail: err.message,
          }),
        );
      return;
    }
    if (!url.startsWith('/wrg-demo/route')) {
      next();
      return;
    }
    const q = parseQuery(url);
    const a_lon = Number(q.get('a_lon'));
    const a_lat = Number(q.get('a_lat'));
    const b_lon = Number(q.get('b_lon'));
    const b_lat = Number(q.get('b_lat'));
    if (![a_lon, a_lat, b_lon, b_lat].every(Number.isFinite)) {
      json(res, 400, { status: 'BAD_REQUEST', detail: 'need a_lon a_lat b_lon b_lat' });
      return;
    }
    void bridge
      .route({ a_lon, a_lat, b_lon, b_lat })
      .then((body) => json(res, 200, body))
      .catch((err: Error) =>
        json(res, 503, {
          status: 'RUNTIME_UNAVAILABLE',
          detail: `${err.message}. TODO: PostGIS + python3 water-data/ingest/wrg_route.py --stdio-json`,
        }),
      );
  });
  server.httpServer?.on('close', () => bridge.close());
}

export function wrgDemoPlugin(): Plugin {
  return {
    name: 'wrg-demo',
    configureServer(server) {
      const script = path.resolve(server.config.root, '../water-data/ingest/wrg_route.py');
      attach(server, new WrgStdioBridge(script));
    },
    configurePreviewServer(server) {
      const script = path.resolve(server.config.root, '../water-data/ingest/wrg_route.py');
      attach(server as unknown as ViteDevServer, new WrgStdioBridge(script));
    },
  };
}
