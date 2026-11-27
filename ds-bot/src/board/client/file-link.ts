export const FILE_LINK_ORIGIN = 'https://files.local/'

const PIECE = /(```[\s\S]*?(?:```|$))|(?<!!)(\[(?:[^\]\n`]|`[^`\n]*`)*\]\()(<[^<>\n]*>|[^\s()<>]+)((?:\s+"[^"\n]*")?\))|(`[^`\n]*`)/g
const PATH_CODE = /^`((?:\/(?!\/)|file:\/\/\/)[^`\s]*\.[A-Za-z0-9]{1,10}(?:#L\d+(?:-L\d+)?)?)`$/
const isFileTarget = target => /^\/(?!\/)/.test(target) || /^file:\/\/\//i.test(target)
const fileHref = target => `<${FILE_LINK_ORIGIN}${encodeURIComponent(target)}>`

// DSH's markdown drops links to local paths, so they go under an origin the board opens itself.
export function linkFiles(text) {
  if (!text.includes('/')) return text
  return text.replace(PIECE, (whole, fence, open, destination, close, code) => {
    if (fence !== undefined) return whole
    if (code !== undefined) {
      const target = PATH_CODE.exec(code)?.[1]
      return target === undefined ? whole : `[${code}](${fileHref(target)})`
    }
    const target = destination.startsWith('<') ? destination.slice(1, -1) : destination
    return isFileTarget(target) ? `${open}${fileHref(target)}${close}` : whole
  })
}

export const fileLinkTarget = href => {
  try { return decodeURIComponent(href.slice(FILE_LINK_ORIGIN.length)) } catch { return undefined }
}

export const fileName = target => target.replace(/#L\d+(?:-L\d+)?$/, '').split(/[\\/]/).pop() || target
