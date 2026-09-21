// 轻量消息提示 —— 兼容 Element Plus `ElMessage` 的调用签名
//
// 主项目中这里由 Element Plus 提供；Demo 不引入该依赖（体积 + 全量样式），
// 只实现测量模块实际用到的那部分 API：success / warning / error / info。

type MessageType = 'success' | 'warning' | 'error' | 'info'

export interface MessageOptions {
  message: string
  duration?: number
  type?: MessageType
}

const COLOR: Record<MessageType, string> = {
  success: '#67c23a',
  warning: '#e6a23c',
  error: '#f56c6c',
  info: '#909399',
}

function resolve(options: string | MessageOptions): { text: string; duration: number } {
  if (typeof options === 'string') return { text: options, duration: 3000 }
  return { text: options.message, duration: options.duration ?? 3000 }
}

function show(type: MessageType, options: string | MessageOptions): void {
  if (typeof document === 'undefined') return
  const { text, duration } = resolve(options)

  const el = document.createElement('div')
  el.className = 'demo-message'
  el.style.cssText = [
    'position:fixed',
    'top:24px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9999',
    'max-width:min(560px, 88vw)',
    'padding:10px 16px',
    'border-radius:6px',
    'font-size:13px',
    'line-height:1.5',
    'text-align:center',
    `color:${COLOR[type]}`,
    `border:1px solid ${COLOR[type]}55`,
    'background:#171b22',
    'box-shadow:0 8px 24px rgba(0,0,0,.4)',
    'pointer-events:none',
    'opacity:0',
    'transition:opacity .18s ease, transform .18s ease',
  ].join(';')
  el.textContent = text
  document.body.appendChild(el)

  requestAnimationFrame(() => {
    el.style.opacity = '1'
    el.style.transform = 'translateX(-50%) translateY(6px)'
  })

  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateX(-50%)'
    setTimeout(() => el.remove(), 220)
  }, duration)
}

export const ElMessage = {
  success: (options: string | MessageOptions) => show('success', options),
  warning: (options: string | MessageOptions) => show('warning', options),
  error: (options: string | MessageOptions) => show('error', options),
  info: (options: string | MessageOptions) => show('info', options),
  /** 立即移除所有提示 */
  closeAll: () => {
    document.querySelectorAll('.demo-message').forEach(node => node.remove())
  },
}

export default ElMessage
