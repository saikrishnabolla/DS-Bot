import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { OwnedContext } from '../src/engine/owned-context.js'
import {
  PRUNE_MARKER,
  createToolResultPruner,
} from '../src/engine/owned-tool-result-pruner.js'

test('owned tool-result pruning keeps Unicode head and tail and preserves rich-block order', () => {
  const pruner = createToolResultPruner()
  const head = `${'a'.repeat(4_095)}😀`
  const tail = `🌍${'z'.repeat(1_023)}`
  const image = { type: 'image', data: 'image-data', mimeType: 'image/png' }
  const structured = { type: 'json', value: { retained: true } }
  const original = [
    { type: 'text', text: head },
    image,
    { type: 'text', text: 'middle'.repeat(800) },
    structured,
    { type: 'text', text: tail },
  ]

  const pruned = pruner.pruneContent(original)

  assert.notEqual(pruned, null)
  assert.deepEqual(pruned.filter(block => block.type !== 'text'), [image, structured])
  assert.equal(pruned.filter(block => block.type === 'text').map(block => block.text).join(''), `${head}${PRUNE_MARKER}${tail}`)
  assert.equal(pruner.measureContent(pruned), 4_096 + Array.from(PRUNE_MARKER).length + 1_024)
  assert.deepEqual(original[2], { type: 'text', text: 'middle'.repeat(800) })
})

test('owned tool-result pruning changes only over-budget tool results', () => {
  const pruner = createToolResultPruner({ thresholdChars: 100, headChars: 20, tailChars: 10 })
  const user = { role: 'user', content: [{ type: 'text', text: 'u'.repeat(200) }] }
  const short = { role: 'toolResult', toolCallId: 'short', toolName: 'read', content: [{ type: 'text', text: 'small' }] }
  const large = { role: 'toolResult', toolCallId: 'large', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(200) }] }

  const result = pruner.pruneMessages([user, short, large])

  assert.equal(result.changed, true)
  assert.equal(result.messages[0], user)
  assert.equal(result.messages[1], short)
  assert.notEqual(result.messages[2], large)
  assert.equal(result.messages[2].content[0].text, `${'x'.repeat(20)}${PRUNE_MARKER}${'x'.repeat(10)}`)
})

async function contextFixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-runtime-parity-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const provider = options.provider ?? fauxProvider()
  const models = createModels()
  models.setProvider(provider.provider)
  const ctx = await OwnedContext.open({ dataDir, models, workspacePath: dataDir, settings: options.settings })
  return { ctx, dataDir, models, provider }
}

test('owned pruning starts only under compaction pressure and preserves the raw tool result', async t => {
  const provider = fauxProvider()
  provider.models[0].contextWindow = 3_000
  provider.models[0].maxTokens = 100
  const { ctx } = await contextFixture(t, {
    provider,
    settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 1, backgroundTokens: 0 } },
  })
  t.after(() => ctx.close())
  const large = `start-${'x'.repeat(15_988)}-end`
  const requests = []
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('large_output', {}, { id: 'call-large' }), { stopReason: 'toolUse' }),
    async context => {
      requests.push(context)
      return fauxAssistantMessage('The retained output was enough.')
    },
  ])
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  agent.ctx.tools.register({
    name: 'large_output',
    description: 'Return a large fixture',
    parameters: {},
    execute: async () => large,
  })
  let summaries = 0
  ctx.get('compaction').summarize = async () => {
    summaries += 1
    return { summary: '# should not run' }
  }
  ctx.resume()
  agent.followup({ content: 'Read the large output', source: { kind: 'user' } })
  await agent.whenIdle()

  assert.equal(summaries, 0)
  const sent = requests[0].messages.find(message => message.role === 'toolResult')
  assert.match(sent.content[0].text, /tool result middle pruned/)
  assert.equal(Array.from(sent.content.filter(block => block.type === 'text').map(block => block.text).join('')).length <= 8_192, true)
  const page = await ctx.sessionController.page({ sessionId, maxMessages: 30 })
  const raw = page.records.find(record => record.event.type === 'tool/result').event.data.message.content[0].text
  assert.equal(raw, large)
})

