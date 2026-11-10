import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { OwnedContext } from '../../src/engine/owned-context.js'

const [mode, dataDir, savedSessionId] = process.argv.slice(2)
const models = createModels()
const faux = fauxProvider()
models.setProvider(faux.provider)
const context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
const goals = context.get('goals')
const onGoalChange = report => context.on('session/event', (session, event) => {
  if (event.type === 'goal/change') report(event.data.goal, session)
})

if (mode === 'active') {
  const { sessionId } = await context.sessionController.create()
  await context.sessionController.selectModel({ sessionId, provider: faux.provider.id, model: faux.models[0].id })
  const { agent } = await context.sessionController.resolveAgent(sessionId)
  onGoalChange((goal, session) => process.send?.({ type: 'active', sessionId: session.id, goal }))
  goals.start(agent, { objective: 'survive forced termination' })
  await new Promise(() => {})
} else {
  const { agent } = await context.sessionController.resolveAgent(savedSessionId)
  const before = goals.get(agent)
  if (mode === 'blocked') {
    onGoalChange(after => process.send?.({ type: 'blocked', before, after }))
    goals.block(agent, before, { code: 'waiting', message: 'resume later' })
    await new Promise(() => {})
  } else if (mode === 'complete') {
    onGoalChange(after => process.send?.({ type: 'complete', before, after }))
    goals.complete(agent, before)
    await new Promise(() => {})
  } else if (mode === 'verify') {
    process.send?.({ type: 'verified', goal: before })
    await context.close()
    process.exit(0)
  } else {
    throw new Error(`Unknown owned goal crash mode: ${mode}`)
  }
}
