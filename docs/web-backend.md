# DSH Web execution

ACP agents run outside the Web process. Their cwd does not register workspace membership, and process-local assistant streams cannot reach a different Web host. Commander can instead connect to the existing loopback Web origin, register the workspace, adopt a stable session ID, and pin the requested provider/model before submitting a prompt. DSH core and released session formats are unchanged.

The transport uses DSH's owner browser-session grant and Remote HTTP/WebSocket envelopes. Redirects are rejected, credentials stay on loopback, and the stored Web origin must match when a session resumes. The caller owns starting the Web service and choosing its DSH home.

The backend follows durable events before submitting a prompt. A matching user message source rpcId binds the request to its turn. Only that turn's durable assistant text and tool summaries reach Commander; transient frames remain in Web presentation and reasoning is not returned to Codex. End reasons outside the supported set fail explicitly.

Cancellation withdraws only the matching pending inbox item or cancels a claimed turn, with bounded acknowledgement. Uncertain remote completion is reported through the task error. A lost approval stream fails active work; a cancelled remote approval aborts its parent waiter. Closing a handle releases subscriptions without deleting history or stopping the shared host.

Validation uses fake transport lifecycle tests, loopback HTTP/WebSocket transport tests, and `node scripts/web-smoke.mjs <workspace>`. The live smoke requests no model tools, checks workspace registration and multiple transient frames before durable output, and resumes the same session. Evidence is written to `<workspace>/output/playwright/` and excluded from distributable archives.
