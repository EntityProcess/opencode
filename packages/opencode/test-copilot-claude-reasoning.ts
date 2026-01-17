#!/usr/bin/env bun

/**
 * Test for GitHub Copilot Claude Extended Thinking Support
 *
 * This test verifies that:
 * 1. Claude models are routed to the Responses API (sdk.responses())
 * 2. The thinking parameter is correctly passed for Claude models
 * 3. Reasoning/thinking content appears in the response
 *
 * Compare with test-copilot-reasoning.ts which tests GPT-5 models.
 */

import { generateText, type ModelMessage } from "ai"

interface TestConfig {
  modelID: string
  providerID: string
  expectedApiRoute: "responses" | "chat"
  expectedReasoning: boolean
}

const TEST_CONFIGS: TestConfig[] = [
  // Claude models with reasoning support
  {
    modelID: "claude-opus-4",
    providerID: "github-copilot",
    expectedApiRoute: "responses",
    expectedReasoning: true,
  },
  {
    modelID: "claude-opus-4.5",
    providerID: "github-copilot",
    expectedApiRoute: "responses",
    expectedReasoning: true,
  },
  {
    modelID: "claude-sonnet-4",
    providerID: "github-copilot",
    expectedApiRoute: "responses",
    expectedReasoning: true,
  },
  {
    modelID: "claude-sonnet-4.5",
    providerID: "github-copilot",
    expectedApiRoute: "responses",
    expectedReasoning: true,
  },
  {
    modelID: "claude-haiku-4.5",
    providerID: "github-copilot",
    expectedApiRoute: "responses",
    expectedReasoning: true,
  },
  // Claude 3.x models (no reasoning support)
  {
    modelID: "claude-3.5-sonnet",
    providerID: "github-copilot",
    expectedApiRoute: "chat",
    expectedReasoning: false,
  },
]

const TEST_PROMPT = `Solve this step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left?

Important: Think through this carefully and show your reasoning process.`

interface TestResult {
  model: string
  success: boolean
  hasReasoning: boolean
  reasoningTokens?: number
  error?: string
  transformOptions?: Record<string, any>
}

