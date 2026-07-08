// 统一的音频播放器
// 中文优先使用有道词典TTS（长文本自动分段），英文短词用有道、长句用Web Speech API

let audioContext: AudioContext | null = null
let audioElement: HTMLAudioElement | null = null
let isUnlocked = false
let isPlaying = false

// 音频缓存
const audioCache = new Map<string, string>()
const MAX_CACHE_SIZE = 100

// 请求限流
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL = 300

// 请求队列 — 支持多个片段顺序播放
let pendingQueue: Array<{ text: string; lang: 'zh' | 'en' }> = []

// 有道TTS每段的最大文本长度（超过此长度会自动分段）
const MAX_YOUDAO_TEXT_LENGTH = 80

// 获取或创建 AudioContext
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    } catch (e) {
      return null
    }
  }
  
  if (audioContext.state === 'suspended') {
    audioContext.resume()
  }
  
  return audioContext
}

// 获取或创建音频元素
function getAudioElement(): HTMLAudioElement {
  if (!audioElement) {
    audioElement = new Audio()
    audioElement.preload = 'auto'
    audioElement.addEventListener('ended', () => {
      isPlaying = false
      // 从队列取出下一个片段播放
      const next = pendingQueue.shift()
      if (next) {
        if (next.lang === 'zh') {
          speakChineseInternal(next.text)
        } else {
          speakEnglishInternal(next.text)
        }
      }
    })
    audioElement.addEventListener('error', () => {
      isPlaying = false
      // 跳过当前失败的片段，继续播放下一个
      const next = pendingQueue.shift()
      if (next) {
        if (next.lang === 'zh') {
          speakChineseInternal(next.text)
        } else {
          speakEnglishInternal(next.text)
        }
      }
    })
  }
  return audioElement
}

// 解锁移动端音频
export function unlockAudio(): void {
  if (isUnlocked) return
  
  const ctx = getAudioContext()
  if (ctx) {
    const buffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
  }
  
  const audio = getAudioElement()
  audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'
  audio.play().then(() => {
    audio.pause()
    audio.currentTime = 0
  }).catch(() => {})
  
  isUnlocked = true
}

// 播放音调
export function playTone(
  frequency: number, 
  duration: number, 
  type: OscillatorType = 'sine', 
  volume: number = 0.3
): void {
  const ctx = getAudioContext()
  if (!ctx) return

  const oscillator = ctx.createOscillator()
  const gainNode = ctx.createGain()

  oscillator.connect(gainNode)
  gainNode.connect(ctx.destination)

  oscillator.frequency.value = frequency
  oscillator.type = type

  gainNode.gain.setValueAtTime(volume, ctx.currentTime)
  gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration)

  oscillator.start(ctx.currentTime)
  oscillator.stop(ctx.currentTime + duration)
}

// 播放正确音效
export function playCorrectSound(): void {
  const notes = [523.25, 659.25, 783.99]
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.15, 'sine', 0.25), i * 100)
  })
}

// 播放错误音效
export function playWrongSound(): void {
  playTone(350, 0.3, 'sine', 0.2)
  setTimeout(() => playTone(280, 0.3, 'sine', 0.15), 150)
}

// 播放完成音效
export function playCompletionSound(): void {
  const notes = [523.25, 587.33, 659.25, 698.46, 783.99, 880]
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.2, 'sine', 0.2), i * 120)
  })
}

// 播放点击音效
export function playClickSound(): void {
  playTone(800, 0.05, 'sine', 0.1)
}

// 检查是否可以发起新请求
function canMakeRequest(): boolean {
  const now = Date.now()
  if (now - lastRequestTime < MIN_REQUEST_INTERVAL) {
    return false
  }
  lastRequestTime = now
  return true
}

// 清理过期缓存
function cleanCache(): void {
  if (audioCache.size > MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(audioCache.keys()).slice(0, 20)
    keysToDelete.forEach(key => audioCache.delete(key))
  }
}

// 判断文本是否适合直接用有道TTS（长度不超过上限即可）
function isSuitableForYoudao(text: string): boolean {
  const cleanText = text.replace(/\s/g, '')
  return cleanText.length <= MAX_YOUDAO_TEXT_LENGTH
}

// 将长中文文本按标点分割为适合有道TTS的短片段
function splitChineseText(text: string): string[] {
  const cleanLen = text.replace(/\s/g, '').length
  if (cleanLen <= MAX_YOUDAO_TEXT_LENGTH) {
    return [text]
  }

  const segments: string[] = []
  // 按中文标点分割，保留标点在每个片段末尾
  const parts = text.split(/(?<=[，。！？、；：])/)
  let current = ''

  for (const part of parts) {
    if ((current + part).replace(/\s/g, '').length <= MAX_YOUDAO_TEXT_LENGTH) {
      current += part
    } else {
      if (current.trim()) segments.push(current.trim())
      current = part
    }
  }
  if (current.trim()) segments.push(current.trim())

  return segments.length > 0 ? segments : [text]
}

// 生成有道TTS URL
function getYoudaoChineseUrl(text: string): string {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&le=zh`
}

function getYoudaoEnglishUrl(text: string): string {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=1`
}

