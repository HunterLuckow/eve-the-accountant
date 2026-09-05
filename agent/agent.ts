import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5",
  reasoning: "medium",
  limits: {
    maxTokenCostUsdPerSession: 1.5,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  },
});
