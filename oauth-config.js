// Set these two values after creating the Notion public connection and deploying oauth-worker.
// The client ID is public. Never put the client secret in this extension.
globalThis.NORI_OAUTH_CONFIG = Object.freeze({
  clientId: "REPLACE_WITH_NOTION_PUBLIC_CONNECTION_CLIENT_ID",
  workerBaseUrl: "https://REPLACE_WITH_YOUR_WORKER.workers.dev"
});
