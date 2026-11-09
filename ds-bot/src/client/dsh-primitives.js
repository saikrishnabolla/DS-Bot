import { createElement as h } from 'react'

const icon = path => ({ size = 16, className }) => h('svg', {
  className,
  width: size,
  height: size,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}, h('path', { d: path }))

export const FishLogo = () => null
export const IconAgentPresetOutlineMedium = icon('M4 15v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1M10 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6')
export const IconArchiveOutlineMedium = icon('M3 6h14M5 6v10h10V6M8 10h4M4 3h12v3H4z')
export const IconPersonalizationOutlineMedium = icon('M4 5h12M7 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0ZM4 15h12M17 15a2 2 0 1 0-4 0 2 2 0 0 0 4 0ZM4 10h12M12 10a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z')
export const IconSettingsOutlineMedium = icon('M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0-4v2m0 10v2M3 10h2m10 0h2M5 5l1.5 1.5m7 7L15 15M15 5l-1.5 1.5m-7 7L5 15')
export const IconUserOutlineMedium = icon('M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 6a6 6 0 0 1 12 0')
export const IconDownloadOutlineRegular = icon('M10 3v9m-3-3 3 3 3-3M4 16h12')
export const IconLoadingOutlineRegular = icon('M10 3a7 7 0 1 1-6.1 3.6')

export const writeClipboard = text => (navigator.clipboard === undefined
  ? Promise.resolve(document.execCommand('copy', false, text))
  : navigator.clipboard.writeText(text).then(() => true, () => false))

export const projectUserText = text => text
export const fileExtension = name => String(name ?? '').split('.').at(-1) ?? ''
export const fileSizeText = bytes => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function MarkdownText({ text, variant }) {
  return h('div', { className: variant === 'compact' ? 'md_markdown md-compact' : 'md_markdown' }, text ?? '')
}

export function FileTypeIcon({ className }) {
  return h('svg', { className, viewBox: '0 0 32 32', fill: 'none', stroke: 'currentColor', 'aria-hidden': true },
    h('path', { d: 'M8 3h10l6 6v20H8z' }), h('path', { d: 'M18 3v7h6' }))
}

export function JsonBlock({ label, payload }) {
  return h('details', { className: 'bt-json' }, h('summary', null, label), h('pre', null, JSON.stringify(payload, null, 2)))
}

export function Button({ variant, className = '', ...props }) {
  return h('button', { type: 'button', ...props, className: `bt-button bt-button-${variant ?? 'plain'} ${className}`.trim() })
}

export function Tooltip({ label, disabled, children }) {
  return disabled ? children : h('span', { title: typeof label === 'string' ? label : undefined }, children)
}

export function ConnectionIndicator({ state, disconnectedLabel, connectingLabel, recoveredLabel, onReconnect }) {
  if (state === undefined) return null
  const label = state === 'disconnected' ? disconnectedLabel : state === 'connecting' ? connectingLabel : recoveredLabel
  return h('button', { type: 'button', className: 'bt-connection', onClick: onReconnect, title: label, 'aria-label': label }, h('span', { 'data-state': state }))
}

export function Modal({ open, title, description, footer, children, className = '', onClose, closeLabel }) {
  if (!open) return null
  return h('div', { className: 'bt-modal-backdrop', role: 'presentation', onMouseDown: event => { if (event.target === event.currentTarget) onClose?.() } },
    h('section', { className: `bt-modal ${className}`.trim(), role: 'dialog', 'aria-modal': true, 'aria-label': title },
      h('header', null, h('h2', null, title), onClose ? h('button', { type: 'button', onClick: onClose, 'aria-label': closeLabel }, '×') : null),
      description ? h('p', null, description) : null,
      children,
      footer ? h('footer', null, footer) : null))
}
