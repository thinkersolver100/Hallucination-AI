export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

function emit(level: string, msg: string, ctx?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...ctx }));
}

/** Never pass passwords, cookies, API keys or request bodies in ctx. */
export const consoleLogger: Logger = {
  info: (msg, ctx) => emit('info', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
};

export const silentLogger: Logger = { info: () => {}, error: () => {} };
