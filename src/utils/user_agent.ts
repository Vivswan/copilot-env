/** The version-free User-Agent copilot-env sends on its own behalf (release lookups, the GitHub
 *  viewer query, the credits read). Never an agent's: those carry their own real client UAs, so
 *  nothing here drifts against a client release. */
export const COPILOT_ENV_USER_AGENT = "copilot-env";
