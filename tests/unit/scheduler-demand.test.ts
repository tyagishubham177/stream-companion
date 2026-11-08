import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository, txPut } from '../../src/background/repository';
import { Scheduler, type Credential } from '../../src/background/scheduler';

const credential: Credential = { key: 'synthetic-test-key', id: 'synthetic-credential', version: 1 };
const fixtureResponse = () => new Response(JSON.stringify({ Response: 'True', Title: 'Synthetic fixture title' }), {
  headers: { 'Content-Type': 'application/json' },
});
const decode = (raw: unknown) => raw;
function repository(): Repository { return new Repository(`scheduler-demand-${crypto.randomUUID()}`); }

function holdingFetcher(): { fetcher: typeof fetch; releases: Array<(response: Response) => void>; calls: () => number } {
  const releases: Array<(response: Response) => void> = [];
  let count = 0;
  const fetcher: typeof fetch = async () => {
    count++;
    return count <= 2 ? await new Promise<Response>(resolve => releases.push(resolve)) : fixtureResponse();
  };
  return { fetcher, releases, calls: () => count };
}

describe('scheduler dispatch eligibility and shared live demand', () => {
  beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('drops an automatic title without live demand before charging a request', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async () => fixtureResponse());
    const scheduler = new Scheduler(repo, async () => credential, fetcher);
    await expect(scheduler.request({ i: 'tt0000001' }, false, decode, false, () => false))
      .rejects.toMatchObject({ reason: 'busy', message: expect.stringContaining('no longer visible') });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.all('attempts')).toHaveLength(0);
  });

  it('blocks disabled automatic work but keeps explicit actions available', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async () => fixtureResponse());
    const scheduler = new Scheduler(repo, async () => credential, fetcher, async () => ({ enabled: false, cacheOnly: false }));
    await expect(scheduler.request({ i: 'tt0000001' }, false, decode)).rejects.toMatchObject({ reason: 'busy' });
    expect(await repo.all('attempts')).toHaveLength(0);
    await scheduler.request({ i: 'tt0000001' }, true, decode);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('blocks cache-only explicit lookups while allowing a deliberate key retest', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async () => fixtureResponse());
    const scheduler = new Scheduler(repo, async () => credential, fetcher, async () => ({ enabled: false, cacheOnly: true }));
    await expect(scheduler.request({ i: 'tt0000001' }, true, decode)).rejects.toMatchObject({ reason: 'provider' });
    expect(await repo.all('attempts')).toHaveLength(0);
    await scheduler.request({ i: 'tt0000001' }, true, decode, true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rechecks settings after reservation and releases the lease while keeping its charge', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async () => fixtureResponse());
    let checks = 0;
    const scheduler = new Scheduler(repo, async () => credential, fetcher, async () => ({ enabled: true, cacheOnly: ++checks >= 2 }));
    await expect(scheduler.request({ i: 'tt0000001' }, false, decode)).rejects.toMatchObject({ reason: 'provider' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.all('attempts')).toHaveLength(1);
    expect(await repo.all('leases')).toHaveLength(0);
    expect((await scheduler.status()).circuit).toBeUndefined();
  });

  it('rechecks live demand after a busy dispatch delay without charging an attempt', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async () => fixtureResponse());
    const scheduler = new Scheduler(repo, async () => credential, fetcher);
    const reserve = vi.spyOn(scheduler, 'reserve');
    reserve.mockResolvedValue({ blocked: 'busy', retryAfter: Date.now() + 100 });
    let active = true;
    const result = scheduler.request({ i: 'tt0000001' }, false, decode, false, () => active);
    const rejected = expect(result).rejects.toMatchObject({ reason: 'busy', message: expect.stringContaining('no longer visible') });
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(1));
    active = false;
    await rejected;
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.all('attempts')).toHaveLength(0);
  });

  it('keeps a deduplicated request when another visible document still needs it', async () => {
    const repo = repository();
    const held = holdingFetcher();
    const scheduler = new Scheduler(repo, async () => credential, held.fetcher);
    const first = scheduler.request({ i: 'tt0000001' }, false, decode);
    const second = scheduler.request({ i: 'tt0000002' }, false, decode);
    await vi.waitFor(() => expect(held.calls()).toBe(2), { timeout: 2000 });
    const original = scheduler.request({ i: 'tt0000003' }, false, decode, false, () => false);
    const attached = scheduler.request({ i: 'tt0000003' }, false, decode, false, () => true);
    await Promise.resolve();
    for (const release of held.releases) release(fixtureResponse());
    const results = await Promise.all([first, second, original, attached]);
    expect(results[2]).toEqual(results[3]);
    expect(held.calls()).toBe(3);
    expect(await repo.all('attempts')).toHaveLength(3);
  });

  it('promotes queued shared work to the explicit request reserve', async () => {
    const repo = repository();
    await repo.transaction(['attempts'], async tx => {
      for (let i = 0; i < 800; i++) txPut(tx, 'attempts', `seed-${i}`, { credential: credential.id, at: Date.now(), outcome: 'synthetic' });
    });
    const held = holdingFetcher();
    const scheduler = new Scheduler(repo, async () => credential, held.fetcher);
    const first = scheduler.request({ i: 'tt0000001' }, true, decode);
    const second = scheduler.request({ i: 'tt0000002' }, true, decode);
    await vi.waitFor(() => expect(held.calls()).toBe(2), { timeout: 2000 });
    const automatic = scheduler.request({ i: 'tt0000003' }, false, decode, false, () => false);
    const explicit = scheduler.request({ i: 'tt0000003' }, true, decode);
    await Promise.resolve();
    for (const release of held.releases) release(fixtureResponse());
    await Promise.all([first, second, automatic, explicit]);
    expect(held.calls()).toBe(3);
    expect((await scheduler.status()).count).toBe(803);
  });
});

it('cancels queued identity work when matching is disabled while allowing known rating refreshes', async()=>{
 const repo=repository(); let enabled=true;
 const fetcher=vi.fn<typeof fetch>(async()=>fixtureResponse());
 const scheduler=new Scheduler(repo,async()=>credential,fetcher,async()=>({enabled:true,cacheOnly:false,automaticMatching:enabled}));
 const reserve=vi.spyOn(scheduler,'reserve'); reserve.mockResolvedValueOnce({blocked:'busy',retryAfter:Date.now()+100});
 const waiting=scheduler.request({s:'Fixture'},false,decode,false,()=>true,true);
 await vi.waitFor(()=>expect(reserve).toHaveBeenCalledTimes(1)); enabled=false;
 await expect(waiting).rejects.toMatchObject({reason:'busy'}); expect(fetcher).not.toHaveBeenCalled();
 expect(await repo.all('attempts')).toHaveLength(0);
 await scheduler.request({i:'tt0000001'},false,decode,false,()=>true);
 expect(fetcher).toHaveBeenCalledTimes(1);
});
