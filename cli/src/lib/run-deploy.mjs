export async function runDeploy(options, deps) {
  const { deepseekKeyFlag, directPush, force } = options;
  const { checkGhCli, detectRepo, resolveDeepseekKey, writeWorkflows, writeRepoConfig, setSecret, checkActionsPermissions, deployChanges, pinnedSha } = deps;

  await checkGhCli();
  const { owner, repo } = await detectRepo();
  const key = await resolveDeepseekKey({ flagValue: deepseekKeyFlag });

  const workflowsResult = writeWorkflows({ pinnedSha, force });
  const repoConfigResult = writeRepoConfig({ force });

  await setSecret({ owner, repo, key });

  const permissions = await checkActionsPermissions({ owner, repo });

  const deployResult = await deployChanges({
    paths: [...workflowsResult.written, ...repoConfigResult.written],
    directPush,
  });

  return {
    owner,
    repo,
    workflowFiles: workflowsResult.written,
    repoConfigFile: repoConfigResult.written,
    secretSet: true,
    actionsPermissionsOk: permissions.ok,
    actionsPermissionsHint: permissions.hint,
    deployResult,
  };
}
