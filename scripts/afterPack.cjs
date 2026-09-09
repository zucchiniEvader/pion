// 未签名构建(无证书)是 ad-hoc 签名,cdhash 每次构建都变,
// macOS TCC 授权(本地网络等)绑定代码身份 → 每次重打包授权作废,
// 客户端连 daemon 报 EHOSTUNREACH。
// 这里把 designated requirement 钉在 bundle id 上,授权跨构建保留。
// 有正式签名凭据时直接跳过:electron-builder 会在本 hook 之后用证书签,
// 不需要 ad-hoc 这一步。
const { execSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // 任意一条出现即表示本轮构建会走正式签名/公证
  const signing = process.env.CSC_LINK || process.env.CSC_NAME || process.env.APPLE_ID || process.env.APPLE_API_KEY
  if (signing) return
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  execSync(
    `codesign --force --sign - --requirements '=designated => identifier "com.pion.app"' ${JSON.stringify(app)}`,
    { stdio: 'inherit' },
  )
}
