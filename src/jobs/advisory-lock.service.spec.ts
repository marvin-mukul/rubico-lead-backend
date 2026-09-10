import { randomUUID } from 'node:crypto';
import { testConfig } from '../../test/support/config.factory.js';
import { AdvisoryLockService } from './advisory-lock.service.js';

describe('AdvisoryLockService (FR-B6) [integration]', () => {
  const locks = new AdvisoryLockService(testConfig());

  it('grants a free lock and refuses a second holder', async () => {
    const key = `job:test-${randomUUID()}`;
    const first = await locks.tryAcquire(key);
    expect(first).not.toBeNull();

    // A different session must not get the same lock.
    expect(await locks.tryAcquire(key)).toBeNull();

    await first!.release();
  });

  it('makes the lock available again after release', async () => {
    const key = `job:test-${randomUUID()}`;
    const first = await locks.tryAcquire(key);
    await first!.release();

    const second = await locks.tryAcquire(key);
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('does not block unrelated keys', async () => {
    const a = await locks.tryAcquire(`job:test-${randomUUID()}`);
    const b = await locks.tryAcquire(`job:test-${randomUUID()}`);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it('tolerates a double release', async () => {
    const key = `job:test-${randomUUID()}`;
    const lock = await locks.tryAcquire(key);
    await lock!.release();
    await expect(lock!.release()).resolves.toBeUndefined();
  });
});
