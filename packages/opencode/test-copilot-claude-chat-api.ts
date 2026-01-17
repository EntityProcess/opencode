#!/usr/bin/env bun
/**
 * Test script to validate Claude extended thinking via GitHub Copilot Chat API
 *
 * This tests whether the Chat Completions API (/chat/completions) accepts
 * Claude models with various thinking parameter formats.
 *
 * Run with: bun run test-copilot-claude-chat-api.ts
 */

import { xdgData } from "xdg-basedir"
import path from "path"

const AUTH_FILE = path.join(xdgData!, "opencode", "auth.json")
const COPILOT_BASE_URL = "https://api.githubcopilot.com"
const MODEL = "claude-sonnet-4.5"

interface AuthData {
  "github-copilot"?: {
    type: "oauth"
    refresh: string
    access: string
  }
}

async function getToken(): Promise<string> {
  const file = Bun.file(AUTH_FILE)
  const data: AuthData = await file.json()

  const copilotAuth = data["github-copilot"]
  if (!copilotAuth || copilotAuth.type !== "oauth") {
    throw new Error("No GitHub Copilot auth found. Run 'opencode auth' first.")
  }

  return copilotAuth.refresh
}

interface TestCase {
  name: string
  extraParams: Record<string, unknown>
}

const testCases: TestCase[] = [
  // Test 1: No thinking params (baseline - should work)
  {
    name: "Baseline (no thinking)",
    extraParams: {},
  },

  // Test 2: Anthropic-style thinking object (like direct Anthropic API)
  {
    name: "thinking: { type: 'enabled', budget_tokens: 5000 }",
    extraParams: {
      thinking: {
        type: "enabled",
        budget_tokens: 5000,
      },
    },
  },

  // Test 3: VS Code style - anthropic.thinking.budgetTokens
  {
    name: "anthropic.thinking.budgetTokens: 5000",
    extraParams: {
      "anthropic.thinking.budgetTokens": 5000,
    },
  },

  // Test 4: VS Code style nested in modelOptions
  {
    name: "modelOptions: { 'anthropic.thinking.budgetTokens': 5000 }",
    extraParams: {
      modelOptions: {
        "anthropic.thinking.budgetTokens": 5000,
      },
    },
  },

  // Test 5: Nested anthropic object
  {
    name: "anthropic: { thinking: { type: 'enabled', budgetTokens: 5000 } }",
    extraParams: {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 5000,
        },
      },
    },
  },

  // Test 6: budgetTokens with camelCase
  {
    name: "thinking: { type: 'enabled', budgetTokens: 5000 }",
    extraParams: {
      thinking: {
        type: "enabled",
        budgetTokens: 5000,
      },
    },
  },

  // Test 7: Simple extended_thinking flag
  {
    name: "extended_thinking: true",
    extraParams: {
      extended_thinking: true,
    },
  },
]

async function testChatApi(token: string, testCase: TestCase): Promise<void> {
  const url = `${COPILOT_BASE_URL}/chat/completions`

  const body = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: "What is 2+2? Reply with just the number.",
      },
    ],
    max_tokens: 100,
    stream: false,
    ...testCase.extraParams,
  }

  console.log(`\n${"=".repeat(60)}`)
  console.log(`Test: ${testCase.name}`)
  console.log(`${"=".repeat(60)}`)
  console.log(`Request body:`, JSON.stringify(body, null, 2))

  try {
    const response = await fetch(url, {
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

    const responseText = await response.text()
    let responseData: unknown

    try {
      responseData = JSON.parse(responseText)
    } catch {
      responseData = responseText
    }

    console.log(`\nStatus: ${response.status} ${response.statusText}`)
    console.log(`Response:`, JSON.stringify(responseData, null, 2))

    if (response.ok) {
      console.log(`\n✅ SUCCESS - This parameter format works!`)

      // Check if response contains thinking content
      const data = responseData as any
      if (data?.choices?.[0]?.message?.thinking) {
        console.log(`🧠 THINKING CONTENT FOUND!`)
        console.log(`Thinking:`, data.choices[0].message.thinking)
      } else if (data?.choices?.[0]?.message?.reasoning) {
        console.log(`🧠 REASONING CONTENT FOUND!`)
        console.log(`Reasoning:`, data.choices[0].message.reasoning)
      } else {
        console.log(`(No thinking/reasoning content in response)`)
      }
    } else {
      console.log(`\n❌ FAILED`)
    }
  } catch (error) {
    console.log(`\n❌ ERROR:`, error)
  }
}

async function main() {
  console.log("GitHub Copilot Claude Chat API Thinking Test")
  console.log("============================================\n")

  let token: string
  try {
    token = await getToken()
    console.log("✅ Found Copilot auth token")
  } catch (error) {
    console.error("❌ Error:", error)
    process.exit(1)
  }

  console.log(`\nTesting model: ${MODEL}`)
  console.log(`Endpoint: ${COPILOT_BASE_URL}/chat/completions`)

  for (const testCase of testCases) {
    await testChatApi(token, testCase)
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  console.log(`\n${"=".repeat(60)}`)
  console.log("Tests complete!")
  console.log(`${"=".repeat(60)}`)
}

main()