test('owned plan mode persists, guides the model, and exits only after reviewed approval', async t => {
  const { ctx, dataDir, models, provider } = await contextFixture(t)
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  const planMode = ctx.get('planMode')

  assert.deepEqual(await planMode.get(agent), { active: false, entered: false })
  assert.equal((await ctx.harness.agent(sessionId)).callable.some(tool => tool.name === 'exit_plan_mode'), false)
  assert.equal(await planMode.set(agent, true), 'committed')
  assert.deepEqual(await planMode.get(agent), { active: true, entered: true })
  assert.equal((await ctx.harness.agent(sessionId)).callable.some(tool => tool.name === 'exit_plan_mode'), true)

  await ctx.close()
  const restarted = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  t.after(() => restarted.close())
  const restored = (await restarted.sessionController.resolveAgent(sessionId)).agent
  assert.deepEqual(await restarted.get('planMode').get(restored), { active: true, entered: true })

  const requests = []
  provider.setResponses([
    async context => {
      requests.push(context)
      return fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Verified plan\n\n1. Make the change.' }, { id: 'call-plan' }), { stopReason: 'toolUse' })
    },
    async context => {
      requests.push(context)
      return fauxAssistantMessage('Starting the approved work.')
    },
  ])
  let review
  restarted.on('user-questions/request', async (request, next) => {
    void next
    review = request
    return { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
  })
  restarted.resume()
  restored.followup({ content: 'Plan this change', source: { kind: 'user' } })
  await restored.whenIdle()

  assert.match(JSON.stringify(requests[0]), /You are in plan mode/)
  assert.match(JSON.stringify(requests[0]), /exit_plan_mode/)
  assert.equal(requests[1].messages.findLast(message => message.role === 'system').sections['plan-policy'], null)
  assert.equal(review.questions[0].detail, '# Verified plan\n\n1. Make the change.')
  assert.equal(review.questions[0].intent.kind, 'plan-review')
  assert.deepEqual(await restarted.get('planMode').get(restored), { active: false, entered: true })
  const page = await restarted.sessionController.page({ sessionId, maxMessages: 30 })
  const result = page.records.find(record => record.event.type === 'tool/result').event.data.message
  assert.equal(result.isError, false)
  assert.match(result.content[0].text, /Plan approved/)
})

test('owned plan mode rejects malformed plans and keeps planning after review feedback', async t => {
  const { ctx, provider } = await contextFixture(t)
  t.after(() => ctx.close())
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  await ctx.get('planMode').set(agent, true)
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: 'Missing heading' }, { id: 'call-bad-plan' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Better plan\n\n1. Recheck the design.' }, { id: 'call-rejected-plan' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('I will revise the plan.'),
  ])
  ctx.on('user-questions/request', async (request, next) => {
    void request
    void next
    return { answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'Cover rollback.' }] }
  })
  ctx.resume()
  agent.followup({ content: 'Prepare the plan', source: { kind: 'user' } })
  await agent.whenIdle()

  assert.deepEqual(await ctx.get('planMode').get(agent), { active: true, entered: true })
  const page = await ctx.sessionController.page({ sessionId, maxMessages: 40 })
  const errors = page.records.filter(record => record.event.type === 'tool/result').map(record => record.event.data.message)
  assert.equal(errors.length, 2)
  assert.equal(errors.every(result => result.isError), true)
  assert.match(errors[0].content[0].text, /starting with a # heading/)
  assert.match(errors[1].content[0].text, /Cover rollback/)
})

test('owned plan mode fails closed without a review channel', async t => {
  const { ctx, provider } = await contextFixture(t)
  t.after(() => ctx.close())
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  await ctx.get('planMode').set(agent, true)
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Ready plan\n\n1. Implement it.' }, { id: 'call-no-review' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Plan mode remains active.'),
  ])
  ctx.resume()
  agent.followup({ content: 'Prepare the plan', source: { kind: 'user' } })
  await agent.whenIdle()

  assert.deepEqual(await ctx.get('planMode').get(agent), { active: true, entered: true })
  const page = await ctx.sessionController.page({ sessionId, maxMessages: 30 })
  const result = page.records.find(record => record.event.type === 'tool/result').event.data.message
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /no user-questions channel is available/)
})
