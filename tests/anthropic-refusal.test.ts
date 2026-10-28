// Exercises the tool-stream-strict and anthropic-refusal adapters.
// Behavioral test: a refusal stream with incomplete tool JSON must not produce
// a tool-call event. Run via `mise run test:adapters`.
import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { LLM, LLMRequest, ToolDefinition } from "../vendors/opencode/packages/ai/src/effect.js"
import { Auth, LLMClient, Route } from "../vendors/opencode/packages/ai/src/route.js"
import * as AnthropicMessages from "../vendors/opencode/packages/ai/src/protocols/anthropic-messages.js"
import { toolStreamStrict } from "../adapters/opencode/tool-stream-strict"
import { anthropicRefusal } from "../adapters/opencode/anthropic-refusal"
import { it } from "../vendors/opencode/packages/ai/test/lib/effect.js"
import { fixedResponse } from "../vendors/opencode/packages/ai/test/lib/http.js"
import { sseEvents } from "../vendors/opencode/packages/ai/test/lib/sse.js"

// ---------------------------------------------------------------------------
// Adapter contract tests — fail fast if upstream changes the targeted code
// ---------------------------------------------------------------------------

describe("tool-stream-strict adapter", () => {
  it.effect("rejects upstream source that no longer matches", () =>
    Effect.sync(() => {
      expect(() => toolStreamStrict.transform("export * as Wrong from './wrong.js'")).toThrow("found 0")
    }),
  )

  it.effect("adds finishStrict export to tool-stream source", () =>
    Effect.sync(() => {
      const input = `export * as ToolStream from "./tool-stream.js"`
      const output = toolStreamStrict.transform(input)
      expect(output).toContain("finishStrict")
      expect(output).toContain(`export * as ToolStream from "./tool-stream.js"`)
    }),
  )
})

describe("anthropic-refusal adapter", () => {
  it.effect("rejects upstream source missing onContentBlockStop target", () =>
    Effect.sync(() => {
      expect(() => anthropicRefusal.transform("no match here")).toThrow("onContentBlockStop ToolStream.finish call")
    }),
  )

  it.effect("replaces ToolStream.finish with ToolStream.finishStrict", () =>
    Effect.sync(() => {
      // Build a minimal source containing all three targets
      const minimal = [
        `  const result = yield* ToolStream.finish(ADAPTER, state.tools, event.index)`,
        `  const events: LLMEvent[] = []`,
        `  const resultEvents = result.events ?? []`,
        `  const result = yield* ToolStream.finishAll(ADAPTER, state.tools)`,
        `  const events: LLMEvent[] = []`,
        `  const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle`,
        `  events.push(...result.events)`,
        `  return [{ ...state, lifecycle: finished, tools: result.tools }, events] satisfies StepResult`,
        `})`,
      ].join("\n")
      const output = anthropicRefusal.transform(minimal)
      expect(output).toContain("ToolStream.finishStrict")
      expect(output).toContain("isIncomplete")
      expect(output).toContain("toolInputError")
      expect(output).not.toContain("tools: result.tools")
    }),
  )
})

// ---------------------------------------------------------------------------
// Behavioral test — refusal stream must not emit a tool-call
// ---------------------------------------------------------------------------

const model = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const request = LLM.request({
  model,
  prompt: "Check the file.",
  tools: [ToolDefinition.make({ name: "shell", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } })],
})

describe("Anthropic refusal adapter — behavioral", () => {
  it.effect("does not emit tool-call when refusal carries incomplete JSON (with content_block_stop)", () =>
    Effect.gen(function* () {
      // Simulates the H20 failure: model starts a shell tool call, writes
      // truncated JSON, then content_block_stop fires, then message_delta
      // carries stop_reason "refusal", then message_stop.
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "shell", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"cat file.txt; grep -n \\"something' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expect(response.toolCalls).toEqual([])
      expect(response.finishReason).toEqual({ normalized: "content-filter", raw: "refusal" })
    }),
  )

  it.effect("does not emit tool-call when refusal arrives without content_block_stop", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_2", name: "shell", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"printf \\"hello' } },
        { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expect(response.toolCalls).toEqual([])
      expect(response.finishReason).toEqual({ normalized: "content-filter", raw: "refusal" })
    }),
  )

  it.effect("still emits tool-call for complete JSON before a normal tool_use stop", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_3", name: "shell", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls -la"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expect(response.toolCalls).toMatchObject([{ name: "shell", input: { command: "ls -la" } }])
      expect(response.finishReason).toEqual({ normalized: "tool-calls", raw: "tool_use" })
    }),
  )
})
