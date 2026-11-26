# Simple V3 — implemented, experimental

Classification: `EXPERIMENTAL`.

V3.1 adds an independent Simple V3 Chat Engine next to `legacy`. Both are
selectable through `settings.primaryChatEngine` (`legacy` | `simple_v3`), and
Simple V3 can additionally run as a non-sending Shadow while Legacy stays primary.

Files:

- `config.cjs` — prompt limits and relationship-stage wording. No capability.
- `prompt.cjs` — pure `ChatContext -> messages` builder. Reads only public
  context fields (incoming burst, recent messages, ≤5 self facts, ≤5 contact
  facts, ≤3 shared memories, relationship stage, privacy constraints).
- `parser.cjs` — pure `model text -> {action, messages, handoff, reason}`.
  Unknown or malformed output falls back to a safe REPLY/NO_REPLY.
- `engine.cjs` — one model call via the injected `generate` dependency, then the
  public `ChatEngineResult`.

Boundaries (unchanged from V3.0):

- The engine accepts the frozen public `ChatContext` and returns
  `ChatEngineResult` from `generateReply(context)`.
- It never reads Storage/state/Self Profile/Contact Memory/Shared Memory
  directly, never mutates Relationship Core, never sends, never consumes quotas
  and never touches the Douyin DOM.
- Provider access stays a narrow injected dependency; credentials, HTTP
  transport, cooldowns and failover remain in the model-provider port.
- It does not use the Legacy Attention Router, Topic Tree, Momentum, Persona
  Lens, Advisor, 13-action Planner, Writer or six-dimension relationship scores.
- Safety, Sending, Memory and Relationship stay outside the engine.
- As a Shadow it produces a comparison record only: no send, no Memory write,
  no Relationship write, no send-quota consumption.
