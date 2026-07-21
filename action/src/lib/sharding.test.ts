import { describe, expect, it } from 'vitest';
import { shardFiles } from './sharding.js';

describe('shardFiles', () => {
  it('puts all files in one shard when within budget', () => {
    const result = shardFiles(
      [
        { path: 'a.ts', sizeBytes: 100 },
        { path: 'b.ts', sizeBytes: 100 },
      ],
      { maxFilesPerShard: 10, maxBytesPerShard: 10_000, maxShards: 10 },
    );

    expect(result.shards).toHaveLength(1);
    expect(result.shards[0]?.files).toEqual(['a.ts', 'b.ts']);
    expect(result.incomplete).toBe(false);
  });

  it('splits into multiple shards when maxFilesPerShard is exceeded', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, sizeBytes: 10 }));
    const result = shardFiles(files, { maxFilesPerShard: 2, maxBytesPerShard: 10_000, maxShards: 10 });

    expect(result.shards).toHaveLength(2);
    expect(result.shards[0]?.files).toEqual(['a.ts', 'b.ts']);
    expect(result.shards[1]?.files).toEqual(['c.ts']);
    expect(result.incomplete).toBe(false);
  });

  it('splits into multiple shards when maxBytesPerShard is exceeded', () => {
    const files = [
      { path: 'a.ts', sizeBytes: 600 },
      { path: 'b.ts', sizeBytes: 600 },
    ];
    const result = shardFiles(files, { maxFilesPerShard: 10, maxBytesPerShard: 1000, maxShards: 10 });

    expect(result.shards).toHaveLength(2);
    expect(result.incomplete).toBe(false);
  });

  it('marks incomplete and truncates when more shards would be needed than maxShards', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, sizeBytes: 10 }));
    const result = shardFiles(files, { maxFilesPerShard: 1, maxBytesPerShard: 10_000, maxShards: 2 });

    expect(result.shards).toHaveLength(2);
    expect(result.incomplete).toBe(true);
  });

  it('marks incomplete when a single file alone exceeds maxBytesPerShard', () => {
    const files = [{ path: 'huge.ts', sizeBytes: 5000 }];
    const result = shardFiles(files, { maxFilesPerShard: 10, maxBytesPerShard: 1000, maxShards: 10 });

    expect(result.incomplete).toBe(true);
    expect(result.shards).toHaveLength(1);
    expect(result.shards[0]?.files).toEqual(['huge.ts']);
  });

  it('assigns stable, unique shard ids', () => {
    const files = ['a.ts', 'b.ts'].map((path) => ({ path, sizeBytes: 10 }));
    const result = shardFiles(files, { maxFilesPerShard: 1, maxBytesPerShard: 10_000, maxShards: 10 });

    const ids = result.shards.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
