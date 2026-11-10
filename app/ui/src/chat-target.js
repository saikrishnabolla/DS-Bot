export const chatRequest = (botId, roomId, cursor) => ({
  ...(botId === undefined ? { roomId } : { botId }),
  ...(cursor ? { cursor } : {}),
})

export const feedMatches = (botId, roomId, data) => (botId === undefined
  ? data?.roomId === roomId
  : data?.botId === botId && data?.roomId === undefined)

export const stopRequest = (botId, roomId) => (botId === undefined
  ? { endpoint: 'stop-room-work', payload: { roomId } }
  : { endpoint: 'stop-bot-work', payload: { botId } })

export const approvalsForConversation = (work, botId, roomId) => (roomId === undefined
  ? (work?.approvals ?? []).filter(entry => entry.botId === botId && entry.roomId === undefined)
  : (work?.approvals ?? []).filter(entry => entry.roomId === roomId))
