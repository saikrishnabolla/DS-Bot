export const PLAN_MODE_GUIDANCE = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

const REVIEW_ID = 'plan-review'
const APPROVE = 'Approve'
const KEEP_PLANNING = 'Keep planning'

const renderedResult = approved => ({
  output: [{
    type: 'text',
    text: approved
      ? 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
      : 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
  }],
  structuredOutput: { approved },
})

export function exitPlanModeDefinition({ getState, queueExit, ask }) {
  return {
    name: 'exit_plan_mode',
    description: 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again.',
    parameters: {
      plan: { type: 'string', required: true, description: 'The complete plan, as markdown, starting with a # heading that names it.' },
    },
    structuredOutputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined || !(await getState(agent)).active) throw new Error('exit_plan_mode is only available in plan mode')
      const plan = String(args.plan ?? '').trim()
      if (!/^#\s+\S/.test(plan)) throw new Error('exit_plan_mode requires a non-empty markdown plan starting with a # heading')
      let answer
      try {
        answer = await ask({
          questions: [{
            id: REVIEW_ID,
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: plan,
            options: [
              { label: APPROVE, description: 'Leave plan mode; the plan is carried out from the next step.' },
              { label: KEEP_PLANNING, description: 'Stay in plan mode; feedback goes back to the model.' },
            ],
            intent: { kind: 'plan-review', approve: APPROVE, callId: exec.callId },
          }],
          agent,
          signal: exec.signal,
        })
      } catch (error) {
        if (error?.code !== 'ASK_CANCELLED') throw error
        exec.concludeTurn?.()
        return renderedResult(false)
      }
      const items = (answer?.answers ?? []).filter(item => item?.id === REVIEW_ID)
      const item = items.length === 1 ? items[0] : undefined
      if (item?.selected?.length !== 1 || item.selected[0] !== APPROVE || item.custom !== undefined) {
        const feedback = typeof item?.custom === 'string' ? item.custom.trim() : ''
        throw new Error(feedback === ''
          ? 'The user chose to keep planning; revise the plan and present it again.'
          : `The user chose to keep planning; their feedback: ${feedback}`)
      }
      await queueExit(agent)
      return renderedResult(true)
    },
  }
}
