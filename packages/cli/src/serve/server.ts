import * as http from 'node:http';
import { handleRequest } from './pipeline.js';
import { ServeState } from './state.js';
import type { ServeOptions } from './state.js';

export interface BrainServer {
  /** The port actually bound — the real number even when --port 0 was asked for. */
  port: number;
  state: ServeState;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  constructor(public readonly port: number) {
    super(`port ${port} is already in use`);
    this.name = 'PortInUseError';
  }
}

/**
 * Bind exactly one port on 127.0.0.1. Probing a range and deciding what an
 * EADDRINUSE means is the caller's job (commands/serve.ts) — this function
 * either serves or throws.
 */
export function startBrainServer(opts: ServeOptions): Promise<BrainServer> {
  const state = new ServeState(opts);
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, state).catch(() => {
      // handleRequest already answers every error it knows about; this is the
      // last resort so one bad request can never take the process down.
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"bad_request","message":"internal error"}');
      } catch {
        /* socket already gone */
      }
    });
  });

  // Slowloris caps. A localhost server still faces every page the user visits.
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 40;

  return new Promise<BrainServer>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err.code === 'EADDRINUSE' ? new PortInUseError(opts.port) : err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      // Gate 3 compares the Host header against this, so it must be the REAL
      // port, not the requested one — otherwise --port 0 rejects everything.
      state.port = port;
      resolve({
        port,
        state,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Without this a keep-alive socket held by the extension keeps the
            // process alive well past Ctrl-C. Landed in Node 18.2 and the CI
            // matrix includes Node 18, hence the optional call.
            server.closeAllConnections?.();
          }),
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, '127.0.0.1');
  });
}
