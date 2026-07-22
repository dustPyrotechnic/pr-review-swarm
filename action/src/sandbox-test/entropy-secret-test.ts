// Fake credential with no recognizable provider prefix (AWS/GitHub/Slack/JWT
// patterns won't match it) — should still be caught by the entropy heuristic
// because the variable name reads like a secret and the value is high-entropy.
const stripeApiKey = "zQ7kP2vR9xL4mN8wJ6tH1sB3yF5dC0e";

export function chargeCustomer(amount: number): void {
  console.log('charging', amount, 'with key', stripeApiKey);
}
