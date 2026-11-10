// A page that opens once a request answers with its address. In a browser the window
// is reserved inside the click gesture and addressed later: opening after the awaits
// would hit the popup blocker. `close()` drops a reserved window nothing needed.
export function reserveWindow() {
  const reserved = window.open('', '_blank')
  if (reserved !== null) reserved.opener = null
  return {
    go: (url) => {
      if (reserved === null) return false
      reserved.location.href = url
      return true
    },
    close: () => { reserved?.close() },
  }
}

// Opens an address now, inside the current click.
export const openPage = url => reserveWindow().go(url)
