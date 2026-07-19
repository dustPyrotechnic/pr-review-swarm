import allowedModelsConfig from '../../config/allowed-models.json' with { type: 'json' };

export function assertModelAllowed(modelName: string): void {
  if (!allowedModelsConfig.allowedModels.includes(modelName)) {
    throw new Error(
      `model "${modelName}" is not in the allowed models list (action/config/allowed-models.json)`,
    );
  }
}
