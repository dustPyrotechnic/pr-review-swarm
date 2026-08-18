export async function runDeploy(options, deps) {
  const { deepseekKeyFlag, directPush, force, pinSha = false, watchdogInterval } = options;
  const { checkGhCli, detectRepo, resolveDeepseekKey, resolveRef, writeWorkflows, writeRepoConfig, setSecret, deployChanges } = deps;

  await checkGhCli();
  const { owner, repo } = await detectRepo();
  const key = await resolveDeepseekKey({ flagValue: deepseekKeyFlag });
  const { ref, mode: refMode } = await resolveRef({ pinSha });

  const workflowsResult = writeWorkflows({ ref, force, watchdogInterval });
  const repoConfigResult = writeRepoConfig({ force });

  await setSecret({ owner, repo, key });

  const deployResult = await deployChanges({
    paths: [...workflowsResult.written, ...repoConfigResult.written],
    directPush,
  });

  return {
    owner,
    repo,
    ref,
    refMode,
    workflowFiles: workflowsResult.written,
    watchdogInterval: workflowsResult.watchdogInterval,
    repoConfigFile: repoConfigResult.written,
    secretSet: true,
    deployResult,
  };
}
