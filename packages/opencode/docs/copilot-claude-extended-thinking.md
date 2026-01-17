# Claude Extended Thinking via GitHub Copilot

**Branch:** `feature/copilot-claude-reasoning`
**Date:** 2026-01-17
**Status:** Blocked - Waiting on GitHub to enable Claude reasoning support

## Summary

This document details our investigation into enabling Claude extended thinking (reasoning) when using Claude models via the GitHub Copilot provider. The feature is currently **not available** because GitHub Copilot's API does not return reasoning content for Claude models.

## Background

VS Code has a setting `github.copilot.chat.anthropic.thinking.budgetTokens` suggesting Claude extended thinking is or will be supported through Copilot. We investigated how to enable this in opencode.

## What We Implemented

Changes on this branch add infrastructure for Claude extended thinking:

### 1. `src/provider/provider.ts`
- Added `isClaudeWithReasoning()` function to detect Claude 4+ models
- Updated `shouldUseCopilotResponsesApi()` to route Claude 4+ to Responses API

### 2. `src/provider/transform.ts`
- Added thinking variants for Claude via `@ai-sdk/github-copilot`:
  ```typescript
  high: { thinking: { type: "enabled", budgetTokens: 16000 } }
  max: { thinking: { type: "enabled", budgetTokens: 31999 } }
  ```
- Added default thinking options for Claude models

### 3. `src/provider/sdk/openai-compatible/src/responses/openai-responses-language-model.ts`
- Added `isClaudeModel` flag to model config
- Added `thinking` parameter support to provider options schema
- Added Claude-specific request body handling

## Investigation Results

### API Endpoints Tested

| Endpoint | Claude Support | Reasoning Support |
|----------|---------------|-------------------|
| `/v1/responses` (Responses API) | ❌ Rejected with "model does not support Responses API" | N/A |
| `/v1/chat/completions` (Chat API) | ✅ Works | ❌ No reasoning returned |

### Parameter Formats Tested (Chat API)

All of these were accepted but **none returned reasoning content**:

```javascript
// Anthropic-style
{ thinking: { type: "enabled", budget_tokens: 5000 } }

// VS Code dotted notation
{ "anthropic.thinking.budgetTokens": 5000 }

// Nested in modelOptions
{ modelOptions: { "anthropic.thinking.budgetTokens": 5000 } }

// Nested anthropic object
{ anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } } }

// Simple flag
{ extended_thinking: true }

// Gemini-style
{ reasoning_effort: "high" }
```

### Comparison: Claude vs Gemini

We tested both Claude and Gemini models to understand how Copilot handles reasoning:

**Claude Response:**
```json
{
  "choices": [{
    "message": {
      "content": "...",
      "role": "assistant"
    }
  }],
  "usage": {
    "completion_tokens": 134,
    "prompt_tokens": 33,
    "total_tokens": 167
  }
}
```

**Gemini Response:**
```json
{
  "choices": [{
    "message": {
      "content": "...",
      "reasoning_text": "Okay, here's how I'm approaching this...",
      "role": "assistant"
    }
  }],
  "usage": {
    "completion_tokens": 67,
    "prompt_tokens": 25,
    "total_tokens": 521,
    "reasoning_tokens": 429
  }
}
```

**Key Difference:** Gemini returns `reasoning_text` and `reasoning_tokens`, Claude does not.

### Streaming Comparison

| Model | Delta Fields | Has Reasoning Deltas |
|-------|-------------|---------------------|
| Claude | `content`, `role` | ❌ No |
| Gemini | `content`, `role`, `reasoning_text` | ✅ Yes |

## Related Work

### PR #8900: Copilot Provider for Reasoning Tokens

[anomalyco/opencode#8900](https://github.com/anomalyco/opencode/pull/8900) adds proper handling for Copilot's `reasoning_text` and `reasoning_opaque` fields in the Chat API. This PR:

- Creates a Copilot-specific chat language model implementation
- Handles `reasoning_text` in responses and streaming
- Stores `reasoning_opaque` for multi-turn reasoning continuity
- Currently works for **Gemini models only**

When merged, this PR would automatically support Claude reasoning **if** GitHub enables it on their end.

## Conclusion

### Why Claude Thinking Doesn't Work

1. **Responses API**: GitHub Copilot rejects Claude models on the Responses API
2. **Chat API**: Accepts requests but ignores thinking parameters - no `reasoning_text` in response
3. **Server-side limitation**: The Copilot API infrastructure supports reasoning (proven by Gemini), but it's not enabled for Claude

### What Needs to Happen

For Claude extended thinking to work via Copilot:

1. **GitHub must enable it** - Either via Chat API (`reasoning_text`) or Responses API
2. **No client-side fix possible** - We've tested all reasonable parameter formats

### Recommendations

1. **Park this branch** - The implementation is correct but blocked on GitHub
2. **Monitor PR #8900** - It establishes the reasoning handling pattern
3. **Watch for GitHub announcements** - The VS Code setting suggests this is planned
4. **Claude works without thinking** - Regular Claude usage via Copilot is fully functional

## Test Scripts

The following test scripts were created during investigation:

- `test-copilot-claude-chat-api.ts` - Tests various thinking parameter formats
- `test-copilot-claude-chat-api-v2.ts` - Tests streaming, headers, and other models
- `test-copilot-claude-reasoning-fields.ts` - Compares Claude vs Gemini reasoning fields

Run with: `bun run <script-name>.ts`

## Models Tested

| Model | Available | Reasoning |
|-------|-----------|-----------|
| `claude-sonnet-4.5` | ✅ Yes | ❌ No |
| `claude-sonnet-4` | ✅ Yes | ❌ No |
| `claude-opus-4` | ❌ Not supported | N/A |
| `gemini-2.5-pro` | ✅ Yes | ✅ Yes |
