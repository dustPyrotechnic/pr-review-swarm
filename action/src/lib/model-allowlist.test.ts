import { describe, expect, it } from 'vitest';
import { assertModelAllowed } from './model-allowlist.js';
import allowedModelsConfig from '../../config/allowed-models.json' with { type: 'json' };

describe('assertModelAllowed', () => {
  it('does not throw for a model present in the allowlist', () => {
    const [firstAllowed] = allowedModelsConfig.allowedModels;
    expect(() => assertModelAllowed(firstAllowed as string)).not.toThrow();
  });

  it('throws for a model not present in the allowlist', () => {
    expect(() => assertModelAllowed('definitely-not-an-allowed-model')).toThrow(
      /not in the allowed models list/,
    );
  });
});
