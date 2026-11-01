// 纯 JS 的 MD5：只用来给附件算指纹去重，不引外部依赖
// 输入 Uint8Array，输出 32 位小写十六进制

const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]

// K 表按标准做法从 sin 取，省得抄 64 个常量
const table = (() => {
  const out = new Int32Array(64)
  for (let i = 0; i < 64; i += 1) out[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
  return out
})()

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n))
}

function hexle(n) {
  let out = ''
  for (let i = 0; i < 4; i += 1) out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
  return out
}

export function md5bytes(input) {
  const len = input.length
  const blocks = ((len + 8) >> 6) + 1
  const words = new Int32Array(blocks * 16)

  for (let i = 0; i < len; i += 1) words[i >> 2] |= input[i] << ((i % 4) * 8)
  // 补一个 0x80，再补零到 56 字节处
  words[len >> 2] |= 0x80 << ((len % 4) * 8)
  // 末尾八字节是原始比特长度，小端写，低 32 位在前
  words[blocks * 16 - 2] = len * 8
  words[blocks * 16 - 1] = Math.floor(len / 536870912)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let k = 0; k < blocks; k += 1) {
    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i += 1) {
      let f
      let g
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }

      const s = shifts[(i >> 4) * 4 + (i % 4)]
      const sum = (a + f + table[i] + words[k * 16 + g]) | 0
      const next = (b + rotl(sum, s)) | 0
      a = d
      d = c
      c = b
      b = next
    }

    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  return hexle(a0) + hexle(b0) + hexle(c0) + hexle(d0)
}
