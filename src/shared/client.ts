import { PROTOCOL_VERSION, type Reply, type Request } from './contracts';

export class ExtensionContextInvalidatedError extends Error {
  constructor() { super('Stream Companion was reloaded or disconnected. Refresh this page to reconnect.'); }
}

export class ExtensionBusyError extends Error {
  constructor(readonly retryAfter: number, message = 'Too many extension requests. Try again shortly.') { super(message); }
}

export function extensionContextAlive(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

export async function rpc<T>(request: Request): Promise<T> {
  if (!extensionContextAlive()) throw new ExtensionContextInvalidatedError();
  let reply: Reply<T> | undefined;
  try { reply = await chrome.runtime.sendMessage({ protocol: PROTOCOL_VERSION, ...request }); }
  catch (error) {
    if (!extensionContextAlive() || (error instanceof Error && /extension context invalidated/i.test(error.message)))
      throw new ExtensionContextInvalidatedError();
    throw new Error('Extension connection lost. Reload this page and try again.');
  }
  if (!reply) throw new Error('The extension did not respond. Reload this page.');
  if (!reply.ok) {
    if (reply.retryAfter !== undefined && Number.isFinite(reply.retryAfter)) throw new ExtensionBusyError(reply.retryAfter, reply.error);
    throw new Error(reply.error);
  }
  return reply.value;
}
