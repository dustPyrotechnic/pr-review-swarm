export async function resolveDeepseekKey({ flagValue, env, prompt }) {
  if (flagValue) return flagValue;
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY;
  return prompt();
}