// 从URL播放音频（使用 addEventListener 不干扰队列处理器）
function playFromUrl(url: string, originalText: string, lang: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = getAudioElement()
    let resolved = false

    const onEnded = () => {
      if (resolved) return
      resolved = true
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('canplaythrough', onCanPlay)
      resolve()
    }

    const onError = () => {
      if (resolved) return
      resolved = true
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('canplaythrough', onCanPlay)
      // 仅当没有后续片段在播放时才降级为Web Speech
      if (!isPlaying) {
        speakWithWebSpeech(originalText, lang === 'zh' ? 'zh-CN' : 'en-US')
      }
      resolve()
    }

    const onCanPlay = () => {
      audio.play().catch(() => {
        if (!resolved) {
          resolved = true
          audio.removeEventListener('ended', onEnded)
          audio.removeEventListener('error', onError)
          audio.removeEventListener('canplaythrough', onCanPlay)
          if (!isPlaying) {
            speakWithWebSpeech(originalText, lang === 'zh' ? 'zh-CN' : 'en-US')
          }
          resolve()
        }
      })
    }

    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.addEventListener('canplaythrough', onCanPlay)

    audio.src = url
    audio.load()

    // 超时处理
    setTimeout(() => {
      if (!resolved) {
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
        audio.removeEventListener('canplaythrough', onCanPlay)
        resolve()
      }
    }, 5000)
  })
}

// 内部播放中文（调用者已确保文本适合有道TTS）
function speakChineseInternal(text: string): void {
  if (!text) return

  // 安全检查：如果文本仍然过长（不应发生，speakChinese已分段），降级为Web Speech
  if (!isSuitableForYoudao(text)) {
    speakWithWebSpeech(text, 'zh-CN')
    return
  }
  
  isPlaying = true
  const url = getYoudaoChineseUrl(text)
  
  const cacheKey = `zh:${text}`
  if (!audioCache.has(cacheKey)) {
    cleanCache()
    audioCache.set(cacheKey, url)
  }
  
  playFromUrl(url, text, 'zh')
}

// 内部播放英文
function speakEnglishInternal(text: string): void {
  if (!text) return
  
  // 长句子使用Web Speech API
  if (text.length > 30) {
    speakWithWebSpeech(text, 'en-US')
    return
  }
  
  isPlaying = true
  const url = getYoudaoEnglishUrl(text)
  
  const cacheKey = `en:${text}`
  if (!audioCache.has(cacheKey)) {
    cleanCache()
    audioCache.set(cacheKey, url)
  }
  
  playFromUrl(url, text, 'en')
}

// 播放中文（公开接口）
export function speakChinese(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!text) {
      resolve()
      return
    }

    // 长文本按标点分段，每段适合有道TTS处理
    const segments = splitChineseText(text)

    // 如果正在播放，所有片段（含第一段）都入队
    if (isPlaying) {
      for (const seg of segments) {
        pendingQueue.push({ text: seg, lang: 'zh' })
      }
      resolve()
      return
    }

    // 限流检查（只对有道API限流，长文本仍可降级为Web Speech）
    if (!canMakeRequest()) {
      speakWithWebSpeech(text, 'zh-CN')
      resolve()
      return
    }

    // 取第一段立即播放，其余入队
    const [first, ...rest] = segments
    for (const seg of rest) {
      pendingQueue.push({ text: seg, lang: 'zh' })
    }

    speakChineseInternal(first)
    resolve()
  })
}

// 播放英文（公开接口）
export function speakEnglish(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!text) {
      resolve()
      return
    }

    if (isPlaying) {
      pendingQueue.push({ text, lang: 'en' })
      resolve()
      return
    }

    // 长句子直接用Web Speech API
    if (text.length > 30) {
      speakWithWebSpeech(text, 'en-US')
      resolve()
      return
    }

    if (!canMakeRequest()) {
      speakWithWebSpeech(text, 'en-US')
      resolve()
      return
    }

    speakEnglishInternal(text)
    resolve()
  })
}

// Web Speech API（用于长句子和备选）
function speakWithWebSpeech(text: string, lang: string): void {
  if (typeof window === 'undefined' || !window.speechSynthesis || !text) return
  
  try {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = lang
    utterance.rate = 0.85
    utterance.pitch = 1.0
    utterance.volume = 1.0
    
    // 尝试选择合适的语音
    const voices = window.speechSynthesis.getVoices()
    if (voices.length > 0) {
      const langPrefix = lang.split('-')[0]
      const voice = voices.find(v => v.lang.startsWith(langPrefix))
      if (voice) {
        utterance.voice = voice
      }
    }
    
    window.speechSynthesis.speak(utterance)
  } catch {
    // 静默失败
  }
}

// 停止所有音频
export function stopAudio(): void {
  pendingQueue = []
  
  if (audioElement) {
    audioElement.pause()
    audioElement.currentTime = 0
  }
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
  isPlaying = false
}

// 初始化音频系统
export function initAudio(): void {
  unlockAudio()
  
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.getVoices()
    // 监听语音加载完成
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices()
    }
  }
}
