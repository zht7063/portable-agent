# Codex ↔ rain Responses contract checklist

Status legend: **[offline ✓]** observed with real codex-cli 0.164.0 against a local fake server (2026-10-23);
**[live ☐]** needs a live check against rain once yubai has configured the Responses channel (needs approval;
not run — no rain network was used).

## 1. Transport
- [offline ✓] `GET /v1/models?client_version=0.164.0` sent at startup (3× in a single `exec`) with
  `Authorization: Bearer <key>`. A plain OpenAI list `{object:"list",data:[{id,object:"model"}]}` is accepted;
  unknown ids only produce "Model metadata … not found. Defaulting to fallback metadata".
- [offline ✓] `POST /v1/responses`, `stream: true`, `Accept` SSE, Bearer = stdout of `[model_providers.pa.auth].command`
  (args `<profile> codex`), or `$PA_API_KEY` in env mode.
- [offline ✓] No WebSocket upgrade for a custom provider (`supports_websockets` defaults false).
- [live ☐] rain returns `text/event-stream` without buffering (proxy/CDN); idle timeout > Codex `stream_idle_timeout_ms` (default 300 s).
- [live ☐] 401 handling: Codex reruns the auth command on 401; rain must answer 401 (not 403/500) for a bad key.
- [live ☐] 429/5xx produce retryable errors (Codex `request_max_retries`, `stream_max_retries`).

## 2. Request body (observed keys)
`model, stream, input, tools, tool_choice, parallel_tool_calls, reasoning, store, include, prompt_cache_key, client_metadata`
- [offline ✓] `store: false`, **no** `previous_response_id` → full history resent every turn; rain must not require stored state.
- [offline ✓] `reasoning: {summary:"auto"}`, `include: ["reasoning.encrypted_content"]` — rain must accept (or ignore) both;
  if it returns encrypted reasoning, it must accept it back verbatim in later `input`.
- [offline ✓] `tool_choice:"auto"`, `parallel_tool_calls:true`.
- [offline ✓] `input` items: `message` (developer/user roles, `input_text` content).
- [offline ✓] `tools` types: `function` (exec_command, write_stdin, request_user_input, view_image, get_goal,
  create_goal, update_goal), **`namespace`** (multi_agent_v1, nested functions), **`web_search`**. rain/upstream must
  accept or strip `namespace` and `web_search`; a 400 here breaks every turn. → [live ☐]
- [offline ✓] `client_metadata` carries session/turn ids (no secrets); `prompt_cache_key` = session id.
- [live ☐] DeepSeek models behind rain accept `developer` role (or rain maps it to system).

## 3. Stream events Codex needs
Minimal sequence that renders text and ends the turn [offline ✓]:
```
response.created            {response:{id,status:"in_progress",model,output:[]}}
response.output_item.added  {output_index, item:{type:"message",id,role:"assistant",content:[]}}
response.output_text.delta  {item_id, output_index, content_index, delta}
response.output_item.done   {output_index, item:{...content:[{type:"output_text",text}]}}
response.completed          {response:{..., usage:{input_tokens, input_tokens_details.cached_tokens, output_tokens, output_tokens_details.reasoning_tokens, total_tokens}}}
```
- [offline ✓] `usage` from `response.completed` is shown as "tokens used".
- [live ☐] `response.failed` / `error` events map to a readable Codex error, not a hang.
- [live ☐] Reasoning: `response.reasoning_summary_text.delta` and `reasoning` output items (with `encrypted_content` if any).

## 4. Tool calls (live only)
- [live ☐] `function_call` output item (`call_id`, `name`, `arguments` JSON string) streamed via
  `response.function_call_arguments.delta/done` or delivered whole in `output_item.done`.
- [live ☐] Next turn: `input` contains the `function_call` item and a `function_call_output {call_id, output}`; rain must pass both through.
- [live ☐] Parallel calls (several `function_call` items in one response).
- [live ☐] Namespaced tools: call name as Codex expects for `namespace` members.
- [live ☐] A real `codex exec` run that executes a shell command (exec_command) end to end.

## 5. Acceptance run (to do with approval)
1. yubai configures the rain Responses channel; UI probe shows `model-listed`.
2. `codex exec --skip-git-repo-check "say pong"` → text + usage.
3. `codex exec "list files in this dir"` → one exec_command round trip.
4. Two-turn session → history resend with `store:false` works.
