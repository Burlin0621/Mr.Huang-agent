/**
 * 配图上传：用户把外部生图工具产出的图片上传回应用（应用内不生图）。
 * - ≤ 500KB 且 mime 在 markdown-it 放行白名单内：直接 FileReader 读 dataURL；
 * - 超限（或 mime 不在白名单）：canvas 等比压缩转 JPEG（最长边 ≤ 1600px、质量 0.85），
 *   绘制失败回退原始 dataURL；
 * - 产物 dataURL 只用于应用内预览与导出 HTML 渲染，不参与 prompt 复制与主持久化 key
 *   （持久化策略见 wechat-writing store 的独立 key 说明）。
 */

/** 免压缩直存的体积上限：超过则走 canvas 压缩，避免 dataURL 体积失控 */
export const IMAGE_MAX_RAW_BYTES = 500 * 1024

/** 压缩后最长边上限（超出等比缩小，不足不放大） */
const IMAGE_MAX_EDGE = 1600

/** JPEG 压缩质量 */
const IMAGE_JPEG_QUALITY = 0.85

/**
 * 直存 mime 白名单 = markdown-it GOOD_DATA_RE 的放行集合（data:image/(gif|png|jpeg|webp);）。
 * 其余格式（如 svg/bmp）markdown-it 校验不通过会把 src 置空渲染为死图，必须过 canvas 转 JPEG。
 */
const SAFE_IMAGE_MIMES = new Set(['image/gif', 'image/png', 'image/jpeg', 'image/webp'])

/** FileReader 读文件 dataURL 的 Promise 封装 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 图片解码（Image onload/onerror 的 Promise 封装），解码失败抛错由上层回退 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = src
  })
}

/**
 * canvas 等比压缩为 JPEG dataURL：最长边 ≤ 1600px、质量 0.85。
 * 任一步骤失败（解码/画布/导出）返回 null，由上层回退原始 dataURL。
 */
async function compressToJpeg(dataUrl: string): Promise<string | null> {
  try {
    const image = await loadImage(dataUrl)
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) return null
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const compressed = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY)
    return compressed.startsWith('data:image/jpeg') ? compressed : null
  } catch {
    return null
  }
}

/**
 * 上传成图主入口：读文件 → 按需压缩 → 返回 dataURL。
 * 小图且 mime 在白名单内直存；否则压缩转 JPEG，压缩失败回退原始 dataURL。
 */
export async function prepareImageUpload(file: File): Promise<string> {
  const raw = await readAsDataUrl(file)
  if (file.size <= IMAGE_MAX_RAW_BYTES && SAFE_IMAGE_MIMES.has(file.type)) return raw
  return (await compressToJpeg(raw)) ?? raw
}
