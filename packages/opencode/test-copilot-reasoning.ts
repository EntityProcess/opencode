#!/usr/bin/env bun

/**
 * Simple test to verify GitHub Copilot Responses API reasoning fix
 * 
 * Tests that store=false is correctly set, which makes the API send
 * full reasoning content inline instead of using item_reference.
 */

import { generateText, type ModelMessage } from "ai"

async function main() {
  // Initialize provider
  const { Provider } = await import("./src/provider/provider")
  const { Session } = await import("./src/session/session")
  const { ProviderTransform } = await import("./src/provider/transform")
  
  // Create a test session
  const session = await Session.create()
  console.log(`Session ID: ${session.id}`)
  
  // Get the github-copilot provider with gpt-5.2
  const providerID = "github-copilot"
  const modelID = "gpt-5.2"
  
  console.log(`\n=== Testing ${providerID} / ${modelID} ===\n`)
  
  const model = await Provider.model(providerID, modelID)
  if (!model) {
    throw new Error(`Model not found: ${providerID}/${modelID}`)
  }
  
  console.log(`Provider ID: ${model.providerID}`)
  console.log(`API NPM: ${model.api.npm}`)
  console.log(`Model ID: ${model.id}`)
  
  // Check what options ProviderTransform.options returns
  const options = ProviderTransform.options({
    model,
    sessionID: session.id,
    providerOptions: {},
  })
  console.log(`\nTransform options:`, JSON.stringify(options, null, 2))
  
  // Verify store=false is set
  if (options.store !== false) {
    console.error(`\n❌ ERROR: store is not set to false! Got: ${options.store}`)
    process.exit(1)
  }
  console.log(`\n✅ store=false is correctly set`)
  
  // Now test actual API call
  const prompt = `Solve this step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left?

Important: Show your reasoning process clearly.`

  console.log(`\n=== Making API call ===`)
  console.log(`Prompt: ${prompt.substring(0, 100)}...`)
  
  const messages: ModelMessage[] = [
    { role: "user", content: prompt }
  ]
  
  const instance = await Provider.instance(providerID, modelID)
  
  // Get model options with reasoning settings
  const modelOptions = await Provider.options({
    providerID,
    modelID,
    sessionID: session.id,
    autoAdjust: false,
  })
  
  console.log(`\nModel options:`, JSON.stringify(modelOptions, null, 2))
  
  try {
    const startTime = Date.now()
    const result = await generateText({
      model: instance,
      messages,
      ...modelOptions,
      abortSignal: AbortSignal.timeout(120_000),
    })
    const duration = Date.now() - startTime
    
    console.log(`\n=== Response ===`)
    console.log(`Duration: ${duration}ms`)
    console.log(`Text length: ${result.text?.length || 0}`)
    console.log(`\nUsage:`, JSON.stringify(result.usage, null, 2))
    console.log(`\nResponse text:\n${result.text?.substring(0, 500)}...`)
    
    // Check for reasoning parts in the response
    if (result.reasoning) {
      console.log(`\n✅ Reasoning found in response`)
      console.log(`Reasoning text: ${result.reasoning?.substring(0, 200)}...`)
    }
    
    // Check usage for reasoning tokens
    const usage = result.usage as any
    if (usage?.reasoningTokens || usage?.reasoning_tokens) {
      console.log(`\n✅ Reasoning tokens reported: ${usage.reasoningTokens || usage.reasoning_tokens}`)
    } else {
      console.log(`\nNote: No reasoning tokens in usage (may be normal for some configurations)`)
    }
    
    console.log(`\n✅ SUCCESS: API call completed without errors`)
    
  } catch (error: any) {
    console.error(`\n❌ ERROR during API call:`)
    console.error(error.message)
    
    // Check for the specific error we're fixing
    if (error.message?.includes("encrypted_content") && error.message?.includes("not found")) {
      console.error(`\n❌ CRITICAL: This is the encrypted_content error we're trying to fix!`)
      console.error(`The store=false fix may not be working correctly.`)
      process.exit(1)
    }
    
    throw error
  }
}

main().catch((error) => {
  console.error("Test failed:", error)
  process.exit(1)
})
