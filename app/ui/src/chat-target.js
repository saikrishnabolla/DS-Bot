export const chatRequest = (botId, roomId, cursor, agentSessionId) => ({
  ...(agentSessionId !== undefined ? { sessionId: agentSessionId }
    : botId === undefined ? { roomId } : { botId }),
  ...(cursor ? { cursor } : {}),
})

export const feedMatches = (botId, roomId, data, agentSessionId) => (agentSessionId !== undefined
  ? data?.sessionId === agentSessionId && data?.roomId === undefined
  : botId === undefined ? data?.roomId === roomId
    : data?.botId === botId && data?.roomId === undefined)

export const stopRequest = (botId, roomId, agentSessionId) => (agentSessionId !== undefined
  ? { endpoint: 'stop-agent-work', payload: { sessionId: agentSessionId } }
  : botId === undefined ? { endpoint: 'stop-room-work', payload: { roomId } }
    : { endpoint: 'stop-bot-work', payload: { botId } })

export const approvalsForConversation = (work, botId, roomId, agentSessionId) => (agentSessionId !== undefined
  ? (work?.approvals ?? []).filter(entry => entry.sessionId === agentSessionId)
  : roomId === undefined
    ? (work?.approvals ?? []).filter(entry => entry.botId === botId && entry.roomId === undefined)
    : (work?.approvals ?? []).filter(entry => entry.roomId === roomId))
