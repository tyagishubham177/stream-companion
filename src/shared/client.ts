import { PROTOCOL_VERSION, type Reply, type Request } from './contracts';

export async function rpc<T>(request: Request): Promise<T> {
  let reply: Reply<T> | undefined;
  try { reply = await chrome.runtime.sendMessage({ protocol: PROTOCOL_VERSION, ...request }); }
  catch { throw new Error('Extension connection lost. Reload this page and try again.'); }
  if (!reply) throw new Error('The extension did not respond. Reload this page.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
