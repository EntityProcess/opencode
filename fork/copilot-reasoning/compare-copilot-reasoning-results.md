# GitHub Copilot Reasoning Comparison Results

**Date**: 2025-12-21
**Model**: gpt-5.2
**Provider**: github-copilot

## Summary

| API | Avg Duration | Total Reasoning Tokens |
|-----|--------------|------------------------|
| **Chat Completions** | **4.53s** | 0 (not reported) |
| Responses (low) | 4.10s | 21 |
| Responses (medium) | 5.71s | 259 |
| Responses (high) | 5.37s | 356 |

## Key Finding: Chat May Use Hidden Reasoning

**Chat Completions is 10% SLOWER than low reasoning effort** (4.53s vs 4.10s), yet reports 0 reasoning tokens.

This suggests:
1. **Chat uses hidden reasoning** - Some default reasoning level that isn't exposed in usage stats
2. Chat duration falls **between low and medium**, suggesting it may use ~low-to-medium reasoning internally

## Detailed Results

### Test 1: Math Reasoning

| API | Reasoning Effort | Reasoning Tokens | Duration |
|-----|------------------|------------------|----------|
| chat | none | N/A | 2001ms |
| responses | low | 21 | 1432ms |
| responses | medium | 49 | 3249ms |
| responses | high | 79 | 2196ms |

### Test 2: Logic Puzzle

| API | Reasoning Effort | Reasoning Tokens | Duration |
|-----|------------------|------------------|----------|
| chat | none | N/A | 5006ms |
| responses | low | 0 | 5227ms |
| responses | medium | 0 | 5790ms |
| responses | high | 0 | 5940ms |

*Note: This puzzle triggered no reasoning tokens across all levels - likely a well-known problem.*

### Test 3: Code Analysis

| API | Reasoning Effort | Reasoning Tokens | Duration |
|-----|------------------|------------------|----------|
| chat | none | N/A | 6585ms |
| responses | low | 0 | 5637ms |
| responses | medium | **210** | 8080ms |
| responses | high | **277** | 7969ms |

**Key Observation**: Chat (6585ms) is slower than low (5637ms) but faster than medium/high. This pattern suggests Chat may use hidden reasoning between low and medium effort.

## Conclusions

1. **Chat Completions does NOT report reasoning tokens** but takes longer than explicit low reasoning

2. **Duration pattern suggests hidden reasoning**:
   - Chat: 4.53s (slower than low, faster than medium)
   - This is consistent with Chat using some default reasoning level

3. **Responses API reasoning tokens scale with effort**:
   - Low: 21 tokens
   - Medium: 259 tokens (12x more)
   - High: 356 tokens (17x more)

4. **For maximum transparency, use Responses API** - it reports reasoning tokens in usage stats

## How to Run

```bash
bun run fork/copilot-reasoning/compare-copilot-reasoning.ts

# With options
bun run fork/copilot-reasoning/compare-copilot-reasoning.ts -m gpt-5.2 --timeout-ms 120000
```
