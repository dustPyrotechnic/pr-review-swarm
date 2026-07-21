import { Ajv, type ValidateFunction } from 'ajv';
import candidateFindingSchema from '../../../schemas/candidate-finding.schema.json' with { type: 'json' };
import findingSchema from '../../../schemas/finding.schema.json' with { type: 'json' };
import expertOutputSchema from '../../../schemas/expert-output.schema.json' with { type: 'json' };
import coverageManifestSchema from '../../../schemas/coverage-manifest.schema.json' with { type: 'json' };
import verdictSchema from '../../../schemas/verdict.schema.json' with { type: 'json' };
import repoConfigSchema from '../../../schemas/repo-config.schema.json' with { type: 'json' };
import prepareArtifactSchema from '../../../schemas/prepare-artifact.schema.json' with { type: 'json' };
import verifierConclusionSchema from '../../../schemas/verifier-conclusion.schema.json' with { type: 'json' };

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });

for (const schema of [
  candidateFindingSchema,
  findingSchema,
  expertOutputSchema,
  coverageManifestSchema,
  verdictSchema,
  repoConfigSchema,
  prepareArtifactSchema,
  verifierConclusionSchema,
]) {
  ajv.addSchema(schema);
}

export function validate<T>(schemaId: string, data: unknown): ValidationResult<T> {
  const validateFn = ajv.getSchema(schemaId) as ValidateFunction<T> | undefined;
  if (!validateFn) {
    throw new Error(`schema-validator: unknown schema id "${schemaId}"`);
  }

  if (validateFn(data)) {
    return { valid: true, data: data as T };
  }

  const errors = (validateFn.errors ?? []).map(
    (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
  );
  return { valid: false, errors };
}