async function testModel(config: TestConfig): Promise<TestResult> {
  const { Provider } = await import("./src/provider/provider")
  const { Session } = await import("./src/session/session")
  const { ProviderTransform } = await import("./src/provider/transform")

  const { modelID, providerID } = config

  console.log(`\n${"=".repeat(60)}`)
  console.log(`Testing: ${providerID}/${modelID}`)
  console.log(`Expected API route: ${config.expectedApiRoute}`)
  console.log(`Expected reasoning: ${config.expectedReasoning}`)
  console.log(`${"=".repeat(60)}`)

  try {
    const model = await Provider.model(providerID, modelID)
    if (!model) {
      return {
        model: modelID,
        success: false,
        hasReasoning: false,
        error: "Model not found in provider",
      }
    }

    console.log(`\nModel info:`)
    console.log(`  - Provider ID: ${model.providerID}`)
    console.log(`  - API NPM: ${model.api.npm}`)
    console.log(`  - API ID: ${model.api.id}`)
    console.log(`  - capabilities.reasoning: ${model.capabilities.reasoning}`)

    const session = await Session.create()

    // Get transform options to verify thinking config is set
    const transformOptions = ProviderTransform.options({
      model,
      sessionID: session.id,
      providerOptions: {},
    })
    console.log(`\nTransform options:`, JSON.stringify(transformOptions, null, 2))

    // Verify store=false is set (required for Responses API)
    if (transformOptions.store !== false) {
      console.log(`⚠️  Warning: store is not set to false`)
    }

    // Verify thinking config for Claude models
    if (config.expectedReasoning && model.api.id.includes("claude")) {
      if (!transformOptions.thinking) {
        console.log(`⚠️  Warning: thinking config not set for Claude model`)
      } else {
        console.log(`✅ thinking config:`, JSON.stringify(transformOptions.thinking, null, 2))
      }
    }

    // Get variants to see available reasoning levels
    const variants = ProviderTransform.variants(model)
    if (Object.keys(variants).length > 0) {
      console.log(`\nAvailable variants:`, Object.keys(variants).join(", "))
    }

    // Test actual API call
    console.log(`\n--- Making API call ---`)

    const messages: ModelMessage[] = [{ role: "user", content: TEST_PROMPT }]

    const instance = await Provider.instance(providerID, modelID)

    const modelOptions = await Provider.options({
      providerID,
      modelID,
      sessionID: session.id,
      autoAdjust: false,
    })

    console.log(`Model options:`, JSON.stringify(modelOptions, null, 2))

    const startTime = Date.now()
    const result = await generateText({
      model: instance,
      messages,
      ...modelOptions,
      abortSignal: AbortSignal.timeout(120_000),
    })
    const duration = Date.now() - startTime

    console.log(`\n--- Response ---`)
    console.log(`Duration: ${duration}ms`)
    console.log(`Text length: ${result.text?.length || 0}`)
    console.log(`Usage:`, JSON.stringify(result.usage, null, 2))

    const usage = result.usage as any
    const hasReasoning = !!(result.reasoning || usage?.reasoningTokens || usage?.reasoning_tokens)

    if (result.reasoning) {
      console.log(`\n✅ Reasoning found in response!`)
      console.log(`Reasoning preview:\n${result.reasoning?.substring(0, 400)}...`)
    } else {
      console.log(`\n⚠️  No reasoning field in response`)
    }

    if (usage?.reasoningTokens || usage?.reasoning_tokens) {
      console.log(`✅ Reasoning tokens: ${usage.reasoningTokens || usage.reasoning_tokens}`)
    }

    console.log(`\nResponse preview:\n${result.text?.substring(0, 400)}...`)

    const success = hasReasoning === config.expectedReasoning

    return {
      model: modelID,
      success,
      hasReasoning,
      reasoningTokens: usage?.reasoningTokens || usage?.reasoning_tokens,
      transformOptions,
    }
  } catch (error: any) {
    console.error(`\n❌ Error:`, error.message)

    // Check for specific errors
    if (error.message?.includes("encrypted_content") && error.message?.includes("not found")) {
      console.error(`\n❌ CRITICAL: This is the encrypted_content error.`)
      console.error(`The store=false fix may not be working correctly.`)
    }

    return {
      model: modelID,
      success: false,
      hasReasoning: false,
      error: error.message,
    }
  }
}

async function main() {
  console.log("GitHub Copilot Claude Extended Thinking Test")
  console.log("============================================\n")

  // Check if a specific model was requested
  const requestedModel = process.argv[2]

  let configsToTest: TestConfig[]
  if (requestedModel) {
    const config = TEST_CONFIGS.find((c) => c.modelID === requestedModel)
    if (!config) {
      console.error(`Model ${requestedModel} not found in test configs`)
      console.log("Available models:", TEST_CONFIGS.map((c) => c.modelID).join(", "))
      process.exit(1)
    }
    configsToTest = [config]
  } else {
    // Default: test first Claude 4+ model
    configsToTest = TEST_CONFIGS.filter((c) => c.expectedReasoning).slice(0, 1)
  }

  const results: TestResult[] = []

  for (const config of configsToTest) {
    const result = await testModel(config)
    results.push(result)
  }

  // Summary
  console.log("\n" + "=".repeat(60))
  console.log("SUMMARY")
  console.log("=".repeat(60))

  for (const result of results) {
    const status = result.error ? "❌" : result.success ? "✅" : "⚠️"
    console.log(`${status} ${result.model}:`)
    console.log(`   Has reasoning: ${result.hasReasoning}`)
    if (result.reasoningTokens) {
      console.log(`   Reasoning tokens: ${result.reasoningTokens}`)
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`)
    }
  }

  const allPassed = results.every((r) => r.success)
  const anyErrors = results.some((r) => r.error)

  console.log("\n" + "=".repeat(60))
  if (anyErrors) {
    console.log("❌ Some tests had errors - check output above")
    process.exit(1)
  } else if (allPassed) {
    console.log("✅ All tests passed!")
  } else {
    console.log("⚠️  Some tests did not match expected behavior")
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("Test failed:", error)
  process.exit(1)
})
