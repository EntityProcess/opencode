#!/usr/bin/env bun
/**
 * Test script v2 - More thorough testing of Claude extended thinking
 * Tests streaming, harder prompts, and special headers
 */

import { xdgData } from "xdg-basedir"
import path from "path"

const AUTH_FILE = path.join(xdgData!, "opencode", "auth.json")
const COPILOT_BASE_URL = "https://api.githubcopilot.com"
const MODEL = "claude-sonnet-4.5"

async function getToken(): Promise<string> {
  const file = Bun.file(AUTH_FILE)
  const data = await file.json()
  const copilotAuth = data["github-copilot"]
  if (!copilotAuth || copilotAuth.type !== "oauth") {
    throw new Error("No GitHub Copilot auth found.")
  }
  return copilotAuth.refresh
}

// A harder prompt that might trigger extended thinking
const HARD_PROMPT = `Solve this step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Show your reasoning.`

async function testStreaming(token: string): Promise<void> {
  console.log("\n" + "=".repeat(60))
  console.log("Test: Streaming with thinking params")
  console.log("=".repeat(60))

  const body = {
    model: MODEL,
    messages: [{ role: "user", content: HARD_PROMPT }],
    max_tokens: 1000,
    stream: true,
    thinking: {
      type: "enabled",
      budget_tokens: 10000,
    },
  }

  console.log("Request body:", JSON.stringify(body, null, 2))

  const response = await fetch(`${COPILOT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "opencode/test",
      "Openai-Intent": "conversation-edits",
      "X-Initiator": "user",
    },
    body: JSON.stringify(body),
  })

  console.log(`\nStatus: ${response.status}`)

  if (!response.ok) {
    console.log("Error:", await response.text())
    return
  }

  console.log("\nStreaming response chunks:")
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let fullContent = ""
  let chunkTypes = new Set<string>()

  while (reader) {
    const { done, value } = await reader.read()
    if (done) break

    const text = decoder.decode(value)
    const lines = text.split("\n").filter(l => l.startsWith("data: "))

    for (const line of lines) {
      const data = line.slice(6)
      if (data === "[DONE]") continue

      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta

        // Track what types of content we see
        if (delta) {
          Object.keys(delta).forEach(k => chunkTypes.add(k))
        }

        // Check for thinking/reasoning in delta
        if (delta?.thinking) {
          console.log("🧠 THINKING DELTA:", delta.thinking)
        }
        if (delta?.reasoning) {
          console.log("🧠 REASONING DELTA:", delta.reasoning)
        }
        if (delta?.content) {
          fullContent += delta.content
        }
      } catch {}
    }
  }

  console.log("\nChunk types seen:", [...chunkTypes])
  console.log("\nFull content:", fullContent)
}

async function testWithSpecialHeaders(token: string): Promise<void> {
  console.log("\n" + "=".repeat(60))
  console.log("Test: With potential thinking-related headers")
  console.log("=".repeat(60))

  const body = {
    model: MODEL,
    messages: [{ role: "user", content: HARD_PROMPT }],
    max_tokens: 1000,
    stream: false,
    thinking: {
      type: "enabled",
      budget_tokens: 10000,
    },
  }

  // Try various header combinations
  const headerVariants = [
    { "Copilot-Thinking-Request": "true" },
    { "X-Copilot-Extended-Thinking": "true" },
    { "Anthropic-Beta": "extended-thinking-2025-01-01" },
  ]

  for (const extraHeaders of headerVariants) {
    console.log(`\nTrying headers:`, extraHeaders)

    const response = await fetch(`${COPILOT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "opencode/test",
        "Openai-Intent": "conversation-edits",
        "X-Initiator": "user",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    console.log(`Status: ${response.status}`)

    const message = data.choices?.[0]?.message
    if (message) {
      console.log("Message keys:", Object.keys(message))
      if (message.thinking) console.log("🧠 THINKING:", message.thinking)
      if (message.reasoning) console.log("🧠 REASONING:", message.reasoning)
    }
  }
}

async function testOtherClaudeModels(token: string): Promise<void> {
  console.log("\n" + "=".repeat(60))
  console.log("Test: Other Claude models with thinking")
  console.log("=".repeat(60))

  const models = ["claude-sonnet-4", "claude-opus-4"]

  for (const model of models) {
    console.log(`\nTesting model: ${model}`)

    const body = {
      model,
      messages: [{ role: "user", content: "What is 2+2?" }],
      max_tokens: 100,
      stream: false,
      thinking: {
        type: "enabled",
        budget_tokens: 5000,
      },
    }

    try {
      const response = await fetch(`${COPILOT_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "opencode/test",
          "Openai-Intent": "conversation-edits",
          "X-Initiator": "user",
        },
        body: JSON.stringify(body),
      })

      const data = await response.json()
      console.log(`Status: ${response.status}`)

      if (response.ok) {
        const message = data.choices?.[0]?.message
        console.log("Message keys:", Object.keys(message || {}))
        console.log("Content:", message?.content?.slice(0, 100))
      } else {
        console.log("Error:", data.error?.message || JSON.stringify(data))
      }
    } catch (e) {
      console.log("Error:", e)
    }

    await new Promise(r => setTimeout(r, 1000))
  }
}

async function inspectFullResponse(token: string): Promise<void> {
  console.log("\n" + "=".repeat(60))
  console.log("Test: Full response inspection")
  console.log("=".repeat(60))

  const body = {
    model: MODEL,
    messages: [{ role: "user", content: HARD_PROMPT }],
    max_tokens: 1000,
    stream: false,
    thinking: {
      type: "enabled",
      budget_tokens: 10000,
    },
  }

  const response = await fetch(`${COPILOT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "opencode/test",
      "Openai-Intent": "conversation-edits",
      "X-Initiator": "user",
    },
    body: JSON.stringify(body),
  })

  console.log("\nResponse headers:")
  response.headers.forEach((v, k) => console.log(`  ${k}: ${v}`))

  const data = await response.json()
  console.log("\nFull response structure:")
  console.log(JSON.stringify(data, null, 2))
}

async function main() {
  console.log("GitHub Copilot Claude Extended Thinking - Deep Test")
  console.log("===================================================\n")

  const token = await getToken()
  console.log("✅ Found Copilot auth token")

  await inspectFullResponse(token)
  await testStreaming(token)
  await testWithSpecialHeaders(token)
  await testOtherClaudeModels(token)

  console.log("\n" + "=".repeat(60))
  console.log("All tests complete!")
  console.log("=".repeat(60))
}

main()
