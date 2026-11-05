import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionContextInvalidatedError, extensionContextAlive, rpc } from '../../src/shared/client';

afterEach(() => { vi.unstubAllGlobals(); });

function connected() {
  const sendMessage = vi.fn();
  const runtime = { id: 'fixture-extension', sendMessage };
  vi.stubGlobal('chrome', { runtime });
  return { runtime, sendMessage };
}

describe('extension RPC context lifecycle', () => {
  it('does not send when a reloaded content script has lost its runtime ID', async () => {
    const { runtime, sendMessage } = connected();
    runtime.id = '';
    expect(extensionContextAlive()).toBe(false);
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('handles unavailable Chrome or runtime without accessing messaging', async () => {
    vi.stubGlobal('chrome', undefined);
    expect(extensionContextAlive()).toBe(false);
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);
    vi.stubGlobal('chrome', {});
    expect(extensionContextAlive()).toBe(false);
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);
  });

  it('sends the versioned request and returns a live worker reply', async () => {
    const { sendMessage } = connected();
    sendMessage.mockResolvedValue({ ok: true, value: { enabled: true } });
    expect(extensionContextAlive()).toBe(true);
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).resolves.toEqual({ enabled: true });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ protocol: 1, type: 'GET_PUBLIC_STATUS' });
  });

  it('classifies an invalidated-context rejection even if the stale runtime ID remains', async () => {
    const { sendMessage } = connected();
    sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);
  });

  it('recognizes a runtime ID lost while a request was in flight', async () => {
    const { runtime, sendMessage } = connected();
    sendMessage.mockImplementation(async () => { runtime.id = ''; throw new Error('Message port closed'); });
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('Could not establish connection. Receiving end does not exist.'),
    new Error('The message port closed before a response was received.'), 'unavailable'])
  ('keeps ordinary transport failures distinct from context invalidation: %s', async failure => {
    const { sendMessage } = connected();
    sendMessage.mockRejectedValue(failure);
    const error = await rpc({ type: 'GET_PUBLIC_STATUS' }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExtensionContextInvalidatedError);
    expect((error as Error).message).toBe('Extension connection lost. Reload this page and try again.');
  });

  it('reports an absent reply without treating the live context as invalid', async () => {
    const { sendMessage } = connected();
    sendMessage.mockResolvedValue(undefined);
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toThrow('The extension did not respond. Reload this page.');
    expect(extensionContextAlive()).toBe(true);
  });

  it('preserves a worker/provider failure message instead of hiding it as a disconnect', async () => {
    const { sendMessage } = connected();
    sendMessage.mockResolvedValue({ ok: false, error: 'OMDb has paused requests for this key.' });
    await expect(rpc({ type: 'GET_PUBLIC_STATUS' })).rejects.toThrow('OMDb has paused requests for this key.');
    expect(extensionContextAlive()).toBe(true);
  });
});
