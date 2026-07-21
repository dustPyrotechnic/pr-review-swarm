export interface ShardInput {
  path: string;
  sizeBytes: number;
}

export interface Shard {
  id: string;
  files: string[];
}

export interface ShardingBudget {
  maxFilesPerShard: number;
  maxBytesPerShard: number;
  maxShards: number;
}

export interface ShardingResult {
  shards: Shard[];
  incomplete: boolean;
}

export function shardFiles(files: ShardInput[], budget: ShardingBudget): ShardingResult {
  const shards: Shard[] = [];
  let currentFiles: string[] = [];
  let currentBytes = 0;
  let incomplete = false;

  function flush(): void {
    if (currentFiles.length > 0) {
      shards.push({ id: `shard-${shards.length + 1}`, files: currentFiles });
      currentFiles = [];
      currentBytes = 0;
    }
  }

  for (const file of files) {
    if (file.sizeBytes > budget.maxBytesPerShard) {
      incomplete = true;
    }

    const wouldExceedFileCount = currentFiles.length + 1 > budget.maxFilesPerShard;
    const wouldExceedBytes =
      currentFiles.length > 0 && currentBytes + file.sizeBytes > budget.maxBytesPerShard;

    if (wouldExceedFileCount || wouldExceedBytes) {
      flush();
    }

    currentFiles.push(file.path);
    currentBytes += file.sizeBytes;
  }
  flush();

  if (shards.length > budget.maxShards) {
    incomplete = true;
    shards.length = budget.maxShards;
  }

  return { shards, incomplete };
}
