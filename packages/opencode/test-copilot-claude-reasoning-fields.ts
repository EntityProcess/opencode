#!/usr/bin/env bun
/**
 * Test if Claude returns reasoning_text/reasoning_opaque like Gemini does
 * Based on PR #8900 which shows Copilot's reasoning field format
 */

import { xdgData } from "xdg-basedir"
import path from "path"

const AUTH_FILE = path.join(xdgData!, "opencode", "auth.json")
const COPILOT_BASE_URL = "https://api.githubcopilot.com"

async function getToken(): Promise<string> {
  const file = Bun.file(AUTH_FILE)
  const data = await file.json()
  return data["github-copilot"]?.refresh
}

const HARD_PROMPT = "Solve step by step: If a train travels 120 miles in 2 hours, what is its average speed?"

async function testModel(token: string, model: string, extraParams: Record<string, unknown> = {}): Promise<void> {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`Model: ${model}`)
  console.log(`Extra params: ${JSON.stringify(extraParams)}`)
  console.log("=".repeat(60))

  const body = {
    model,
    messages: [{ role: "user", content: HARD_PROMPT }],
    max_tokens: 500,
    stream: false,
    ...extraParams,
  }

  const response = await fetch(`${COPILOT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "opencode/test",
      "Openai-Intent": "conversation-edits",
      "X-Initiator": "user",
    },
    body: JSON.stringify(body),
  })

  const data = await response.json()
  console.log(`Status: ${response.status}`)

  if (!response.ok) {
    console.log("Error:", data.error?.message || JSON.stringify(data))
    return
  }

  const message = data.choices?.[0]?.message
  console.log("\n📦 Message object keys:", Object.keys(message || {}))

  // Check for reasoning fields (like Gemini uses)
  if (message?.reasoning_text) {
    console.log("🧠 reasoning_text FOUND!")
    console.log("Value:", message.reasoning_text.slice(0, 200) + "...")
  }
  if (message?.reasoning_opaque) {
    console.log("🔑 reasoning_opaque FOUND!")
    console.log("Value:", message.reasoning_opaque.slice(0, 100) + "...")
  }

  // Check for other potential thinking fields
  const potentialFields = ['thinking', 'reasoning', 'thought', 'chain_of_thought', 'reasoning_content']
  for (const field of potentialFields) {
    if (message?.[field]) {
      console.log(`✨ ${field} FOUND!`)
      console.log("Value:", JSON.stringify(message[field]).slice(0, 200))
    }
  }

  console.log("\n📝 Content:", message?.content?.slice(0, 300))
  console.log("\n📊 Usage:", JSON.stringify(data.usage))
}

async function testStreaming(token: string, model: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`Streaming test: ${model}`)
  console.log("=".repeat(60))

  const body = {
    model,
    messages: [{ role: "user", content: HARD_PROMPT }],
    max_tokens: 500,
    stream: true,
    reasoning_effort: "high", // Try Gemini-style param
  }

  const response = await fetch(`${COPILOT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "opencode/test",
      "Openai-Intent": "conversation-edits",
      "X-Initiator": "user",
    },
    body: JSON.stringify(body),
  })

  console.log(`Status: ${response.status}`)
  if (!response.ok) {
    console.log("Error:", await response.text())
    return
  }

  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  const deltaFields = new Set<string>()
  let hasReasoningDelta = false

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
        if (delta) {
          Object.keys(delta).forEach(k => deltaFields.add(k))

          // Check for reasoning in delta
          if (delta.reasoning_text || delta.reasoning) {
            hasReasoningDelta = true
            console.log("🧠 Reasoning delta:", delta.reasoning_text || delta.reasoning)
          }
        }
      } catch {}
    }
  }

  console.log("\nDelta fields seen:", [...deltaFields])
  console.log("Has reasoning delta:", hasReasoningDelta)
}

async function main() {
  console.log("Testing Copilot Reasoning Fields (based on PR #8900)")
  console.log("====================================================\n")

  const token = await getToken()
  if (!token) {
    console.error("No Copilot auth found")
    process.exit(1)
  }

  // Test Claude without any special params
  await testModel(token, "claude-sonnet-4.5")

  // Test Claude with reasoning_effort (Gemini-style)
  await testModel(token, "claude-sonnet-4.5", { reasoning_effort: "high" })

  // Test Claude with thinking param
  await testModel(token, "claude-sonnet-4.5", {
    thinking: { type: "enabled", budget_tokens: 10000 }
  })

  // Test Gemini for comparison (to see if it returns reasoning_text)
  await testModel(token, "gemini-2.5-pro")
  await testModel(token, "gemini-2.5-pro", { reasoning_effort: "high" })

  // Test streaming
  await testStreaming(token, "claude-sonnet-4.5")
  await testStreaming(token, "gemini-2.5-pro")

  console.log("\n" + "=".repeat(60))
  console.log("Tests complete!")
}

main()
