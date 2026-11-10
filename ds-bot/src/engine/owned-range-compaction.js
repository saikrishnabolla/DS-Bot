import { CompactionTask, defineExtension, defineTask, hook } from '@earendil-works/pi-durable'

export const RANGE_COMPACTION_KIND = 'ds-bot.range-compaction'

const completed = result => ({ status: 'terminal', outcome: { status: 'completed', result } })
const failed = message => ({ status: 'terminal', outcome: { status: 'failed', error: { message } } })

export const OwnedRangeCompactionTask = defineTask({
  name: RANGE_COMPACTION_KIND,
  version: 1,
  initial: () => ({ phase: 'summarize' }),
  phases: {
    summarize: async (task, runtime, context) => {
      let decision = await runtime.memo('decision', context)
      if (decision === undefined) {
        await runtime.hooks.each('summarizeRange', async summarize => {
          if (decision !== undefined) return
          decision = await summarize(task.input, runtime, context)
        })
        decision = await runtime.memo('decision', decision ?? { kind: 'failed', message: 'Range compaction produced no summary' }, context)
      }
      if (decision.kind !== 'summary') {
        await runtime.commit(() => failed(decision.message ?? 'Range compaction produced no summary'), context)
        return
      }

      const target = await runtime.conversation(runtime.conversationId, context)
      if (target === undefined) {
        await runtime.commit(() => failed(`Conversation ${runtime.conversationId} does not exist`), context)
        return
      }
      await runtime.commit(async tx => {
        const latest = await tx.latestEntryId(runtime.conversationId)
        if (latest !== task.input.tailEntryId) return failed('compactRegion: session surface changed during summarization')
        await target.submit(tx, {
          type: 'write',
          requestId: `range-compaction:${runtime.taskId}`,
          entry: {
            kind: RANGE_COMPACTION_KIND,
            edits: task.input.shadowedEntryIds.map((entryId, index) => index === 0
              ? {
                  target: entryId,
                  action: 'replace',
                  messages: [{
                    role: 'user',
                    content: [{ type: 'text', text: decision.summary }],
                    timestamp: runtime.now(),
                  }],
                }
              : { target: entryId, action: 'omit' }),
            data: {
              reason: 'model-switch',
              startSeq: task.input.startSeq,
              endSeq: task.input.endSeq,
              shadowedSeqs: task.input.shadowedSeqs,
              shadowedEntryIds: task.input.shadowedEntryIds,
            },
          },
        })
        return completed({
          start: task.input.startSeq,
          end: task.input.endSeq,
          shadowedSeqs: task.input.shadowedSeqs,
          summary: decision.summary,
        })
      }, context)
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({
    status: 'terminal',
    outcome: { status: 'aborted' },
  }), context),
})

export function createOwnedCompactionExtension({ beforeCompact, summarizeRange }) {
  return defineExtension({
    name: 'ds-bot-owned-compaction',
    tasks: [OwnedRangeCompactionTask],
    hooks: [
      hook(CompactionTask, { beforeCompact }),
      hook(OwnedRangeCompactionTask, { summarizeRange }),
    ],
  })
}
