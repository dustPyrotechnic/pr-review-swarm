#!/usr/bin/env node
// Regenerates schemas/expert-output.schema.json's candidate_findings.maxItems
// from action/config/central-limits.json.maxCandidateFindingsPerAgentPerShard,
// so the two numbers never drift apart. Run after changing that config value.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const limitsPath = path.join(repoRoot, 'action/config/central-limits.json');
const schemaPath = path.join(repoRoot, 'schemas/expert-output.schema.json');

const limits = JSON.parse(readFileSync(limitsPath, 'utf-8'));
const maxItems = limits.maxCandidateFindingsPerAgentPerShard;
if (!Number.isInteger(maxItems) || maxItems < 1) {
  throw new Error(
    `generate-expert-output-schema: invalid maxCandidateFindingsPerAgentPerShard in ${limitsPath}`,
  );
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
schema.properties.candidate_findings.maxItems = maxItems;
writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n');

console.log(`generate-expert-output-schema: set maxItems=${maxItems} in ${schemaPath}`);
